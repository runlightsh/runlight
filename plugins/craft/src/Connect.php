<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use GuzzleHttp\ClientInterface;
use yii\caching\CacheInterface;

/**
 * Connecting to a Runlight without copying keys: the plugin registers itself with the Runlight's OAuth
 * server, sends the admin to its consent page to pick this site, and on the way back swaps the code,
 * checked with PKCE, for the site's dashboard key, agents key, and id. ConnectController saves them.
 */
final class Connect
{
    /** How long a connection may wait on the consent page before it has to be started again. */
    private const WAIT = 15 * 60;

    /**
     * @param ClientInterface $http Craft's Guzzle client
     * @param CacheInterface $cache where the attempt waits, for this admin alone
     * @param int $user the admin's id
     * @param string $back where the Runlight sends the admin back to, which it is registered with
     */
    public function __construct(
        private readonly ClientInterface $http,
        private readonly CacheInterface $cache,
        private readonly int $user,
        private readonly string $back,
    ) {
    }

    /** The cache key for this admin's attempt only. */
    private function key(): string
    {
        return 'runlight-connect-' . $this->user;
    }

    /** Whether a Runlight sends people back to an address: on https, or this computer while trying things out. */
    public static function returnable(string $back): bool
    {
        $parts = parse_url($back);
        $host = is_array($parts) ? strtolower((string) ($parts['host'] ?? '')) : '';
        return (is_array($parts) && strtolower((string) ($parts['scheme'] ?? '')) === 'https') || in_array($host, ['localhost', '127.0.0.1', '[::1]'], true);
    }

    /**
     * JSON from the Runlight.
     *
     * @param array<string,mixed> $options Guzzle's request options
     * @return array{0: array<string,mixed>|null, 1: string} the JSON, or null when it could not be reached or
     *   did not answer with any, and why it could not be reached
     */
    private function json(string $method, string $url, array $options = []): array
    {
        try {
            $response = $this->http->request($method, $url, $options + ['timeout' => 10, 'http_errors' => false, 'allow_redirects' => false]);
        } catch (\Throwable $e) {
            return [null, $e->getMessage()];
        }
        $body = json_decode((string) $response->getBody(), true);
        return [is_array($body) ? $body : null, ''];
    }

    /**
     * Starts connecting, from the Connect button in the settings.
     *
     * @param string $address the Runlight's address, with any environment variable read
     * @param string $entered the address as entered, which may name an environment variable, to save as it is
     * @return array{0: string|null, 1: string} the consent page's address, or why there is none
     */
    public function start(string $address, string $entered): array
    {
        if (!self::returnable($this->back)) {
            return [null, Craft::t('runlight', 'Connecting needs this site’s Control Panel on https. Copy the keys from Runlight’s Settings, Install into the fields below instead.')];
        }
        [$meta, $error] = $this->json('GET', $address . '/.well-known/oauth-authorization-server');
        if ($error !== '') {
            return [null, Craft::t('runlight', 'Could not reach a Runlight at {address}: {error}', ['address' => $address, 'error' => $error])];
        }
        $unknown = Craft::t('runlight', 'Could not connect to a Runlight at {address}. Check the address, which is shown in Runlight under Settings, Install.', ['address' => $address]);
        if ($meta === null || !is_string($meta['authorization_endpoint'] ?? null) || !is_string($meta['token_endpoint'] ?? null) || !is_string($meta['registration_endpoint'] ?? null)) {
            return [null, $unknown];
        }
        // Its endpoints must be on its own address, so an address cannot send this server's requests elsewhere.
        $origin = Local::originOf($address);
        foreach (['authorization_endpoint', 'token_endpoint', 'registration_endpoint'] as $endpoint) {
            if (Local::originOf($meta[$endpoint]) !== $origin) {
                return [null, $unknown];
            }
        }
        if (!in_array('cms', (array) ($meta['scopes_supported'] ?? []), true)) {
            return [null, Craft::t('runlight', 'Your Runlight is older than this plugin. Update it, or copy the keys from its Settings, Install into the fields below.')];
        }

        // Named for where the Runlight sends the admin back to, which is the address it checks.
        [$client, $error] = $this->json('POST', $meta['registration_endpoint'], [
            'json' => ['client_name' => Craft::t('runlight', 'Craft at {host}', ['host' => (string) parse_url($this->back, PHP_URL_HOST)]), 'redirect_uris' => [$this->back]],
        ]);
        if ($client === null || !is_string($client['client_id'] ?? null)) {
            $reason = is_string($client['error_description'] ?? null) ? $client['error_description'] : ($error !== '' ? $error : Craft::t('runlight', 'It did not say why.'));
            return [null, Craft::t('runlight', 'Your Runlight would not let this site connect: {reason}', ['reason' => $reason])];
        }

        $state = bin2hex(random_bytes(16));
        $verifier = rtrim(strtr(base64_encode(random_bytes(48)), '+/', '-_'), '=');
        $this->cache->set($this->key(), [
            'state' => $state,
            'verifier' => $verifier,
            'client' => $client['client_id'],
            'token' => $meta['token_endpoint'],
            'address' => $entered,
        ], self::WAIT);
        $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
        $to = $meta['authorization_endpoint'] . (str_contains($meta['authorization_endpoint'], '?') ? '&' : '?') . http_build_query([
            'response_type' => 'code',
            'client_id' => $client['client_id'],
            'redirect_uri' => $this->back,
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
            'scope' => 'cms',
            'state' => $state,
        ], '', '&', PHP_QUERY_RFC3986);
        return [$to, ''];
    }

