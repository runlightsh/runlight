<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use craft\helpers\Queue;
use Runlight\Craft\jobs\Check;
use Runlight\Http\Request;
use Runlight\Log;
use Runlight\Routes;
use Runlight\Runlight;
use Runlight\Server\DbIp;
use Runlight\Time;
use yii\queue\Queue as YiiQueue;

/**
 * Runlight running in this Craft site: its dashboard and endpoints at /runlight on the site, its numbers in
 * Craft's database, admins and people who may manage Runlight as its owners, those who may view it as its
 * readers, and Craft's queue, or a cron job running `php craft runlight/check`, for its hourly upkeep.
 */
final class Local
{
    /** The permission to see Runlight's numbers, as a reader. */
    public const VIEW = 'runlight-view';

    /** The permission to own Runlight: its settings, keys, sites, people, and data. */
    public const MANAGE = 'runlight-manage';

    /** The cache key holding when the upkeep was last queued, so a web request queues it at most once an hour. */
    public const CHECKED = 'runlight-checked';

    /** The cache key holding the id of the upkeep job last queued, so another is never queued while it waits. */
    public const JOB = 'runlight-check-job';

    /** The cache key holding when the upkeep last finished, or was first due. */
    public const DONE = 'runlight-check-done';

    private static ?Runlight $runlight = null;
    private static ?Routes $routes = null;

    /** Whether a request was answered by Runlight here, so the plugin's own after-send work leaves it alone. */
    public static bool $served = false;

    /** Whether Runlight runs in this site: chosen in the settings, and possible on this server. */
    public static function active(): bool
    {
        return Plugin::getInstance()->getSettings()->getMode() === 'local' && self::missing() === '';
    }

    /**
     * What stops Runlight running in this site, in a sentence for the settings page, or an empty
     * string when nothing does. Composer has already seen to PHP's version.
     */
    public static function missing(): string
    {
        static $missing = null;
        if ($missing !== null) {
            return $missing;
        }
        foreach (['pdo', 'mbstring', 'openssl'] as $extension) {
            if (!extension_loaded($extension)) {
                return $missing = Craft::t('runlight', 'Running Runlight in this Craft site needs PHP’s {extension} extension, which this server does not have.', ['extension' => $extension]);
            }
        }
        if (Storage::kind() === '' && Storage::clash()) {
            return $missing = Craft::t('runlight', 'Craft’s database already has tables starting {prefix} that are not this install’s Runlight’s, so Runlight leaves them alone. Running it in this Craft site then needs PHP’s pdo_sqlite extension, for a SQLite file in the storage folder.', ['prefix' => Storage::prefix()]);
        }
        if (Storage::kind() === '') {
            return $missing = Craft::t('runlight', 'Running Runlight in this Craft site needs Craft’s database on Postgres, MySQL 8.0.20, or MariaDB 11.4 or later, or PHP’s pdo_sqlite extension, and this server has neither.');
        }
        return $missing = '';
    }

    /** The current site's address, which is the request's own scheme and host when the site's base URL is @web. */
    private static function home(): string
    {
        $url = Craft::$app->getSites()->getCurrentSite()->getBaseUrl();
        if ($url === null || $url === '') {
            $url = Craft::$app->getRequest()->getIsConsoleRequest() ? 'http://localhost/' : Craft::$app->getRequest()->getHostInfo() . '/';
        }
        return rtrim($url, '/');
    }

    /** The scheme, host, and port of the site, which Runlight is reached at. */
    public static function origin(): string
    {
        return self::originOf(self::home());
    }

