<?php

declare(strict_types=1);

namespace Runlight\Http;

use Runlight\Safefetch;

/**
 * Fetches with PHP's curl extension, or with its stream wrapper when curl is missing.
 *
 * A request with `resolve` pins is only ever made to a pinned address: through no proxy, and with every redirect
 * followed here, so each one is checked against the pins in turn. A pin that cannot be applied (no pin for the
 * URL's host and port, or a curl without CURLOPT_RESOLVE) refuses the request with a FetchError rather than
 * letting it look the name up again.
 */
final class CurlFetcher implements Fetcher
{
    /** Redirects followed for one request, as curl's own limit was. */
    private const MAX_REDIRECTS = 20;

    public function fetch(string $url, array $init = []): Response
    {
        if (empty($init['resolve'])) {
            return function_exists('curl_init') ? $this->viaCurl($url, $init) : $this->viaStreams($url, $init);
        }
        // Each redirect is followed by hand, so its address is checked against the pins as the first one was.
        $follow = ($init['redirect'] ?? 'follow') !== 'manual';
        for ($hop = 0; ; $hop++) {
            $answer = function_exists('curl_init') ? $this->viaCurl($url, [...$init, 'redirect' => 'manual']) : $this->viaStreams($url, [...$init, 'redirect' => 'manual']);
            $location = $answer->headers->get('location');
            if (!$follow || $answer->status < 300 || $answer->status >= 400 || $location === null || $location === '') {
                return $answer;
            }
            if ($hop >= self::MAX_REDIRECTS) {
                throw new FetchError('Maximum (' . self::MAX_REDIRECTS . ') redirects followed');
            }
            $url = (new Url($location, $url))->href();
        }
    }

