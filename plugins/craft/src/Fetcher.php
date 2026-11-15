<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use GuzzleHttp\ClientInterface;
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

    /** @param ClientInterface|null $client Craft's Guzzle client, or a new one for each request */
    public function __construct(private readonly ?ClientInterface $client = null)
    {
    }

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
        $client = $this->client ?? Craft::createGuzzleClient();
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

    /** The most a download for DB-IP's location data may be: 256 MiB, well past the largest file DB-IP sends. */
    private const MAX_DOWNLOAD = 268435456;

    /**
     * Saves the file at an address, for DB-IP's location data, as the package's DbIp asks of a download: only
     * over https, with no redirect followed, since the file is checked as coming from the address it was asked
     * for at, only from an answer of 200, and only up to MAX_DOWNLOAD bytes. A 404 is false, since a month's file
     * is not there until DB-IP publishes it; anything else that goes wrong is thrown, and its message is the
     * reason DbIp logs.
     *
     * @throws \RuntimeException when the file did not arrive whole from that address
     */
    public static function download(string $url, string $file): bool
    {
        $long = 'it is more than ' . intdiv(self::MAX_DOWNLOAD, 1048576) . ' MB';
        try {
            if (strtolower((string) parse_url($url, PHP_URL_SCHEME)) !== 'https') {
                throw new \RuntimeException('it is not an https address');
            }
            $answer = Craft::createGuzzleClient()->request('GET', $url, [
                'sink' => $file,
                'timeout' => 600,
                'http_errors' => false,
                'allow_redirects' => false,
                // Stopped as soon as it says, or shows, that it is too long.
                'on_headers' => static function ($response) use ($long): void {
                    if ((int) $response->getHeaderLine('Content-Length') > self::MAX_DOWNLOAD) {
                        throw new \RuntimeException($long);
                    }
                },
                'progress' => static function ($total, $downloaded) use ($long): void {
                    if ($downloaded > self::MAX_DOWNLOAD) {
                        throw new \RuntimeException($long);
                    }
                },
            ]);
            $status = $answer->getStatusCode();
            if ($status === 200 && (!is_file($file) || filesize($file) <= self::MAX_DOWNLOAD)) {
                return true;
            }
            if ($status !== 404) {
                throw new \RuntimeException($status === 200 ? $long : "it answered $status");
            }
        } catch (\Throwable $e) {
            if (is_file($file)) {
                @unlink($file);
            }
            // Guzzle wraps what on_headers throws; the reason is the one given there.
            $reason = $e->getPrevious() instanceof \RuntimeException && $e->getPrevious()->getMessage() === $long ? $long : $e->getMessage();
            throw new \RuntimeException($reason !== '' ? $reason : 'no answer', 0, $e);
        }
        if (is_file($file)) {
            @unlink($file);
        }
        return false;
    }
}