    /**
     * The scheme, host, and port of an address, as a browser writes its origin: a default port is left out,
     * so https://x:443 and https://x are the same.
     */
    public static function originOf(string $address): string
    {
        $parts = parse_url($address);
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            return '';
        }
        $scheme = strtolower($parts['scheme']);
        $port = (int) ($parts['port'] ?? 0);
        $default = ($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80);
        return $scheme . '://' . strtolower($parts['host']) . ($port && !$default ? ':' . $port : '');
    }

    /** The path of the folder the site lives in, if any, without a trailing slash. */
    private static function folder(): string
    {
        return rtrim((string) parse_url(self::home(), PHP_URL_PATH), '/');
    }

    /** The path Runlight answers under. */
    public static function base(): string
    {
        return self::folder() . '/runlight';
    }

    /** Runlight's full address on this site. */
    public static function address(): string
    {
        return self::origin() . self::base();
    }

    /** This site's id in Runlight, which counts this one Craft install. */
    private static function site(): string
    {
        return 'default';
    }

    /**
     * The domains Runlight counts: those of every site in this Craft install. An address such as
     * 127.0.0.1 is no domain, and a site with none known could be at any, so then any host counts.
     *
     * @return list<string>
     */
    private static function hostnames(): array
    {
        $hosts = [];
        foreach (Craft::$app->getSites()->getAllSites() as $site) {
            try {
                $url = $site->getBaseUrl();
            } catch (\Throwable $e) {
                $url = null;
            }
            $host = strtolower((string) parse_url((string) $url, PHP_URL_HOST));
            if ($host === '' && !Craft::$app->getRequest()->getIsConsoleRequest()) {
                $host = strtolower((string) Craft::$app->getRequest()->getHostName());
            }
            if ($host === '' || filter_var(trim($host, '[]'), FILTER_VALIDATE_IP)) {
                return [];
            }
            $hosts[$host] = true;
        }
        return array_keys($hosts);
    }

    /** Craft's timezone, when Runlight knows it by that name. */
    private static function timezone(): string
    {
        $zone = (string) Craft::$app->getTimeZone();
        return Time::isTimezone($zone) ? $zone : 'UTC';
    }

    /**
     * The secret Runlight signs sessions and tickets with, and seals keys with: derived from Craft's own
     * security key, so every server and every deploy of this site has the same one without a file.
     */
    public static function secret(): string
    {
        return hash_hmac('sha256', 'runlight', (string) Craft::$app->getConfig()->getGeneral()->securityKey);
    }

    /** DB-IP's free country data, kept in Runlight's folder. */
    private static function locations(): DbIp
    {
        return new DbIp(
            Storage::folder() . DIRECTORY_SEPARATOR . 'geo',
            'country',
            [Fetcher::class, 'download'],
            static function (string $line): void {
                Craft::info($line, 'runlight');
            },
        );
    }

    /** Runlight's shared values, in Craft's cache. */
    public static function cache(): Cache
    {
        return new Cache(Craft::$app->getCache());
    }

    /** Runlight, made on first use in a request. */
    public static function runlight(): Runlight
    {
        if (self::$runlight !== null) {
            return self::$runlight;
        }
        // Runlight's notes, such as a report it could not send, go to Craft's log.
        Log::to(static function (string $line): void {
            Craft::warning($line, 'runlight');
        });
        $primary = Craft::$app->getSites()->getPrimarySite();
        $options = [
            'store' => Storage::store(),
            'site' => [
                'id' => self::site(),
                'name' => $primary->getName(),
                'hostnames' => self::hostnames(),
                'timezone' => self::timezone(),
            ],
            'secret' => self::secret(),
            // The visitor's address comes with each request, as Visitor works it out, so no header is believed here.
            'trustProxy' => false,
            'fetcher' => new Fetcher(),
            // Rate counts and the site's icon go in Craft's cache, never in files of Runlight's own.
            'cache' => self::cache(),
            'linkPath' => self::folder() . '/go',
        ];
        if (Plugin::getInstance()->getSettings()->locations) {
            $lookup = self::locations()->lookup();
            if ($lookup !== null) {
                $options['geo'] = $lookup;
            }
        }
        // With a transport such as SMTP set up, reports go through Craft, until the dashboard names another service.
        $mailer = Mailer::option();
        if ($mailer !== null) {
            $options['mail'] = $mailer;
        }
        return self::$runlight = new Runlight($options);
    }

    /** Runlight's routes, signed in through Craft. */
    public static function routes(): Routes
    {
        if (self::$routes !== null) {
            return self::$routes;
        }
        return self::$routes = self::runlight()->routes([
            'basePath' => self::base(),
            'token' => null,
            // Given here, so Runlight never reads them from the environment: the plugin runs the upkeep, and no
            // other site reports AI agents to this one.
            'cronSecret' => '',
            'observeKey' => '',
            'authorize' => static fn (Request $request): bool|string => self::access($request),
            'signIn' => self::base() . '/login',
            'origin' => self::origin(),
            'geoCredit' => Plugin::getInstance()->getSettings()->locations,
            'cms' => 'Craft',
        ]);
    }

    /**
     * What the signed-in user may do in Runlight: true for an owner (an admin, or someone who may manage
     * Runlight), "read" for someone who may view it, false for anyone else.
     */
    public static function access(Request $request): bool|string
    {
        if (!self::sameSite($request)) {
            return false;
        }
        $user = Craft::$app->getUser();
        if ($user->getIsGuest()) {
            return false;
        }
        if ($user->getIsAdmin() || $user->checkPermission(self::MANAGE)) {
            return true;
        }
        return $user->checkPermission(self::VIEW) ? 'read' : false;
    }

    /** Whether the signed-in user may see Runlight's numbers here at all. */
    public static function canView(): bool
    {
        $user = Craft::$app->getUser();
        return !$user->getIsGuest() && ($user->getIsAdmin() || $user->checkPermission(self::MANAGE) || $user->checkPermission(self::VIEW));
    }

    /**
     * Whether a change comes from a page on the site it is sent to. Craft's session cookie goes along with a
     * request from any site, and Runlight's dashboard has no CSRF token of Craft's to send, so a change is
     * taken only from this site's own pages, as the browser says where a request comes from. Reading is safe
     * from anywhere.
     */
    public static function sameSite(Request $request): bool
    {
        if (in_array($request->method, ['GET', 'HEAD', 'OPTIONS'], true)) {
            return true;
        }
        $fetch = strtolower((string) $request->headers->get('sec-fetch-site'));
        if ($fetch !== '') {
            return $fetch === 'same-origin' || $fetch === 'none';
        }
        $origin = (string) $request->headers->get('origin');
        if ($origin === '') {
            return true;
        }
        return strtolower((string) parse_url($origin, PHP_URL_HOST)) === strtolower((string) parse_url($request->url, PHP_URL_HOST));
    }

    /**
     * The request as Runlight reads it: the URL as the browser asked for it, its headers, its body read up to
     * Runlight's limit, and the visitor's address as Visitor works it out.
     *
     * @throws \Runlight\Http\BodyTooLarge past the body's limit
     */
    public static function visitorRequest(\craft\web\Request $request): Request
    {
        $url = $request->getAbsoluteUrl();
        $headers = [];
        foreach ($request->getHeaders()->toArray() as $name => $values) {
            $headers[strtolower((string) $name)] = array_map('strval', (array) $values);
        }
        // The method as sent, never one a header or field overrides, as Yii allows.
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? $request->getMethod()));
        $body = '';
        if (!in_array($method, ['GET', 'HEAD'], true)) {
            $input = fopen('php://input', 'rb');
            $body = $input === false ? '' : Request::readBody($input, $url, $headers['content-length'][0] ?? null);
        }
        return new Request($url, $method, $headers, $body, Visitor::of($request, $headers));
    }

    /**
     * Runs the upkeep: salts, reports, retention, daily totals, and location data. A failure is logged
     * rather than thrown, so the queue or cron job goes on.
     */
    public static function check(): void
    {
        Craft::$app->getCache()->set(self::CHECKED, time(), 0);
        if (!self::active()) {
            return;
        }
        try {
            if (Plugin::getInstance()->getSettings()->locations) {
                self::locations()->refresh((int) floor(microtime(true) * 1000));
            }
            self::runlight()->check();
            self::cache()->sweep();
            Craft::$app->getCache()->set(self::DONE, time(), 0);
        } catch (\Throwable $e) {
            Craft::error('Runlight’s hourly check failed: ' . $e->getMessage(), 'runlight');
        }
    }

    /** Whether the upkeep has not finished for over a day: nothing runs Craft's queue or the cron job. */
    public static function overdue(): bool
    {
        $done = Craft::$app->getCache()->get(self::DONE);
        return is_int($done) && time() - $done > 25 * 3600 && self::active();
    }

    /**
     * Queues the upkeep when it has not run for an hour, since Craft has no schedule of its own, unless the
     * job queued last still waits, so a queue nothing runs never fills with them. A cron job running
     * `php craft runlight/check` does the same without waiting on the queue.
     */
    public static function schedule(): void
    {
        $cache = Craft::$app->getCache();
        $last = $cache->get(self::CHECKED);
        if (is_int($last) && $last > time() - 3600) {
            return;
        }
        $cache->set(self::CHECKED, time(), 0);
        $queued = $cache->get(self::JOB);
        $queue = Craft::$app->getQueue();
        if ($queued !== false && $queued !== null && $queue instanceof YiiQueue) {
            try {
                if ($queue->isWaiting($queued) || $queue->isReserved($queued)) {
                    return;
                }
            } catch (\Throwable) {
                // A job the queue no longer knows is done with.
            }
        }
        // Craft's own queue lists its jobs, which outlast a cleared cache.
        if ($queue instanceof \craft\queue\Queue) {
            $upkeep = (new Check())->getDescription();
            foreach ($queue->getJobInfo(100) as $job) {
                if (($job['description'] ?? null) === $upkeep && in_array($job['status'] ?? null, [YiiQueue::STATUS_WAITING, YiiQueue::STATUS_RESERVED], true)) {
                    return;
                }
            }
        }
        $id = Queue::push(new Check());
        if ($id !== null) {
            $cache->set(self::JOB, $id, 0);
        }
    }

    /**
     * Starts running Runlight here, once the admin has chosen it: the store is opened, which makes and marks
     * the tables, so the first visits never race to make them, and the upkeep is due from now.
     */
    public static function start(): void
    {
        $cache = Craft::$app->getCache();
        if (!is_int($cache->get(self::DONE))) {
            $cache->set(self::DONE, time(), 0);
        }
        if (self::missing() === '') {
            Storage::store()->migrate();
        }
    }

    /** Records a page served to an AI agent, once the page has been sent. */
    public static function observe(string $url, string $agent): void
    {
        self::runlight()->observe(new Request($url, 'GET', ['user-agent' => $agent]));
    }

    /** Forgets what was kept between requests, for uninstalling. */
    public static function forget(): void
    {
        $cache = Craft::$app->getCache();
        foreach ([self::CHECKED, self::JOB, self::DONE] as $key) {
            $cache->delete($key);
        }
        self::cache()->clear();
    }
}
