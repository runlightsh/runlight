<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use craft\helpers\FileHelper;
use Runlight\Db\PdoDb;
use Runlight\Store\Sql;
use Runlight\Store\SqlStore;
use Runlight\Store\Stores;

/**
 * Where Runlight keeps its numbers when it runs in this Craft site: in Craft's own database, in tables
 * named after Craft's table prefix and rl_, such as craft_rl_events, when that is Postgres, MySQL 8.0.20,
 * or MariaDB 11.4 or later, or else in a SQLite file under Craft's storage folder, which the web never
 * serves.
 *
 * Nothing records the choice beside them, so it holds on every server and through every deploy: Runlight's
 * tables in Craft's database, once there and marked as this install's, mean Craft's database, and a SQLite
 * file in the storage folder means SQLite. Until either is made, the choice is worked out afresh. Runlight's
 * tables are made only where no table already starts as theirs would, unless those are all Runlight's own
 * and marked as this install's, so a standalone Runlight or another app sharing the database is never
 * touched, and uninstalling drops Runlight's tables by name, and only this install's.
 */
final class Storage
{
    /** The SQLite file's name, when Runlight's tables are not in Craft's database. */
    private const SQLITE = 'runlight.db';

    /** The row in Runlight's meta table that names the install whose tables they are. */
    private const OWNER = 'craft';

    /** The cache key holding the choice once it is settled, so it is not worked out on every request. */
    public const CACHE = 'runlight-storage';

    /** Runlight's statement timeout on Craft's database, in milliseconds, as its own stores set one. */
    private const TIMEOUT = 120000;

    /** @var array{kind: string, clash: bool, settled: bool}|null the choice, worked out once a request */
    private static ?array $found = null;

    /** Runlight's folder under Craft's storage folder, made the first time. */
    public static function folder(): string
    {
        $folder = self::path();
        if (!is_dir($folder)) {
            FileHelper::createDirectory($folder);
        }
        return $folder;
    }

    /** Where Runlight's folder is, whether or not it has been made. */
    private static function path(): string
    {
        return Craft::$app->getPath()->getStoragePath() . DIRECTORY_SEPARATOR . 'runlight';
    }

    /** What Runlight's table names start with in Craft's database: Craft's own table prefix, then rl_. */
    public static function prefix(): string
    {
        return Craft::$app->getDb()->tablePrefix . Sql::PREFIX;
    }

    /**
     * Runlight's tables in Craft's database, by name in lower case: the only ones it ever makes or drops.
     *
     * @return list<string>
     */
    public static function tables(): array
    {
        $prefix = strtolower(self::prefix());
        return array_map(static fn (string $table): string => $prefix . $table, Sql::TABLES);
    }

    /**
     * The tables in Craft's database whose names start as Runlight's would, by their names in lower case.
     *
     * @return array<string, string> each table's name as the database has it
     */
    private static function found(): array
    {
        $prefix = strtolower(self::prefix());
        $found = [];
        foreach (Craft::$app->getDb()->getSchema()->getTableNames('', true) as $table) {
            if (str_starts_with(strtolower((string) $table), $prefix)) {
                $found[strtolower((string) $table)] = (string) $table;
            }
        }
        return $found;
    }

    /** The id that marks Runlight's tables as this install's. */
    private static function owner(): string
    {
        return (string) Craft::$app->getSystemUid();
    }

    /**
     * Whether Runlight's tables in Craft's database are this install's own: all of them Runlight's, its
     * record of the schema there, and marked as this install's.
     *
     * @param array<string, string> $found the tables that start as Runlight's would
     */
    private static function ours(array $found): bool
    {
        $meta = strtolower(self::prefix()) . 'meta';
        if (!isset($found[$meta]) || array_diff(array_keys($found), self::tables()) !== []) {
            return false;
        }
        try {
            $owner = (new \craft\db\Query())->select(['value'])->from($found[$meta])->where(['key' => self::OWNER])->scalar();
        } catch (\Throwable) {
            return false;
        }
        return is_string($owner) && $owner !== '' && hash_equals($owner, self::owner());
    }

    /**
     * Where Runlight keeps its numbers: "craft" for Craft's database, "sqlite", or an empty string when
     * this server can do neither.
     */
    public static function kind(): string
    {
        return self::choice()['kind'];
    }

    /** Whether Craft's database would do, but tables starting as Runlight's would are another's. */
    public static function clash(): bool
    {
        return self::choice()['clash'];
    }

    /** @return array{kind: string, clash: bool, settled: bool} */
    private static function choice(): array
    {
        if (self::$found !== null) {
            return self::$found;
        }
        $cache = Craft::$app->getCache();
        $cached = $cache->get(self::CACHE);
        if (in_array($cached, ['craft', 'sqlite'], true)) {
            return self::$found = ['kind' => $cached, 'clash' => false, 'settled' => true];
        }
        $found = self::detect();
        // Once the tables or the file are there, the choice holds, so it is kept a while.
        if ($found['settled']) {
            $cache->set(self::CACHE, $found['kind'], 3600);
        }
        return self::$found = $found;
    }

    /** @return array{kind: string, clash: bool, settled: bool} */
    private static function detect(): array
    {
        $fits = self::craftFits();
        $found = [];
        try {
            $found = $fits ? self::found() : [];
        } catch (\Throwable $e) {
            Craft::warning('Runlight could not list Craft’s tables: ' . $e->getMessage(), 'runlight');
            $fits = false;
        }
        $ours = $found !== [] && self::ours($found);
        if ($ours) {
            return ['kind' => 'craft', 'clash' => false, 'settled' => true];
        }
        if (is_file(self::path() . DIRECTORY_SEPARATOR . self::SQLITE)) {
            return ['kind' => 'sqlite', 'clash' => false, 'settled' => true];
        }
        if ($fits && $found === []) {
            return ['kind' => 'craft', 'clash' => false, 'settled' => false];
        }
        return ['kind' => extension_loaded('pdo_sqlite') ? 'sqlite' : '', 'clash' => $fits, 'settled' => false];
    }

