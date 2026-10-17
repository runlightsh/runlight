<?php

declare(strict_types=1);

namespace Runlight\Http;

/**
 * An incoming request, shaped like the Fetch API's Request so the routes read
 * the same as the TypeScript SDK's: an absolute URL, a method, headers, and a
 * body read once as text or JSON.
 */
final class Request
{
    public readonly string $method;
    public readonly Headers $headers;

    /** @param array<string, string|list<string>>|Headers $headers */
    public function __construct(
        public readonly string $url,
        string $method = 'GET',
        array|Headers $headers = [],
        private readonly string $body = '',
        /** The address the request came from, before any proxy header is read. */
        public readonly string $remoteAddress = '',
        /**
         * True when the caller has checked the connection really came from a hosting platform's own addresses,
         * such as Cloudflare's, so that platform's location headers (cf-ipcountry) can be believed even where
         * trustProxy is off. Left false, those headers count only when trustProxy allows.
         */
        public readonly bool $platformHeaders = false,
    ) {
        $this->method = strtoupper($method);
        $this->headers = new Headers($headers);
    }

    /**
     * The request PHP is serving now, from its superglobals, which only Globals reads.
     */
    public static function fromGlobals(): self
    {
        return Globals::request();
    }

    /**
     * A request from server variables shaped like $_SERVER, with the body read from `$input`, or else PHP's own
     * input, for a method that has one. The scheme and host come from the server's own variables; the client's
     * address is REMOTE_ADDR, and proxy headers are read later, only when trusted.
     *
     * @param array<array-key, mixed> $server
     * @param resource|null $input
     * @throws BodyTooLarge past the body's limit
     */
    public static function fromServer(array $server, $input = null): self
    {
        $https = ($server['HTTPS'] ?? '') !== '' && strtolower((string) $server['HTTPS']) !== 'off';
        // A proxy that ends TLS says so in the first of x-forwarded-proto, as the Node adapter reads it.
        $forwarded = strtolower(trim(explode(',', (string) ($server['HTTP_X_FORWARDED_PROTO'] ?? ''), 2)[0], " \t"));
        $scheme = ($forwarded !== '' ? $forwarded === 'https' : $https) ? 'https' : 'http';
        $host = (string) ($server['HTTP_HOST'] ?? $server['SERVER_NAME'] ?? 'localhost');
        $uri = (string) ($server['REQUEST_URI'] ?? '/');
        $headers = [];
        foreach ($server as $key => $value) {
            if (str_starts_with((string) $key, 'HTTP_')) {
                $headers[str_replace('_', '-', strtolower(substr((string) $key, 5)))] = (string) $value;
            }
        }
        // Apache under CGI or FPM passes Authorization only when a rewrite rule copies it, under this name.
        if (!isset($headers['authorization']) && isset($server['REDIRECT_HTTP_AUTHORIZATION'])) {
            $headers['authorization'] = (string) $server['REDIRECT_HTTP_AUTHORIZATION'];
        }
        if (isset($server['CONTENT_TYPE'])) {
            $headers['content-type'] = (string) $server['CONTENT_TYPE'];
        }
        if (isset($server['CONTENT_LENGTH'])) {
            $headers['content-length'] = (string) $server['CONTENT_LENGTH'];
        }
        $method = (string) ($server['REQUEST_METHOD'] ?? 'GET');
        $body = '';
        if (!in_array(strtoupper($method), ['GET', 'HEAD'], true)) {
            $stream = $input ?? fopen('php://input', 'rb');
            $body = $stream === false ? '' : self::readBody($stream, $uri, $headers['content-length'] ?? null);
        }
        return new self("$scheme://$host$uri", $method, $headers, $body, (string) ($server['REMOTE_ADDR'] ?? ''));
    }

    /**
     * A request body read from a stream, up to the limit for its path, as the Node adapter reads one: 16 KB for
     * the collect endpoint, whose payloads are under 8 KB, and 10 MB for the rest, such as a link import of 5,000
     * rows. One byte past the limit is all that is read, so a larger body never fills memory.
     *
     * @param resource $stream
     * @throws BodyTooLarge past the limit, for a 413
     */
    public static function readBody($stream, string $target, ?string $declared = null): string
    {
        // The path is what comes before the query, as the Node adapter reads it.
        $limit = preg_match('#/e$#D', explode('?', $target, 2)[0]) ? 16 * 1024 : 10 * 1024 * 1024;
        if ($declared !== null && is_numeric(trim($declared)) && (float) trim($declared) > $limit) {
            throw new BodyTooLarge("Request body over $limit bytes");
        }
        $body = (string) stream_get_contents($stream, $limit + 1);
        if (strlen($body) > $limit) {
            throw new BodyTooLarge("Request body over $limit bytes");
        }
        return $body;
    }

    /** The answer to a body past its limit. The rest of the upload is unread, so the connection is not reused. */
    public static function tooLarge(): Response
    {
        return new Response('{"error":"That request is too large"}', 413, [
            'content-type' => 'application/json; charset=utf-8',
            'cache-control' => 'no-store',
            'connection' => 'close',
        ]);
    }

    public function text(): string
    {
        return $this->body;
    }

    /** The body as JSON. Throws \JsonException when it is not. */
    public function json(): mixed
    {
        return json_decode($this->body, false, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
    }

    public function url(): Url
    {
        return new Url($this->url);
    }

    /** The same request with other parts, as `new Request(request, init)` makes one. */
    public function with(?string $url = null, ?string $method = null, ?Headers $headers = null, ?string $body = null, ?bool $platformHeaders = null): self
    {
        return new self($url ?? $this->url, $method ?? $this->method, $headers ?? $this->headers, $body ?? $this->body, $this->remoteAddress, $platformHeaders ?? $this->platformHeaders);
    }
}