    private function viaCurl(string $url, array $init): Response
    {
        $method = strtoupper((string) ($init['method'] ?? 'GET'));
        $headers = $init['headers'] ?? [];
        $headers = $headers instanceof Headers ? $headers : new Headers($headers);
        $body = isset($init['body']) ? (string) $init['body'] : null;
        $maxBytes = isset($init['maxBytes']) ? (int) $init['maxBytes'] : null;
        $truncate = !empty($init['truncate']);
        $follow = ($init['redirect'] ?? 'follow') !== 'manual';
        $pin = null;
        if (!empty($init['resolve'])) {
            // A curl that cannot be told the address would look the name up again itself.
            if (!defined('CURLOPT_RESOLVE')) {
                throw new FetchError('Runlight: this curl cannot pin a checked address, so nothing is fetched');
            }
            $addresses = Safefetch::pinned($url, array_values($init['resolve']));
            $parsed = new Url($url);
            $port = $parsed->port !== '' ? $parsed->port : ($parsed->protocol === 'https:' ? '443' : '80');
            $pin = "{$parsed->hostname}:$port:" . implode(',', array_map(static fn (string $a): string => str_contains($a, ':') ? "[$a]" : $a, $addresses));
        }

        $lines = [];
        foreach ($headers->all() as $name => $values) {
            foreach ($values as $value) {
                $lines[] = "$name: $value";
            }
        }
        $received = '';
        $tooLong = false;
        $responseHeaders = [];
        $status = 0;
        $handle = curl_init($url);
        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_FOLLOWLOCATION => $follow,
            CURLOPT_MAXREDIRS => 20,
            CURLOPT_TIMEOUT_MS => (int) ($init['timeoutMs'] ?? 30_000),
            CURLOPT_CONNECTTIMEOUT_MS => min((int) ($init['timeoutMs'] ?? 30_000), 15_000),
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_ENCODING => '',
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$responseHeaders, &$status): int {
                if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
                    // A new status line starts the next answer in a redirect chain.
                    $status = (int) $m[1];
                    $responseHeaders = [];
                } elseif (str_contains($line, ':')) {
                    [$name, $value] = explode(':', $line, 2);
                    $responseHeaders[strtolower(trim($name))][] = trim($value);
                }
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$received, &$tooLong, $maxBytes, $truncate): int {
                if ($maxBytes !== null && strlen($received) + strlen($chunk) > $maxBytes) {
                    $tooLong = true;
                    if ($truncate) {
                        $received .= substr($chunk, 0, $maxBytes - strlen($received));
                    }
                    return 0;
                }
                $received .= $chunk;
                return strlen($chunk);
            },
        ]);
        if ($body !== null && $method !== 'GET' && $method !== 'HEAD') {
            curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
        }
        if ($method === 'HEAD') {
            curl_setopt($handle, CURLOPT_NOBODY, true);
        }
        if ($pin !== null) {
            curl_setopt_array($handle, [
                CURLOPT_RESOLVE => [$pin],
                // A proxy, even one named only in the environment (HTTPS_PROXY), would look the name up itself.
                CURLOPT_PROXY => '',
                CURLOPT_FOLLOWLOCATION => false,
            ]);
        }
        $ok = curl_exec($handle);
        $errno = curl_errno($handle);
        $error = curl_error($handle);
        if ($tooLong && $truncate && $status !== 0) {
            return new Response($received, $status, $responseHeaders);
        }
        if ($tooLong) {
            throw new BodyTooLong("Body over $maxBytes bytes");
        }
        if ($ok === false || $status === 0) {
            throw new FetchError($error !== '' ? $error : 'fetch failed', $errno === CURLE_OPERATION_TIMEDOUT);
        }
        return new Response($received, $status, $responseHeaders);
    }

    private function viaStreams(string $url, array $init): Response
    {
        $headers = new Headers($init['headers'] ?? []);
        $ssl = [];
        $pinned = !empty($init['resolve']);
        // A pin connects to the checked address, with the name kept for the Host header and the certificate.
        if ($pinned) {
            $addresses = Safefetch::pinned($url, array_values($init['resolve']));
            $parsed = new Url($url);
            if (!$headers->has('host')) {
                $headers->set('host', $parsed->host());
            }
            $ssl = ['peer_name' => $parsed->hostname, 'SNI_enabled' => true];
            $address = str_contains($addresses[0], ':') ? "[{$addresses[0]}]" : $addresses[0];
            $url = $parsed->protocol . '//' . $address . ($parsed->port !== '' ? ":{$parsed->port}" : '') . $parsed->pathname . $parsed->search;
        }
        $lines = [];
        foreach ($headers->all() as $name => $values) {
            foreach ($values as $value) {
                $lines[] = "$name: $value";
            }
        }
        $context = stream_context_create(['ssl' => $ssl, 'http' => [
            'method' => strtoupper((string) ($init['method'] ?? 'GET')),
            'header' => implode("\r\n", $lines),
            'content' => (string) ($init['body'] ?? ''),
            'timeout' => ((int) ($init['timeoutMs'] ?? 30_000)) / 1000,
            'ignore_errors' => true,
            'follow_location' => !$pinned && ($init['redirect'] ?? 'follow') !== 'manual' ? 1 : 0,
        ]]);
        $maxBytes = isset($init['maxBytes']) ? (int) $init['maxBytes'] : null;
        $stream = @fopen($url, 'rb', false, $context);
        if ($stream === false) {
            throw new FetchError('fetch failed');
        }
        $received = $maxBytes === null ? (string) stream_get_contents($stream) : (string) stream_get_contents($stream, $maxBytes + 1);
        $meta = stream_get_meta_data($stream);
        fclose($stream);
        if ($maxBytes !== null && strlen($received) > $maxBytes && !empty($init['truncate'])) {
            $received = substr($received, 0, $maxBytes);
        } elseif ($maxBytes !== null && strlen($received) > $maxBytes) {
            throw new BodyTooLong("Body over $maxBytes bytes");
        }
        $status = 0;
        $responseHeaders = [];
        foreach ($meta['wrapper_data'] ?? [] as $line) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', (string) $line, $m)) {
                $status = (int) $m[1];
                $responseHeaders = [];
            } elseif (str_contains((string) $line, ':')) {
                [$name, $value] = explode(':', (string) $line, 2);
                $responseHeaders[strtolower(trim($name))][] = trim($value);
            }
        }
        return new Response($received, $status, $responseHeaders);
    }
}
