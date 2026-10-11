<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use GuzzleHttp\ClientInterface;
use Runlight\Cms\Connect as CmsConnect;
use yii\caching\CacheInterface;

/**
 * Connecting to a Runlight without copying keys: the package's Connect (Runlight\Cms\Connect) registers the
 * plugin with the Runlight's OAuth server, sends the admin to its consent page to pick this site, and on the
 * way back swaps the code, checked with PKCE, for the site's dashboard key, agents key, and id. This class
 * gives it Craft's HTTP client, Craft's cache to keep the attempt in, and the plugin's words.
 * ConnectController saves the keys.
 */
final class Connect
{
    private readonly CmsConnect $connect;

    /**
     * @param ClientInterface $http Craft's Guzzle client
     * @param CacheInterface $cache where the attempt waits, for this admin alone
     * @param int $user the admin's id
     * @param string $back where the Runlight sends the admin back to, which it is registered with
     */
    public function __construct(
        ClientInterface $http,
        private readonly CacheInterface $cache,
        private readonly int $user,
        string $back,
    ) {
        $this->connect = new CmsConnect(new Fetcher($http), $back, self::say(...));
    }

    /** The cache key for this admin's attempt only. */
    private function key(): string
    {
        return 'runlight-connect-' . $this->user;
    }

    /**
     * What to say about each step of connecting, by the package's codes.
     *
     * @param array<string,string> $params
     */
    private static function say(string $code, array $params): string
    {
        return match ($code) {
            'address' => Craft::t('runlight', 'Enter your Runlight’s address, then press Connect.'),
            'scheme' => Craft::t('runlight', 'Enter a web address, such as https://stats.example.com.'),
            'https' => Craft::t('runlight', 'Connecting needs this site’s Control Panel on https. Copy the keys from Runlight’s Settings, Install into the fields below instead.'),
            'unreachable' => Craft::t('runlight', 'Could not reach a Runlight at {address}: {error}', $params),
            'unknown' => Craft::t('runlight', 'Could not connect to a Runlight at {address}. Check the address, which is shown in Runlight under Settings, Install.', $params),
            'older' => Craft::t('runlight', 'Your Runlight is older than this plugin. Update it, or copy the keys from its Settings, Install into the fields below.'),
            'client' => Craft::t('runlight', 'Craft at {host}', $params),
            'silent' => Craft::t('runlight', 'It did not say why.'),
            'refused' => Craft::t('runlight', 'Your Runlight would not let this site connect: {reason}', $params),
            'expired' => Craft::t('runlight', 'That connection took too long or was already used. Press Connect again.'),
            'denied' => Craft::t('runlight', 'The connection was not allowed.'),
            'failed' => Craft::t('runlight', 'Your Runlight did not connect this site: {reason}', $params),
            'lost' => Craft::t('runlight', 'Could not reach your Runlight to finish connecting: {error}', $params),
            'keys' => Craft::t('runlight', 'Your Runlight did not give this site its keys. Press Connect again.'),
            'connected' => Craft::t('runlight', 'Connected. Runlight counts this site as {site}.', $params),
            default => $code,
        };
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
        [$to, $pending, $error] = $this->connect->start($address, $entered);
        if ($to === null) {
            return [null, $error];
        }
        $this->cache->set($this->key(), $pending, CmsConnect::WAIT);
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
        [$granted, $message] = $this->connect->finish($query, $pending === false ? null : $pending);
        if ($granted === null) {
            return [null, $message];
        }
        return [
            ['address' => $granted['address'], 'site' => $granted['site'], 'observeKey' => $granted['agentsKey'], 'dashboardKey' => $granted['dashboardKey']],
            $message,
        ];
    }
}
