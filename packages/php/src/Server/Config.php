<?php

declare(strict_types=1);

namespace Runlight\Server;

use Runlight\Accounts\Web;
use Runlight\Env;
use Runlight\Geo;
use Runlight\Store\SqlStore;
use Runlight\Store\Stores;

/**
 * The standalone server's settings, as the drop-in (standalone/index.php) and the command line (bin/runlight)
 * both read them: environment variables first, then a config.php in the project folder (the one holding
 * vendor/) that returns the same names as an array.
 *
 *   DATA_DIR              the SQLite file, the secret, the setup code, and location data (./runlight-data)
 *   DATA_DIR_DENIED       "true" once the web server's own config turns away requests for a DATA_DIR inside
 *                         the web root, as nginx and Caddy need; without it the drop-in refuses to start
 *   DATABASE_URL          a postgres://, mysql://, or mariadb:// URL, to use that database instead of SQLite
 *   RUNLIGHT_SECRET       signs sessions and encrypts saved keys (made and kept in DATA_DIR if unset)
 *   RUNLIGHT_TOKEN        also accepted as a bearer token on the API, and makes the first account
 *   RUNLIGHT_URL          the dashboard's public address, which can never become a link domain
 *   TRUST_PROXY           "false" when no proxy sits in front, so forwarded addresses are ignored
 *   RUNLIGHT_GEO          city (the default), country, off, or the path to an MMDB file
 *   CRON_SECRET           lets a scheduler run the check over HTTP, at POST /api/check
 *   RUNLIGHT_OBSERVE_KEY  one key for every site's AI agent reports
 *
 * Relative paths are read from the project folder.
 */
final class Config
{
    /** @var array<string, mixed> */
    private array $file = [];
    private ?string $secret = null;
    private ?SqlStore $store = null;

    /**
     * @param string $root the project folder, which holds vendor/ and config.php
     * @param string|null $file a config.php elsewhere; RUNLIGHT_CONFIG names one too
     */
    public function __construct(public readonly string $root, ?string $file = null)
    {
        $file ??= Env::get('RUNLIGHT_CONFIG');
        $file = $file !== null ? $this->path($file) : "$root/config.php";
        if (is_file($file)) {
            $values = (static fn (string $path): mixed => require $path)($file);
            if (!is_array($values)) {
                throw new \RuntimeException("Runlight: $file must return an array of settings, such as return ['RUNLIGHT_URL' => 'https://stats.example.com'];");
            }
            $this->file = $values;
        } elseif ($file !== "$root/config.php") {
            throw new \RuntimeException("Runlight: there is no config file at $file");
        }
    }

    /** A setting: the environment's, else config.php's, trimmed, with nothing for an empty one. */
    public function get(string $name): ?string
    {
        $value = Env::get($name);
        if ($value !== null) {
            return $value;
        }
        $given = $this->file[$name] ?? null;
        if (is_bool($given)) {
            return $given ? 'true' : 'false';
        }
        if (!is_scalar($given)) {
            return null;
        }
        $given = trim((string) $given);
        return $given === '' ? null : $given;
    }

    /** A path from a setting, read from the project folder when it is relative. */
    private function path(string $value): string
    {
        return preg_match('#^(/|\\\\|[A-Za-z]:[\\\\/])#', $value) ? $value : "{$this->root}/$value";
    }

