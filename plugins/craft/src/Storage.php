<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use craft\helpers\FileHelper;
use Runlight\Db\PdoDb;
use Runlight\Store\SqlStore;
use Runlight\Store\Stores;

/**
 * Where Runlight keeps its numbers when it runs in this Craft site: in Craft's
 * own database, in tables prefixed rl_, when that is Postgres, MySQL 8.4, or
 * MariaDB 11.4 or later, or else in a SQLite file under Craft's storage
 * folder, which the web never serves. Runlight's tables always start rl_,
 * whatever table prefix Craft's own have.
 *
 * The choice is made the first time Runlight runs and kept in a file in that
 * folder, beside the secret Runlight signs with, so the numbers never split
 * across two places. None of it belongs in project config, which is shared
 * between environments and committed.
 */
final class Storage
{
    /** The file in the folder that keeps the choice and the secret. */
    private const FILE = 'runlight.json';

    /** The SQLite file's name, when Runlight's tables are not in Craft's database. */
    private const SQLITE = 'runlight.db';

    /** @var array<string,string>|null what the file holds, read once a request */
    private static ?array $kept = null;

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

    /** @return array<string,string> */
    private static function read(): array
    {
        if (self::$kept !== null) {
            return self::$kept;
        }
        $file = self::path() . DIRECTORY_SEPARATOR . self::FILE;
        $saved = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
        return self::$kept = is_array($saved) ? array_filter($saved, 'is_string') : [];
    }

    /** A value kept in the file, or an empty string. */
    public static function get(string $name): string
    {
        return self::read()[$name] ?? '';
    }

    /**
     * A value kept in the file, made the first time by $make. The file is locked while it is read
     * and written, so two first requests at once agree on one value.
     *
     * @param callable(): string $make
     */
    public static function remember(string $name, callable $make): string
    {
        $known = self::get($name);
        if ($known !== '') {
            return $known;
        }
        return self::change(static function (array $kept) use ($name, $make): array {
            if (($kept[$name] ?? '') === '') {
                $kept[$name] = $make();
            }
            return $kept;
        })[$name];
    }

