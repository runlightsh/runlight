<?php

declare(strict_types=1);

namespace Runlight\Craft\controllers;

use Craft;
use craft\helpers\UrlHelper;
use craft\web\Controller;
use Runlight\Craft\models\Settings;
use Runlight\Craft\Plugin;
use yii\web\Response;

/**
 * Connecting to a Runlight without copying keys: the plugin registers itself
 * with the Runlight's OAuth server, sends the admin to its consent page to
 * pick this site, and on the way back swaps the code, checked with PKCE, for
 * the site's dashboard key, agents key, and id, which it saves.
 *
 * Both actions save the plugin's settings, which live in project config, so
 * only an admin may use them, and only where admin changes are allowed, as
 * Craft asks of its own settings page.
 */
final class ConnectController extends Controller
{
    /** How long a connection may wait on the consent page before it has to be started again. */
    private const PENDING = 15 * 60;

    /** Where the Runlight sends the admin back to, which it is registered with. */
    private static function back(): string
    {
        return UrlHelper::cpUrl('runlight/connected');
    }

    /** Where what happened is said: the dashboard once connected, or the settings page to try again. */
    private function done(string $message, bool $ok = false): Response
    {
        if ($ok) {
            $this->setSuccessFlash($message);
            return $this->redirect(UrlHelper::cpUrl('runlight'));
        }
        $this->setFailFlash($message);
        return $this->redirect(UrlHelper::cpUrl('settings/plugins/runlight'));
    }

    /** The cache key for the current admin's attempt only. */
    private static function key(): string
    {
        return 'runlight-connect-' . (int) Craft::$app->getUser()->getId();
    }

    /**
     * Whether this Control Panel is somewhere a Runlight can send people back to: https,
     * or this computer while trying things out.
     */
    private static function possible(): bool
    {
        $back = parse_url(self::back());
        $host = is_array($back) ? strtolower((string) ($back['host'] ?? '')) : '';
        return (is_array($back) && strtolower((string) ($back['scheme'] ?? '')) === 'https') || in_array($host, ['localhost', '127.0.0.1', '[::1]'], true);
    }

    /**
     * JSON from the Runlight, or null when it could not be reached or did not answer with any.
     *
     * @param array<string,mixed> $options Guzzle's request options.
     * @return array<string,mixed>|null
     */
    private static function json(string $method, string $url, array $options = []): ?array
    {
        try {
            $response = Craft::createGuzzleClient(['timeout' => 10, 'http_errors' => false, 'allow_redirects' => false])->request($method, $url, $options);
        } catch (\Throwable $e) {
            return null;
        }
        $body = json_decode((string) $response->getBody(), true);
        return is_array($body) ? $body : null;
    }

    /** Starts connecting, from the Connect button on the settings page. */
    public function actionStart(): Response
    {
        $this->requirePostRequest();
        $this->requireAdmin();
        $fields = $this->request->getBodyParam('settings');
        $entered = new Settings();
        $entered->address = is_array($fields) && is_string($fields['address'] ?? null) ? trim($fields['address']) : '';
        $address = $entered->getAddress();
        if ($address === '') {
            return $this->done(Craft::t('runlight', 'Enter your Runlight’s address, then press Connect.'));
        }
        if (!$entered->validate(['address'])) {
            return $this->done($entered->getFirstError('address') ?? '');
        }
        if (!self::possible()) {
            return $this->done(Craft::t('runlight', 'Connecting needs this site’s Control Panel on https. Copy the keys from Runlight’s Settings, Install into the fields below instead.'));
        }

        $unreachable = Craft::t('runlight', 'Could not connect to a Runlight at {address}. Check the address, which is shown in Runlight under Settings, Install.', ['address' => $address]);
        $meta = self::json('GET', $address . '/.well-known/oauth-authorization-server');
        if ($meta === null || !is_string($meta['authorization_endpoint'] ?? null) || !is_string($meta['token_endpoint'] ?? null) || !is_string($meta['registration_endpoint'] ?? null)) {
            return $this->done($unreachable);
        }
        // Its endpoints must be on its own address, so an address cannot send this server's requests elsewhere.
        $origin = self::origin($address);
        foreach (['authorization_endpoint', 'token_endpoint', 'registration_endpoint'] as $endpoint) {
            if (self::origin($meta[$endpoint]) !== $origin) {
                return $this->done($unreachable);
            }
        }
        if (!in_array('cms', (array) ($meta['scopes_supported'] ?? []), true)) {
            return $this->done(Craft::t('runlight', 'Your Runlight is older than this plugin. Update it, or copy the keys from its Settings, Install into the fields below.'));
        }

        $site = Craft::$app->getSites()->getPrimarySite()->getBaseUrl();
        $host = (string) parse_url($site !== null && $site !== '' ? $site : self::back(), PHP_URL_HOST);
        $client = self::json('POST', $meta['registration_endpoint'], [
            'json' => ['client_name' => Craft::t('runlight', 'Craft at {host}', ['host' => $host]), 'redirect_uris' => [self::back()]],
        ]);
        if ($client === null || !is_string($client['client_id'] ?? null)) {
            $reason = is_string($client['error_description'] ?? null) ? $client['error_description'] : Craft::t('runlight', 'It did not say why.');
            return $this->done(Craft::t('runlight', 'Your Runlight would not let this site connect: {reason}', ['reason' => $reason]));
        }

        $state = bin2hex(random_bytes(16));
        $verifier = rtrim(strtr(base64_encode(random_bytes(48)), '+/', '-_'), '=');
        Craft::$app->getCache()->set(self::key(), [
            'state' => $state,
            'verifier' => $verifier,
            'client' => $client['client_id'],
            'token' => $meta['token_endpoint'],
            // As entered, so an address named by an environment variable is saved as that variable.
            'address' => $entered->address,
        ], self::PENDING);
        $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
        $to = $meta['authorization_endpoint'] . (str_contains($meta['authorization_endpoint'], '?') ? '&' : '?') . http_build_query([
            'response_type' => 'code',
            'client_id' => $client['client_id'],
            'redirect_uri' => self::back(),
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
            'scope' => 'cms',
            'state' => $state,
        ], '', '&', PHP_QUERY_RFC3986);
        return $this->redirect($to);
    }

