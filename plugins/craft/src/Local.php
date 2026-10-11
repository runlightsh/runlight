<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use craft\helpers\Queue;
use Runlight\Craft\jobs\Check;
use Runlight\Http\Request;
use Runlight\Routes;
use Runlight\Runlight;
use Runlight\Server\DbIp;
use Runlight\Time;

/**
 * Runlight running in this Craft site: its dashboard and endpoints at
 * /runlight on the site, its numbers in Craft's database, the Control Panel
 * users who may use the plugin as its owners, and Craft's queue, or a cron
 * job running `php craft runlight/check`, for its hourly upkeep.
 */
final class Local
{
    /** The cache key holding when the upkeep last ran, so a web request queues it at most once an hour. */
    private const CHECKED = 'runlight-checked';

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
        if (Storage::kind() === '') {
            return $missing = Craft::t('runlight', 'Running Runlight in this Craft site needs Craft’s database on Postgres, MySQL 8.4, or MariaDB 11.4 or later, or PHP’s pdo_sqlite extension, and this server has neither.');
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
        $parts = parse_url(self::home());
        return strtolower(($parts['scheme'] ?? 'https') . '://' . ($parts['host'] ?? 'localhost')) . (isset($parts['port']) ? ':' . $parts['port'] : '');
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
     * The secret Runlight signs sessions and tickets with: RUNLIGHT_SECRET when it is set, so
     * several servers share one, or else made the first time and kept in Runlight's folder.
     */
    private static function secret(): string
    {
        $env = getenv('RUNLIGHT_SECRET');
        if (is_string($env) && $env !== '') {
            return $env;
        }
        return Storage::remember('secret', static fn (): string => bin2hex(random_bytes(32)));
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

    /** Runlight, made on first use in a request. */
    public static function runlight(): Runlight
    {
        if (self::$runlight !== null) {
            return self::$runlight;
        }
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
            // Hosts and CDNs in front of Craft name the visitor in a header, and Runlight needs them told apart.
            'trustProxy' => true,
            'fetcher' => new Fetcher(),
            'dataDir' => Storage::folder(),
            'linkPath' => self::folder() . '/go',
        ];
        if (Plugin::getInstance()->getSettings()->locations) {
            $lookup = self::locations()->lookup();
            if ($lookup !== null) {
                $options['geo'] = $lookup;
            }
        }
        // With a transport such as SMTP set up, reports go through Craft, until the dashboard names another service.
        $mailer = property_exists(Runlight::class, 'appMailer') ? Mailer::option() : null;
        if ($mailer !== null) {
            $options['mail'] = $mailer;
        }
        return self::$runlight = new Runlight($options);
    }

    /**
     * Runlight's routes, signed in through Craft: admins, and the people allowed to use the plugin
     * in the Control Panel, own it.
     */
    public static function routes(): Routes
    {
        if (self::$routes !== null) {
            return self::$routes;
        }
        return self::$routes = self::runlight()->routes([
            'basePath' => self::base(),
            'token' => null,
            'authorize' => static function (): bool {
                $user = Craft::$app->getUser();
                return !$user->getIsGuest() && $user->checkPermission('accessPlugin-runlight');
            },
            'signIn' => self::base() . '/login',
            'origin' => self::origin(),
            'geoCredit' => Plugin::getInstance()->getSettings()->locations,
            'cms' => 'Craft',
        ]);
    }

    /** Runs the upkeep: salts, reports, retention, daily totals, and location data. */
    public static function check(): void
    {
        Craft::$app->getCache()->set(self::CHECKED, time(), 0);
        if (!self::active()) {
            return;
        }
        if (Plugin::getInstance()->getSettings()->locations) {
            self::locations()->refresh((int) floor(microtime(true) * 1000));
        }
        self::runlight()->check();
    }

    /**
     * Queues the upkeep when it has not run for an hour, since Craft has no schedule of its own. A
     * cron job running `php craft runlight/check` does the same without waiting on the queue.
     */
    public static function schedule(): void
    {
        $cache = Craft::$app->getCache();
        $last = $cache->get(self::CHECKED);
        if (is_int($last) && $last > time() - 3600) {
            return;
        }
        $cache->set(self::CHECKED, time(), 0);
        Queue::push(new Check());
    }

    /** Records a page served to an AI agent, once the page has been sent. */
    public static function observe(string $url, string $agent): void
    {
        self::runlight()->observe(new Request($url, 'GET', ['user-agent' => $agent]));
    }
}