    /**
     * Whether Craft's own database can hold Runlight's tables: Postgres, or MySQL 8.0.20 or MariaDB 11.4 or
     * later, whose tables compare text by code point with a collation older servers lack.
     */
    private static function craftFits(): bool
    {
        try {
            $db = Craft::$app->getDb();
            if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,31}\z/', self::prefix())) {
                return false;
            }
            if ($db->getIsPgsql()) {
                return extension_loaded('pdo_pgsql');
            }
            if (!$db->getIsMysql() || !extension_loaded('pdo_mysql')) {
                return false;
            }
            $version = (string) $db->getSchema()->getServerVersion();
            if (!preg_match('/^(\d+\.\d+(?:\.\d+)?)/', $version, $number)) {
                return false;
            }
            return version_compare($number[1], $db->getIsMaria() ? '11.4' : '8.0.20', '>=');
        } catch (\Throwable $e) {
            Craft::warning('Runlight could not read Craft’s database version: ' . $e->getMessage(), 'runlight');
            return false;
        }
    }

    /**
     * The store Runlight runs on. The first time in Craft's database, its tables are made and marked as
     * this install's, which settles the choice; a SQLite file settles it by being made.
     */
    public static function store(): SqlStore
    {
        $choice = self::choice();
        if ($choice['kind'] === '') {
            throw new \RuntimeException('Runlight has nowhere to keep its numbers on this server.');
        }
        if ($choice['kind'] === 'sqlite') {
            return Stores::sqlite(self::folder() . DIRECTORY_SEPARATOR . self::SQLITE);
        }
        $dialect = Craft::$app->getDb()->getIsPgsql() ? 'postgres' : 'mysql';
        $store = new SqlStore(new PdoDb(\Closure::fromCallable([self::class, 'connect']), $dialect, true, $dialect === 'mysql' ? self::TIMEOUT : 0), self::prefix());
        if (!$choice['settled']) {
            $store->migrate(true);
            $store->db->run(Sql::upsert($dialect, 'rl_meta', ['"key"', 'value'], ['"key"'], ['value']), [self::OWNER, self::owner()]);
            self::$found = ['kind' => 'craft', 'clash' => false, 'settled' => true];
            Craft::$app->getCache()->set(self::CACHE, 'craft', 3600);
        }
        return $store;
    }

    /**
     * A connection of Runlight's own to Craft's database, from the settings Craft connects with, set
     * up as Runlight's own stores set theirs up: Craft's connection is never shared, so neither
     * changes the other's session or transactions.
     */
    public static function connect(): \PDO
    {
        $db = Craft::$app->getDb();
        $attributes = [\PDO::ATTR_TIMEOUT => 10] + (array) $db->attributes;
        if ($db->getIsPgsql()) {
            $dsn = $db->dsn;
            // Set when the connection starts, so a RESET inside Runlight comes back to them.
            if (!str_contains($dsn, 'options=')) {
                $options = ['-c statement_timeout=' . self::TIMEOUT];
                $schema = (string) Craft::$app->getConfig()->getDb()->schema;
                if (preg_match('/^[a-z_][a-z0-9_$]*$/iD', $schema)) {
                    $options[] = '-c search_path=' . $schema;
                }
                $dsn .= ";options='" . implode(' ', $options) . "'";
            }
            return new \PDO($dsn, $db->username, $db->password, $attributes);
        }
        $dsn = preg_replace('/;?charset=[^;]*/i', '', $db->dsn) . ';charset=utf8mb4';
        $ignoreSpace = defined('Pdo\Mysql::ATTR_IGNORE_SPACE') ? constant('Pdo\Mysql::ATTR_IGNORE_SPACE') : \PDO::MYSQL_ATTR_IGNORE_SPACE;
        $pdo = new \PDO($dsn, $db->username, $db->password, $attributes + [$ignoreSpace => true]);
        $mariadb = (bool) preg_match('/mariadb/i', (string) $pdo->query('SELECT VERSION() AS v')->fetchColumn());
        $pdo->exec($mariadb ? 'SET SESSION max_statement_time = ' . (self::TIMEOUT / 1000) : 'SET SESSION max_execution_time = ' . self::TIMEOUT);
        return $pdo;
    }

    /**
     * Removes Runlight's numbers, for uninstalling: its tables in Craft's database, each by name and only
     * when they are all Runlight's and marked as this install's, whether or not its folder is still here,
     * and its folder, with a SQLite file and location data.
     */
    public static function remove(): void
    {
        try {
            $found = self::found();
            if ($found !== [] && self::ours($found)) {
                $db = Craft::$app->getDb();
                foreach (self::tables() as $table) {
                    if (isset($found[$table])) {
                        $db->createCommand()->dropTable($found[$table])->execute();
                    }
                }
            } elseif ($found !== []) {
                Craft::warning('Runlight left the tables starting ' . self::prefix() . ' in place, since they are not all its own for this install.', 'runlight');
            }
        } catch (\Throwable $e) {
            Craft::warning('Runlight could not drop its tables: ' . $e->getMessage(), 'runlight');
        }
        if (is_dir(self::path())) {
            FileHelper::removeDirectory(self::path());
        }
        Craft::$app->getCache()->delete(self::CACHE);
        self::$found = null;
    }
}