    /**
     * The data folder, made on first use and readable only by this user. An .htaccess in it turns Apache away
     * from it even without mod_rewrite, for when the drop-in's folder is also the project folder.
     */
    public function dataDir(): string
    {
        $dir = $this->dataPath();
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException("Runlight: could not make the data folder $dir. Make it, writable by the web server, or set DATA_DIR.");
        }
        if (!is_file("$dir/.htaccess")) {
            @file_put_contents("$dir/.htaccess", "Require all denied\n");
        }
        return $dir;
    }

    /**
     * Where the data folder could be fetched over HTTP, as a path under the web root, or null when it cannot be:
     * it is outside the web root, or Apache read the .htaccess beside index.php (which says so in
     * RUNLIGHT_HTACCESS), so its rules and the data folder's own turn requests for it away, or DATA_DIR_DENIED
     * says the web server's config does.
     *
     * @param array<string, mixed> $server the request's server variables, $_SERVER
     */
    public function exposedData(array $server): ?string
    {
        if (strtolower($this->get('DATA_DIR_DENIED') ?? '') === 'true') {
            return null;
        }
        if (isset($server['RUNLIGHT_HTACCESS']) || isset($server['REDIRECT_RUNLIGHT_HTACCESS'])) {
            return null;
        }
        $docRoot = $server['DOCUMENT_ROOT'] ?? null;
        $root = is_string($docRoot) && $docRoot !== '' ? realpath($docRoot) : false;
        $data = realpath($this->dataDir());
        if ($root === false || $data === false) {
            return null;
        }
        $root = rtrim($root, '/\\');
        if ($data !== $root && !str_starts_with($data, $root . DIRECTORY_SEPARATOR)) {
            return null;
        }
        return rtrim(str_replace('\\', '/', substr($data, strlen($root))), '/') . '/';
    }

    private function dataPath(): string
    {
        return $this->path($this->get('DATA_DIR') ?? 'runlight-data');
    }

    /** Where the data lives, for messages. */
    public function where(): string
    {
        $url = $this->get('DATABASE_URL') ?? '';
        return match (true) {
            (bool) preg_match('#^postgres(ql)?://#i', $url) => 'Postgres',
            (bool) preg_match('#^mysql://#i', $url) => 'MySQL',
            (bool) preg_match('#^mariadb://#i', $url) => 'MariaDB',
            $url !== '' => $url,
            default => $this->dataPath() . '/runlight.db',
        };
    }

    public function store(): SqlStore
    {
        if ($this->store === null) {
            $url = $this->get('DATABASE_URL');
            $this->store = $url !== null ? Stores::url($url) : Stores::sqlite($this->dataDir() . '/runlight.db');
        }
        return $this->store;
    }

    /** RUNLIGHT_SECRET, or one made on first use and kept beside the data, readable only by this user. */
    public function secret(): string
    {
        if ($this->secret !== null) {
            return $this->secret;
        }
        $given = $this->get('RUNLIGHT_SECRET');
        if ($given !== null) {
            return $this->secret = $given;
        }
        return $this->secret = self::secretIn($this->dataDir());
    }

    /** Shorter than any secret this file has ever been given, so a file caught half written is never used. */
    private const SHORTEST_SECRET = 32;

    /**
     * The secret kept in `$dir`, made on first run, readable only by this user. Two servers starting at once on
     * one folder agree on it: the new secret is written whole to a file of its own, then linked into place, which
     * refuses to replace a file already there, and the one that loses reads the winner's. A file read empty or
     * short, such as one an older version was still writing, is read again for a moment, and then refused.
     */
    public static function secretIn(string $dir): string
    {
        $file = $dir . '/secret';
        $found = self::wholeSecret($file);
        if ($found !== null) {
            return $found;
        }
        $made = bin2hex(random_bytes(32));
        $temp = $dir . '/.secret-' . getmypid() . '-' . bin2hex(random_bytes(6));
        $handle = @fopen($temp, 'x');
        if ($handle === false) {
            throw new \RuntimeException("Runlight: could not write $temp. Make the data folder writable, or set RUNLIGHT_SECRET.");
        }
        try {
            // Readable by this user alone before the secret is in it.
            @chmod($temp, 0600);
            fwrite($handle, "$made\n");
            fclose($handle);
            // link() refuses to replace a file already there, as rename() would not.
            if (@link($temp, $file)) {
                return $made;
            }
            if (is_file($file)) {
                return self::wholeSecret($file) ?? self::refuseSecret($file);
            }
            // A file system with no hard links still creates the file only if it is not there; a reader that
            // catches it before its contents land reads it again.
            $direct = @fopen($file, 'x');
            if ($direct === false) {
                return self::wholeSecret($file) ?? throw new \RuntimeException("Runlight: could not write $file. Make the data folder writable, or set RUNLIGHT_SECRET.");
            }
            @chmod($file, 0600);
            fwrite($direct, "$made\n");
            fclose($direct);
            return $made;
        } finally {
            @unlink($temp);
        }
    }

    /** The secret in a file, waiting up to two seconds for one too short to be whole; null when there is no file. */
    private static function wholeSecret(string $file): ?string
    {
        for ($tries = 0;; $tries++) {
            clearstatcache(true, $file);
            if (!is_file($file)) {
                return null;
            }
            $text = trim((string) @file_get_contents($file));
            if (strlen($text) >= self::SHORTEST_SECRET) {
                return $text;
            }
            if ($tries >= 20) {
                self::refuseSecret($file);
            }
            usleep(100_000);
        }
    }

    private static function refuseSecret(string $file): never
    {
        throw new \RuntimeException("Runlight: $file holds no whole secret. Delete it to have a new one made, which signs everyone out, or set RUNLIGHT_SECRET.");
    }

    /** The dashboard's public address, such as https://stats.example.com, or null. */
    public function url(): ?string
    {
        $url = $this->get('RUNLIGHT_URL');
        if ($url !== null && !preg_match('#^https?://[^/?\#]+/?$#D', $url)) {
            throw new \RuntimeException("Runlight: set RUNLIGHT_URL to the dashboard's address only, such as https://stats.example.com");
        }
        return $url;
    }

    /**
     * "false" with nothing in front, or the one header your proxy sets, such as cf-connecting-ip behind Cloudflare.
     * Unset stays null, so the library's default applies and it can warn when nothing sits in front.
     */
    public function trustProxy(): bool|string|null
    {
        $value = strtolower($this->get('TRUST_PROXY') ?? '');
        return $value === '' ? null : ($value === 'false' ? false : (in_array($value, ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'], true) ? $value : true));
    }

    /** DB-IP's monthly download, for RUNLIGHT_GEO city (the default) or country, or null. */
    public function dbIp(): ?DbIp
    {
        $mode = strtolower($this->get('RUNLIGHT_GEO') ?? 'city');
        return $mode === 'city' || $mode === 'country' ? new DbIp($this->dataPath() . '/geo', $mode) : null;
    }

    /** @return (callable(string): ?array)|null */
    public function geo(): ?callable
    {
        $setting = $this->get('RUNLIGHT_GEO') ?? 'city';
        $dbIp = $this->dbIp();
        if ($dbIp !== null) {
            return $dbIp->lookup();
        }
        if (strtolower($setting) === 'off') {
            return null;
        }
        $file = $this->path($setting);
        $lookup = null;
        return static function (string $ip) use ($file, &$lookup): ?array {
            $lookup ??= Geo::fileLookup($file);
            return $lookup($ip);
        };
    }

    /** The file that holds the setup link while there is no account. */
    public function setupFile(): string
    {
        return $this->dataDir() . '/setup.txt';
    }

    /**
     * The one-time code that unlocks /setup, made the first time it is asked for and written to setup.txt in the
     * data folder with the link that carries it. With RUNLIGHT_TOKEN set there is none: setup asks for the token.
     */
    public function setupCode(): ?string
    {
        if ($this->get('RUNLIGHT_TOKEN') !== null) {
            return null;
        }
        $file = $this->setupFile();
        $text = is_file($file) ? (string) file_get_contents($file) : '';
        if (preg_match('#/setup\?code=([A-Za-z0-9_-]+)#', $text, $found)) {
            return $found[1];
        }
        $code = Web::setupCode();
        $link = ($this->url() !== null ? rtrim($this->url(), '/') : 'https://your-runlight-address') . "/setup?code=$code";
        $handle = @fopen($file, 'x');
        if ($handle === false) {
            // Someone else wrote it first.
            usleep(50_000);
            $text = is_file($file) ? (string) file_get_contents($file) : '';
            if (preg_match('#/setup\?code=([A-Za-z0-9_-]+)#', $text, $found)) {
                return $found[1];
            }
            throw new \RuntimeException("Runlight: could not write $file. Make the data folder writable, or set RUNLIGHT_TOKEN.");
        }
        fwrite($handle, "Open this link to create the first Runlight account. It works only while Runlight has no account.\n$link\n");
        fclose($handle);
        @chmod($file, 0600);
        return $code;
    }

    /**
     * The standalone server these settings describe.
     *
     * @param array<string, mixed> $options more of Standalone's options, such as now or fetcher, for tests
     * @param bool $setup whether to make the setup code when there is none, as the web pages need
     */
    public function standalone(array $options = [], bool $setup = true): Standalone
    {
        $exposed = in_array(PHP_SAPI, ['cli', 'cli-server', 'phpdbg'], true) ? null : $this->exposedData($_SERVER);
        if ($exposed !== null) {
            throw new \RuntimeException("Runlight: the data folder, which holds the database and the secret, is inside the web root at $exposed, and nothing says the web server turns requests for it away, so anyone could download it. Set DATA_DIR to a folder outside the web root, or deny $exposed in the web server's config (the PHP package's README shows how for nginx and Caddy) and set DATA_DIR_DENIED=true.");
        }
        $dbIp = $this->dbIp();
        $geo = $this->geo();
        $code = $setup ? $this->setupCode() : null;
        $settings = [
            'store' => $this->store(),
            'secret' => $this->secret(),
            'token' => $this->get('RUNLIGHT_TOKEN'),
            'url' => $this->url(),
            'trustProxy' => $this->trustProxy(),
            'geoCredit' => $dbIp !== null,
            'cronSecret' => $this->get('CRON_SECRET'),
            'observeKey' => $this->get('RUNLIGHT_OBSERVE_KEY'),
            'dataDir' => $this->dataDir(),
        ];
        if ($geo !== null) {
            $settings['geo'] = $geo;
        }
        if ($code !== null) {
            $settings['setupCode'] = $code;
            $settings['setupWhere'] = true;
        }
        return new Standalone([...$settings, ...$options]);
    }
}
