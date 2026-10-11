<?php

declare(strict_types=1);

namespace Runlight\Tests\Store;

use Runlight\Db\Connect;
use Runlight\Db\PdoDb;
use Runlight\Db\Prefixed;
use Runlight\Store\Sql;
use Runlight\Store\SqlStore;
use Runlight\Store\Stores;

/**
 * The databases the store tests run on: SQLite always; Postgres when RUNLIGHT_TEST_PG holds a connection
 * string (each test gets a schema of its own); MySQL 8.4 and MariaDB 11.4 when RUNLIGHT_TEST_MYSQL is set
 * (each test gets a database of its own). RUNLIGHT_TEST_MYSQL may hold the URLs, separated by spaces or
 * commas; any other value means the two local test servers.
 *
 * Each also runs once with its tables under another prefix (the "-prefixed" kinds), and in a checkout of the
 * whole repository, on the WordPress plugin's drivers: SQLite3 always, and $wpdb on the first MySQL, with
 * WordPress's table prefix, as the plugin keeps them.
 */
final class Databases
{
    public const MYSQL_URLS = [
        'mysql' => 'mysql://root:runlight@127.0.0.1:33084/runlight_test',
        'mariadb' => 'mysql://root:runlight@127.0.0.1:33114/runlight_test',
    ];

    /** @var list<\Closure(): void> */
    private static array $cleanups = [];

    /** @return array<string, array{0: string}> kind => [kind], for a data provider */
    public static function kinds(): array
    {
        $kinds = [];
        foreach (self::plainKinds() as $name => $_) {
            $kinds[$name] = [$name];
            $kinds["$name-prefixed"] = ["$name-prefixed"];
        }
        if (WordPress::available()) {
            $kinds['wordpress-sqlite3'] = ['wordpress-sqlite3'];
        }
        if (self::mysqlUrls() !== [] && WordPress::mysqlAvailable()) {
            $kinds['wordpress-wpdb'] = ['wordpress-wpdb'];
        }
        return $kinds;
    }

    /**
     * The databases alone, for tests that open one from several processes or look at how a driver connects.
     *
     * @return array<string, array{0: string}>
     */
    public static function plainKinds(): array
    {
        $kinds = ['sqlite' => ['sqlite']];
        if (self::pgUrl() !== null) {
            $kinds['postgres'] = ['postgres'];
        }
        foreach (self::mysqlUrls() as $name => $_) {
            $kinds[$name] = [$name];
        }
        return $kinds;
    }

    public static function pgUrl(): ?string
    {
        $url = getenv('RUNLIGHT_TEST_PG');
        if (!is_string($url) || $url === '') {
            return null;
        }
        // Set to anything but a URL (such as 1), the local server the port's tests use.
        return str_contains($url, '://') ? $url : 'postgres://joncphillips@127.0.0.1:5432/runlight_test';
    }

    /** @return array<string, string> */
    public static function mysqlUrls(): array
    {
        $value = getenv('RUNLIGHT_TEST_MYSQL');
        if (!is_string($value) || $value === '') {
            return [];
        }
        $urls = array_values(array_filter(preg_split('/[\s,]+/', $value) ?: [], static fn (string $u): bool => str_contains($u, '://')));
        if (!$urls) {
            return self::MYSQL_URLS;
        }
        $out = [];
        foreach ($urls as $i => $url) {
            $out[$i === 0 ? 'mysql' : "mysql$i"] = $url;
        }
        return $out;
    }

    /** The prefix the "-prefixed" kinds keep their tables under, as an app sharing its database might. */
    public const PREFIX = 'app_rl_';

    /** A fresh, empty store of a kind, dropped by cleanup(). */
    public static function fresh(string $kind): SqlStore
    {
        $prefixed = str_ends_with($kind, '-prefixed');
        $kind = $prefixed ? substr($kind, 0, -strlen('-prefixed')) : $kind;
        $prefix = $prefixed ? self::PREFIX : Sql::PREFIX;
        if ($kind === 'sqlite') {
            return Stores::sqlite(['path' => ':memory:', 'prefix' => $prefix]);
        }
        if ($kind === 'wordpress-sqlite3') {
            $file = tempnam(sys_get_temp_dir(), 'rl-wp-') . '.db';
            $store = new SqlStore(WordPress::sqlite3($file));
            self::$cleanups[] = static function () use ($store, $file): void {
                $store->close();
                foreach (['', '-wal', '-shm'] as $suffix) {
                    @unlink($file . $suffix);
                }
            };
            return $store;
        }
        $name = 'rl_test_' . bin2hex(random_bytes(5));
        if ($kind === 'wordpress-wpdb') {
            // WordPress's own prefix in front of Runlight's, as the plugin names its tables.
            return new SqlStore(WordPress::wpdb(self::mysqlDatabase(array_values(self::mysqlUrls())[0], $name)), 'wp_rl_');
        }
        if ($kind === 'postgres') {
            $url = (string) self::pgUrl();
            $admin = Connect::postgres($url);
            $admin->run("CREATE SCHEMA $name");
            $store = Stores::postgres($url, ['schema' => $name, 'prefix' => $prefix]);
            self::$cleanups[] = static function () use ($store, $admin, $name): void {
                $store->close();
                $admin->run("DROP SCHEMA $name CASCADE");
                $admin->close();
            };
            return $store;
        }
        $url = self::mysqlUrls()[$kind];
        $store = Stores::mysql(self::mysqlDatabase($url, $name), ['prefix' => $prefix]);
        self::$cleanups[] = static function () use ($store): void {
            $store->close();
        };
        return $store;
    }

    /** Makes a database of its own on a MySQL server, dropped by cleanup(), and gives its URL. */
    public static function mysqlDatabase(string $url, string $name): string
    {
        $admin = Connect::mysql($url);
        $admin->run("CREATE DATABASE $name");
        self::$cleanups[] = static function () use ($admin, $name): void {
            $admin->run("DROP DATABASE IF EXISTS $name");
            $admin->close();
        };
        return (string) preg_replace('#/[^/?]*(\?|$)#', "/$name$1", $url, 1);
    }

    /** Postgres URL and schema, for a test that opens several connections to one schema. */
    public static function pgSchema(): string
    {
        $name = 'rl_test_' . bin2hex(random_bytes(5));
        $admin = Connect::postgres((string) self::pgUrl());
        $admin->run("CREATE SCHEMA $name");
        self::$cleanups[] = static function () use ($admin, $name): void {
            $admin->run("DROP SCHEMA $name CASCADE");
            $admin->close();
        };
        return $name;
    }

    /** Drops what the tests made, newest first, so each store closes before its database goes. */
    public static function cleanup(): void
    {
        while (self::$cleanups) {
            $fn = array_pop(self::$cleanups);
            try {
                $fn();
            } catch (\Throwable $error) {
                fwrite(STDERR, 'cleanup: ' . $error->getMessage() . "\n");
            }
        }
    }

    /** The PdoDb under a store. */
    public static function pdoDb(SqlStore $store): PdoDb
    {
        $db = $store->db instanceof Prefixed ? $store->db->inner : $store->db;
        if (!$db instanceof PdoDb) {
            throw new \LogicException('not a PdoDb');
        }
        return $db;
    }
}
