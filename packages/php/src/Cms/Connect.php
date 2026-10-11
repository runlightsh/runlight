<?php

declare(strict_types=1);

namespace Runlight\Cms;

use Runlight\Http\Fetcher;
use Runlight\Http\Url;

/**
 * A CMS plugin connecting to a Runlight without copying keys, the half every plugin shares: it reads the
 * Runlight's OAuth metadata, checks its endpoints are on the address entered, registers the plugin as a
 * client, sends the admin to the consent page with PKCE and a state, and on the way back swaps the code for
 * the site's dashboard key, agents key, and id. Nothing here knows the CMS: each plugin passes its own HTTP
 * client as a Fetcher, keeps the pending attempt where it keeps such things (for the admin who started it,
 * for WAIT seconds), and says each outcome in its own words, by code:
 *
 * - `address`: no address was entered
 * - `scheme`: the address is not a web address
 * - `https`: the admin is not on https (nor this computer), so the Runlight cannot send it back
 * - `unreachable` {address, error}: the Runlight could not be reached
 * - `unknown` {address}: no Runlight answered there, or its endpoints are elsewhere
 * - `older`: the Runlight does not offer the `cms` scope yet
 * - `client` {host}: the name the plugin registers under, such as "WordPress at example.com"
 * - `silent`: the reason given when the Runlight refused to register the plugin without saying why
 * - `refused` {reason}: the Runlight would not register the plugin
 * - `expired`: the attempt is gone, used, or not this admin's
 * - `denied`: the admin did not allow it on the consent page
 * - `failed` {reason}: the consent page sent back another error
 * - `lost` {error}: the Runlight could not be reached to swap the code
 * - `keys`: the Runlight answered without the keys
 * - `connected` {site}: done
 */
final class Connect
{
    /** How long an attempt may wait on the consent page, in seconds, before it has to be started again. */
    public const WAIT = 15 * 60;

    /** How long each request to the Runlight may take. */
    private const TIMEOUT_MS = 10_000;

    /** The most an answer while connecting may weigh; a real one is under a kilobyte. */
    private const MAX_BYTES = 64 * 1024;

    /** @var \Closure(string, array<string, string>): string */
    private readonly \Closure $say;

    /**
     * @param Fetcher $fetcher the CMS's own HTTP client
     * @param string $back where the Runlight sends the admin back to, which the plugin registers with it
     * @param callable(string, array<string, string>): string $say the words for each outcome, by code
     */
    public function __construct(
        private readonly Fetcher $fetcher,
        private readonly string $back,
        callable $say,
    ) {
        $this->say = \Closure::fromCallable($say);
    }

    /** Whether a Runlight sends people back to an address: on https, or this computer while trying things out. */
    public static function returnable(string $back): bool
    {
        $url = Url::parse($back);
        return $url !== null && ($url->protocol === 'https:' || in_array($url->hostname, ['localhost', '127.0.0.1', '[::1]'], true));
    }

    /**
     * The scheme, host, and port of a web address, as a browser writes its origin, so https://x:443 and
     * https://x are the same. An empty string for anything else.
     */
    public static function origin(string $address): string
    {
        $url = Url::parse($address);
        return $url !== null && in_array($url->protocol, ['http:', 'https:'], true) ? $url->origin() : '';
    }

