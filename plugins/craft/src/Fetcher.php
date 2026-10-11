<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use GuzzleHttp\TransferStats;
use Runlight\Http\BodyTooLong;
use Runlight\Http\Fetcher as RunlightFetcher;
use Runlight\Http\FetchError;
use Runlight\Http\Headers;
use Runlight\Http\Response;
use Runlight\Http\Url;
use Runlight\Safefetch;

/**
 * Runlight's outgoing requests, made through Craft's Guzzle client, so they
 * follow the proxy and other settings Craft gives it. Runlight sends them for
 * what an owner sets up in its dashboard: email through a mail service,
 * imports, the assistant's AI provider, and a site's icon.
 */
final class Fetcher implements RunlightFetcher
{
    /** Redirects followed for one pinned request, as Guzzle's own limit is. */
    private const MAX_REDIRECTS = 20;

    /** @param array<string,mixed> $init the request, with the keys fetch() takes */
    public function fetch(string $url, array $init = []): Response
    {
        if (empty($init['resolve']) || ($init['redirect'] ?? 'follow') === 'manual') {
            return $this->send($url, $init);
        }
        // A pinned request's redirects are followed here, so each one is checked against the pins as the first
        // address was.
        for ($hop = 0; ; $hop++) {
            $answer = $this->send($url, ['redirect' => 'manual'] + $init);
            $location = $answer->headers->get('location');
            if ($answer->status < 300 || $answer->status >= 400 || $location === null || $location === '') {
                return $answer;
            }
            if ($hop >= self::MAX_REDIRECTS) {
                throw new FetchError('Will not follow more than ' . self::MAX_REDIRECTS . ' redirects');
            }
            $url = (new Url($location, $url))->href();
        }
    }

    /** @param array<string,mixed> $init one request, with no redirect followed when it is pinned */
    private function send(string $url, array $init): Response
    {
        $headers = $init['headers'] ?? [];
        $headers = $headers instanceof Headers ? $headers : new Headers($headers);
        $flat = [];
        foreach ($headers->all() as $name => $values) {
            $flat[$name] = implode(', ', $values);
        }
        $method = strtoupper((string) ($init['method'] ?? 'GET'));
        $options = [
            'headers' => $flat,
            'timeout' => ((int) ($init['timeoutMs'] ?? 30000)) / 1000,
            'allow_redirects' => ($init['redirect'] ?? 'follow') === 'manual' ? false : ['max' => 20],
            'http_errors' => false,
            // Read as it arrives, so an answer past the limit is never held whole.
            'stream' => true,
        ];
        if (isset($init['body']) && !in_array($method, ['GET', 'HEAD'], true)) {
            $options['body'] = (string) $init['body'];
        }
        $client = Craft::createGuzzleClient();
        // A pin connects to the address Runlight checked, with the name kept for the certificate. Only cURL can,
        // and only without a proxy, which would look the name up again, so without either the request is refused,
        // as is an address no pin names.
        $addresses = [];
        $connected = null;
        if (!empty($init['resolve'])) {
            $addresses = Safefetch::pinned($url, array_values($init['resolve']));
            if (!defined('CURLOPT_RESOLVE') || !function_exists('curl_exec')) {
                throw new FetchError('Runlight needs PHP’s curl extension to make this request safely.');
            }
            if (!empty($client->getConfig('proxy'))) {
                throw new FetchError('Runlight cannot make this request safely through a proxy.');
            }
            // No proxy from the environment either, which cURL would read itself.
            $options['curl'] = [CURLOPT_RESOLVE => array_values($init['resolve']), CURLOPT_PROXY => ''];
            // Guzzle sends a streamed request with PHP's streams, which take no pin.
            $options['stream'] = false;
            $options['allow_redirects'] = false;
            // Whatever handler sent it, the answer counts only from a pinned address.
            $options['on_stats'] = static function (TransferStats $stats) use (&$connected): void {
                $connected = $stats->getHandlerStat('primary_ip');
            };
        }
        try {
            $answer = $client->request($method, $url, $options);
        } catch (\Throwable $e) {
            $message = $e->getMessage() !== '' ? $e->getMessage() : 'fetch failed';
            throw new FetchError($message, (bool) preg_match('/timed out|error 28/i', $message), $e);
        }
        if ($addresses !== [] && !self::among($connected, $addresses)) {
            throw new FetchError('Runlight did not reach the address it checked, so the answer is not used.');
        }
        $max = isset($init['maxBytes']) ? (int) $init['maxBytes'] : null;
        $stream = $answer->getBody();
        $body = '';
        try {
            // One byte past the limit is enough to know the answer is too long.
            while (!$stream->eof() && ($max === null || strlen($body) <= $max)) {
                $body .= $stream->read($max === null ? 65536 : min(65536, $max + 1 - strlen($body)));
            }
        } catch (\Throwable $e) {
            throw new FetchError($e->getMessage() !== '' ? $e->getMessage() : 'fetch failed', (bool) preg_match('/timed out|error 28/i', $e->getMessage()));
        } finally {
            $stream->close();
        }
        if ($max !== null && strlen($body) > $max) {
            if (empty($init['truncate'])) {
                throw new BodyTooLong("Body over $max bytes");
            }
            $body = substr($body, 0, $max);
        }
        $received = [];
        foreach ($answer->getHeaders() as $name => $values) {
            $received[strtolower((string) $name)] = array_map('strval', $values);
        }
        return new Response($body, $answer->getStatusCode(), $received);
    }

    /**
     * Whether the address cURL reports connecting to is one of the pinned ones.
     *
     * @param list<string> $addresses
     */
    private static function among(mixed $connected, array $addresses): bool
    {
        $packed = is_string($connected) && $connected !== '' ? @inet_pton(trim($connected, '[]')) : false;
        foreach ($addresses as $address) {
            if ($packed !== false && $packed === @inet_pton($address)) {
                return true;
            }
        }
        return false;
    }

    /** Saves the file at an address, for DB-IP's location data: whether it arrived whole. */
    public static function download(string $url, string $file): bool
    {
        try {
            $answer = Craft::createGuzzleClient()->request('GET', $url, ['sink' => $file, 'timeout' => 300, 'http_errors' => false]);
            if ($answer->getStatusCode() === 200) {
                return true;
            }
            Craft::warning('Runlight could not download location data: it answered ' . $answer->getStatusCode(), 'runlight');
        } catch (\Throwable $e) {
            Craft::warning('Runlight could not download location data: ' . $e->getMessage(), 'runlight');
        }
        if (is_file($file)) {
            @unlink($file);
        }
        return false;
    }
}
