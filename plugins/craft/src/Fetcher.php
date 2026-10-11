<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use Runlight\Http\BodyTooLong;
use Runlight\Http\Fetcher as RunlightFetcher;
use Runlight\Http\FetchError;
use Runlight\Http\Headers;
use Runlight\Http\Response;

/**
 * Runlight's outgoing requests, made through Craft's Guzzle client, so they
 * follow the proxy and other settings Craft gives it. Runlight sends them for
 * what an owner sets up in its dashboard: email through a mail service,
 * imports, the assistant's AI provider, and a site's icon.
 */
final class Fetcher implements RunlightFetcher
{
    /** @param array<string,mixed> $init the request, with the keys fetch() takes */
    public function fetch(string $url, array $init = []): Response
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
        // A pin connects to the address Runlight checked, with the name kept for the certificate.
        if (!empty($init['resolve']) && defined('CURLOPT_RESOLVE')) {
            $options['curl'] = [CURLOPT_RESOLVE => array_values($init['resolve'])];
        }
        try {
            $answer = Craft::createGuzzleClient()->request($method, $url, $options);
        } catch (\Throwable $e) {
            $message = $e->getMessage() !== '' ? $e->getMessage() : 'fetch failed';
            throw new FetchError($message, (bool) preg_match('/timed out|error 28/i', $message), $e);
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

    /** Saves the file at an address, for DB-IP's location data: whether it arrived whole. */
    public static function download(string $url, string $file): bool
    {
        try {
            $answer = Craft::createGuzzleClient()->request('GET', $url, ['sink' => $file, 'timeout' => 300, 'http_errors' => false]);
            if ($answer->getStatusCode() === 200) {
                return true;
            }
        } catch (\Throwable $e) {
            Craft::warning('Runlight could not download location data: ' . $e->getMessage(), 'runlight');
        }
        if (is_file($file)) {
            @unlink($file);
        }
        return false;
    }
}