    /**
     * Finishes connecting when the Runlight sends the admin back. Each attempt works once, and only for the
     * admin who started it: the state it was sent with proves that.
     *
     * @param array<string,mixed> $query the query the Runlight sent the admin back with
     * @return array{0: array{address: string, site: string, observeKey: string, dashboardKey: string}|null, 1: string}
     *   what to save, or null, and what to say about it
     */
    public function finish(array $query): array
    {
        $pending = $this->cache->get($this->key());
        $this->cache->delete($this->key());
        $state = is_string($query['state'] ?? null) ? $query['state'] : '';
        if (!is_array($pending) || !hash_equals((string) ($pending['state'] ?? ''), $state)) {
            return [null, Craft::t('runlight', 'That connection took too long or was already used. Press Connect again.')];
        }
        $error = $query['error'] ?? null;
        if (is_string($error) && $error !== '') {
            if ($error === 'access_denied') {
                return [null, Craft::t('runlight', 'The connection was not allowed.')];
            }
            $description = $query['error_description'] ?? null;
            $reason = is_string($description) && $description !== '' ? $description : $error;
            return [null, Craft::t('runlight', 'Your Runlight did not connect this site: {reason}', ['reason' => $reason])];
        }
        $code = is_string($query['code'] ?? null) ? $query['code'] : '';
        [$granted, $failed] = $this->json('POST', (string) $pending['token'], [
            'form_params' => [
                'grant_type' => 'authorization_code',
                'code' => $code,
                'client_id' => $pending['client'],
                'redirect_uri' => $this->back,
                'code_verifier' => $pending['verifier'],
            ],
        ]);
        if ($failed !== '') {
            return [null, Craft::t('runlight', 'Could not reach your Runlight to finish connecting: {error}', ['error' => $failed])];
        }
        if ($granted === null || !is_string($granted['access_token'] ?? null) || !is_string($granted['agents_key'] ?? null)) {
            return [null, Craft::t('runlight', 'Your Runlight did not give this site its keys. Press Connect again.')];
        }
        $site = is_string($granted['site'] ?? null) ? $granted['site'] : '';
        return [
            ['address' => (string) $pending['address'], 'site' => $site, 'observeKey' => $granted['agents_key'], 'dashboardKey' => $granted['access_token']],
            Craft::t('runlight', 'Connected. Runlight counts this site as {site}.', ['site' => $site]),
        ];
    }
}