    /**
     * Starts connecting, from the Connect button in the plugin's settings.
     *
     * @param string $address the Runlight's address, as requests go to it
     * @param string|null $keep the address to save once connected, when it differs (Craft keeps an environment
     *   variable's name as entered)
     * @return array{0: string|null, 1: array<string, string>|null, 2: string} the consent page's address and the
     *   attempt to keep for this admin until the Runlight sends them back, or nulls and why not
     */
    public function start(string $address, ?string $keep = null): array
    {
        if ($address === '') {
            return [null, null, $this->words('address')];
        }
        if (self::origin($address) === '') {
            return [null, null, $this->words('scheme')];
        }
        if (!self::returnable($this->back)) {
            return [null, null, $this->words('https')];
        }

        [$meta, $error] = $this->json($address . '/.well-known/oauth-authorization-server');
        if ($error !== '') {
            return [null, null, $this->words('unreachable', ['address' => $address, 'error' => $error])];
        }
        $unknown = $this->words('unknown', ['address' => $address]);
        if ($meta === null || !is_string($meta['authorization_endpoint'] ?? null) || !is_string($meta['token_endpoint'] ?? null) || !is_string($meta['registration_endpoint'] ?? null)) {
            return [null, null, $unknown];
        }
        // Its endpoints must be on its own address, so an address cannot send this server's requests elsewhere.
        $origin = self::origin($address);
        foreach (['authorization_endpoint', 'token_endpoint', 'registration_endpoint'] as $endpoint) {
            if (self::origin($meta[$endpoint]) !== $origin) {
                return [null, null, $unknown];
            }
        }
        if (!in_array('cms', (array) ($meta['scopes_supported'] ?? []), true)) {
            return [null, null, $this->words('older')];
        }

        // Named for where the Runlight sends the admin back to, which is the address it checks.
        [$client, $error] = $this->json($meta['registration_endpoint'], [
            'method' => 'POST',
            'headers' => ['content-type' => 'application/json'],
            'body' => (string) json_encode([
                'client_name' => $this->words('client', ['host' => Url::parse($this->back)?->hostname ?? '']),
                'redirect_uris' => [$this->back],
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        ]);
        if ($client === null || !is_string($client['client_id'] ?? null)) {
            $reason = is_string($client['error_description'] ?? null) ? $client['error_description'] : ($error !== '' ? $error : $this->words('silent'));
            return [null, null, $this->words('refused', ['reason' => $reason])];
        }

        $state = bin2hex(random_bytes(16));
        $verifier = self::base64url(random_bytes(48));
        $pending = [
            'state' => $state,
            'verifier' => $verifier,
            'client' => $client['client_id'],
            'token' => $meta['token_endpoint'],
            'address' => $keep ?? $address,
        ];
        $to = $meta['authorization_endpoint'] . (str_contains($meta['authorization_endpoint'], '?') ? '&' : '?') . http_build_query([
            'response_type' => 'code',
            'client_id' => $client['client_id'],
            'redirect_uri' => $this->back,
            'code_challenge' => self::base64url(hash('sha256', $verifier, true)),
            'code_challenge_method' => 'S256',
            'scope' => 'cms',
            'state' => $state,
        ], '', '&', PHP_QUERY_RFC3986);
        return [$to, $pending, ''];
    }

    /**
     * Finishes connecting when the Runlight sends the admin back. Each attempt works once, and only for the
     * admin who started it, so the plugin takes it out of where it kept it before calling this: the state the
     * Runlight sends back proves the rest.
     *
     * @param array<string, mixed> $query the query the Runlight sent the admin back with
     * @param mixed $pending the attempt start() gave, as kept, or null when there is none
     * @return array{0: array{address: string, site: string, agentsKey: string, dashboardKey: string}|null, 1: string}
     *   what to save, or null, and what to say about it
     */
    public function finish(array $query, mixed $pending): array
    {
        $state = is_string($query['state'] ?? null) ? $query['state'] : '';
        if (!is_array($pending) || !is_string($pending['state'] ?? null) || !hash_equals($pending['state'], $state)) {
            return [null, $this->words('expired')];
        }
        $error = $query['error'] ?? null;
        if (is_string($error) && $error !== '') {
            if ($error === 'access_denied') {
                return [null, $this->words('denied')];
            }
            $description = $query['error_description'] ?? null;
            return [null, $this->words('failed', ['reason' => is_string($description) && $description !== '' ? $description : $error])];
        }
        $code = is_string($query['code'] ?? null) ? $query['code'] : '';
        [$granted, $failed] = $this->json((string) ($pending['token'] ?? ''), [
            'method' => 'POST',
            'headers' => ['content-type' => 'application/x-www-form-urlencoded'],
            'body' => http_build_query([
                'grant_type' => 'authorization_code',
                'code' => $code,
                'client_id' => (string) ($pending['client'] ?? ''),
                'redirect_uri' => $this->back,
                'code_verifier' => (string) ($pending['verifier'] ?? ''),
            ], '', '&', PHP_QUERY_RFC3986),
        ]);
        if ($failed !== '') {
            return [null, $this->words('lost', ['error' => $failed])];
        }
        if ($granted === null || !is_string($granted['access_token'] ?? null) || !is_string($granted['agents_key'] ?? null)) {
            return [null, $this->words('keys')];
        }
        $site = is_string($granted['site'] ?? null) ? $granted['site'] : '';
        return [
            ['address' => (string) ($pending['address'] ?? ''), 'site' => $site, 'agentsKey' => $granted['agents_key'], 'dashboardKey' => $granted['access_token']],
            $this->words('connected', ['site' => $site]),
        ];
    }

    /**
     * JSON from the Runlight, with no redirect followed.
     *
     * @param array<string, mixed> $init
     * @return array{0: array<string, mixed>|null, 1: string} the JSON, or null when it could not be reached or
     *   did not answer with any, and why it could not be reached
     */
    private function json(string $url, array $init = []): array
    {
        try {
            $response = $this->fetcher->fetch($url, $init + ['redirect' => 'manual', 'timeoutMs' => self::TIMEOUT_MS, 'maxBytes' => self::MAX_BYTES]);
            $body = json_decode($response->text(), true);
        } catch (\Throwable $e) {
            return [null, $e->getMessage() !== '' ? $e->getMessage() : 'fetch failed'];
        }
        return [is_array($body) ? $body : null, ''];
    }

    /** @param array<string, string> $params */
    private function words(string $code, array $params = []): string
    {
        return ($this->say)($code, $params);
    }

    private static function base64url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }
}