    /**
     * Finishes connecting when the Runlight sends the admin back. It is a GET with no CSRF token:
     * the state, kept for this admin and compared below, does that work.
     */
    public function actionFinish(): Response
    {
        $this->requireAdmin();
        // Each attempt works once, and only for the admin who started it: the state it was sent with proves that.
        $cache = Craft::$app->getCache();
        $pending = $cache->get(self::key());
        $cache->delete(self::key());
        $state = $this->request->getQueryParam('state');
        $state = is_string($state) ? $state : '';
        if (!is_array($pending) || !hash_equals((string) ($pending['state'] ?? ''), $state)) {
            return $this->done(Craft::t('runlight', 'That connection took too long or was already used. Press Connect again.'));
        }
        $error = $this->request->getQueryParam('error');
        if (is_string($error) && $error !== '') {
            if ($error === 'access_denied') {
                return $this->done(Craft::t('runlight', 'The connection was not allowed.'));
            }
            $description = $this->request->getQueryParam('error_description');
            $reason = is_string($description) && $description !== '' ? $description : $error;
            return $this->done(Craft::t('runlight', 'Your Runlight did not connect this site: {reason}', ['reason' => $reason]));
        }
        $code = $this->request->getQueryParam('code');
        $code = is_string($code) ? $code : '';

        $granted = self::json('POST', $pending['token'], [
            'form_params' => [
                'grant_type' => 'authorization_code',
                'code' => $code,
                'client_id' => $pending['client'],
                'redirect_uri' => self::back(),
                'code_verifier' => $pending['verifier'],
            ],
        ]);
        if ($granted === null || !is_string($granted['access_token'] ?? null) || !is_string($granted['agents_key'] ?? null)) {
            return $this->done(Craft::t('runlight', 'Your Runlight did not give this site its keys. Press Connect again.'));
        }
        $site = is_string($granted['site'] ?? null) ? $granted['site'] : '';
        $plugin = Plugin::getInstance();
        $before = $plugin->getSettings();
        // Every setting is passed, since Craft saves only the ones it is given to project config.
        $saved = Craft::$app->getPlugins()->savePluginSettings($plugin, [
            // Connecting means Runlight runs elsewhere, even when it ran in this site before.
            'mode' => 'remote',
            'address' => $pending['address'],
            'site' => $site,
            'observeKey' => $granted['agents_key'],
            'dashboardKey' => $granted['access_token'],
            'skipAdmins' => $before->skipAdmins,
            'outbound' => $before->outbound,
            'downloads' => $before->downloads,
            'locations' => $before->locations,
        ]);
        if (!$saved) {
            return $this->done(Craft::t('app', 'Couldn’t save plugin settings.'));
        }
        return $this->done(Craft::t('runlight', 'Connected. Runlight counts this site as {site}.', ['site' => $site]), true);
    }

    /** The scheme, host, and port of an address. */
    private static function origin(string $address): string
    {
        $parts = parse_url($address);
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            return '';
        }
        return strtolower($parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : ''));
    }
}