    /**
     * @param callable(array<string,string>): array<string,string> $edit
     * @return array<string,string>
     */
    private static function change(callable $edit): array
    {
        $handle = fopen(self::folder() . DIRECTORY_SEPARATOR . self::FILE, 'c+');
        if ($handle === false) {
            throw new \RuntimeException('Runlight could not open its file in Craft’s storage folder.');
        }
        try {
            flock($handle, LOCK_EX);
            $saved = json_decode((string) stream_get_contents($handle), true);
            $kept = $edit(is_array($saved) ? array_filter($saved, 'is_string') : []);
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, (string) json_encode($kept, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            fflush($handle);
            flock($handle, LOCK_UN);
        } finally {
            fclose($handle);
        }
        // It holds the secret, so only the user PHP runs as reads it.
        @chmod(self::folder() . DIRECTORY_SEPARATOR . self::FILE, 0600);
        return self::$kept = $kept;
    }

    /**
     * Where Runlight keeps its numbers: "craft" for Craft's database, "sqlite", or an empty string
     * when this server can do neither. Worked out once, and kept once Runlight first opens its store.
     */
    public static function kind(): string
    {
        static $found = null;
        $kind = self::get('storage');
        if (in_array($kind, ['craft', 'sqlite'], true)) {
            return $kind;
        }
        return $found ??= self::craftFits() ? 'craft' : (extension_loaded('pdo_sqlite') ? 'sqlite' : '');
    }

    /** Keeps the choice, unless another request made one first, whose choice then stands. */
    private static function choose(): string
    {
        $kind = self::kind();
        if ($kind === '' || self::get('storage') === $kind) {
            return $kind;
        }
        return self::change(static function (array $kept) use ($kind): array {
            $kept['storage'] = in_array($kept['storage'] ?? '', ['craft', 'sqlite'], true) ? $kept['storage'] : $kind;
            return $kept;
        })['storage'];
    }

    /**
     * Whether Craft's own database can hold Runlight's tables: Postgres, or MySQL 8.4 or MariaDB 11.4
     * or later, whose tables compare text by code point with a collation older servers lack. A Craft
     * whose own table prefix is rl_ would share names with Runlight's, so it gets a SQLite file.
     */
    private static function craftFits(): bool
    {
        try {
            $db = Craft::$app->getDb();
            if (rtrim((string) $db->tablePrefix, '_') === 'rl') {
                return false;
            }
            if ($db->getIsPgsql()) {
                return extension_loaded('pdo_pgsql');
            }
            if (!$db->getIsMysql() || !extension_loaded('pdo_mysql')) {
                return false;
            }
            $version = (string) $db->getSchema()->getServerVersion();
            if (!preg_match('/^(\d+\.\d+)/', $version, $number)) {
                return false;
            }
            return version_compare($number[1], $db->getIsMaria() ? '11.4' : '8.4', '>=');
        } catch (\Throwable $e) {
            Craft::warning('Runlight could not read Craft’s database version: ' . $e->getMessage(), 'runlight');
            return false;
        }
    }

    /** The store Runlight runs on. */
    public static function store(): SqlStore
    {
        if (self::choose() === 'craft') {
            $dialect = Craft::$app->getDb()->getIsPgsql() ? 'postgres' : 'mysql';
            return new SqlStore(new PdoDb(\Closure::fromCallable([self::class, 'connect']), $dialect, true, $dialect === 'mysql' ? 120000 : 0));
        }
        return Stores::sqlite(self::folder() . DIRECTORY_SEPARATOR . self::SQLITE);
    }

    /**
     * A connection of Runlight's own to Craft's database, from the settings Craft connects with, set
     * up as Runlight's own stores set theirs up: Craft's connection is never shared, so neither
     * changes the other's session.
     */
    public static function connect(): \PDO
    {
        $db = Craft::$app->getDb();
        $attributes = [\PDO::ATTR_TIMEOUT => 10] + (array) $db->attributes;
        if ($db->getIsPgsql()) {
            $dsn = $db->dsn;
            // Set when the connection starts, so a RESET inside Runlight comes back to them.
            if (!str_contains($dsn, 'options=')) {
                $options = ['-c statement_timeout=120000'];
                $schema = (string) Craft::$app->getConfig()->getDb()->schema;
                if (preg_match('/^[a-z_][a-z0-9_$]*$/i', $schema)) {
                    $options[] = '-c search_path=' . $schema;
                }
                $dsn .= ";options='" . implode(' ', $options) . "'";
            }
            return new \PDO($dsn, $db->username, $db->password, $attributes);
        }
        $dsn = preg_replace('/;?charset=[^;]*/i', '', $db->dsn) . ';charset=utf8mb4';
        $ignoreSpace = defined('Pdo\Mysql::ATTR_IGNORE_SPACE') ? \Pdo\Mysql::ATTR_IGNORE_SPACE : \PDO::MYSQL_ATTR_IGNORE_SPACE;
        $pdo = new \PDO($dsn, $db->username, $db->password, $attributes + [$ignoreSpace => true]);
        $mariadb = (bool) preg_match('/mariadb/i', (string) $pdo->query('SELECT VERSION() AS v')->fetchColumn());
        $pdo->exec($mariadb ? 'SET SESSION max_statement_time = 120' : 'SET SESSION max_execution_time = 120000');
        return $pdo;
    }

    /** Removes Runlight's numbers, for uninstalling: its tables in Craft's database, and its folder. */
    public static function remove(): void
    {
        $folder = self::path();
        if (!is_dir($folder)) {
            return;
        }
        if (self::get('storage') === 'craft') {
            $db = Craft::$app->getDb();
            foreach ($db->getSchema()->getTableNames('', true) as $table) {
                if (str_starts_with($table, 'rl_')) {
                    $db->createCommand()->dropTable($table)->execute();
                }
            }
        }
        FileHelper::removeDirectory($folder);
        self::$kept = null;
    }
}
