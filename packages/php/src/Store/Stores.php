<?php

declare(strict_types=1);

namespace Runlight\Store;

use Runlight\Db\Connect;
use Runlight\Db\Db;
use Runlight\Db\MysqlText;
use Runlight\Db\PdoDb;

/**
 * The stores stores/sqlite.ts, stores/postgres.ts, and stores/mysql.ts make, over PDO. Tables are prefixed
 * `rl_`, so the database can be the app's own, and a database made by the TypeScript SDK opens here. Each
 * takes a `prefix` option to use in place of `rl_`, so two apps sharing a database keep a set each.
 */
final class Stores
{
    /**
     * Runlight's tables in a SQLite file (or ":memory:"), in WAL mode, as better-sqlite3 opens it there.
     *
     * @param string|array{path: string, prefix?: string} $path
     */
    public static function sqlite(string|array $path): SqlStore
    {
        return new SqlStore(Connect::sqlite(is_array($path) ? (string) $path['path'] : $path), is_array($path) ? self::prefix($path) : Sql::PREFIX);
    }

    /**
     * Runlight's tables in Postgres, from a connection string, or a PDO the app already has (Runlight never
     * closes a connection it did not open). Options: `statementTimeout`, the longest one statement may run on
     * a connection Runlight opens, in milliseconds (default 120000, 0 for no limit), and `schema`, the search
     * path for one it opens.
     *
     * @param array{statementTimeout?: int, schema?: string, prefix?: string} $options
     */
    public static function postgres(string|\PDO $url, array $options = []): SqlStore
    {
        if ($url instanceof \PDO) {
            return new SqlStore(new PdoDb($url, 'postgres', false), self::prefix($options));
        }
        if ($url === '') {
            throw new \InvalidArgumentException('Runlight: postgres() needs a url or a pool');
        }
        return new SqlStore(Connect::postgres($url, (int) ($options['statementTimeout'] ?? 120_000), $options['schema'] ?? null), self::prefix($options));
    }

    /**
     * Runlight's tables in MySQL 8.0.20 or MariaDB 11.4 and later, from a mysql:// or mariadb:// URL, or a PDO
     * the app already has. Text is utf8mb4 with a binary collation, so it compares and sorts by code point,
     * case and trailing spaces included, as SQLite and Postgres do. Option: `statementTimeout`, in
     * milliseconds (default 120000, 0 for no limit), which MySQL applies to reads only and MariaDB to every
     * statement.
     *
     * @param array{statementTimeout?: int, prefix?: string} $options
     */
    public static function mysql(string|\PDO $url, array $options = []): SqlStore
    {
        if ($url instanceof \PDO) {
            return new SqlStore(new PdoDb($url, 'mysql', false), self::prefix($options));
        }
        if ($url === '') {
            throw new \InvalidArgumentException('Runlight: mysql() needs a url or a pool');
        }
        return new SqlStore(Connect::mysql($url, (int) ($options['statementTimeout'] ?? 120_000)), self::prefix($options));
    }

    /**
     * The store a DATABASE_URL names, as the standalone server picks one: postgres:// or postgresql:// for
     * Postgres, mysql:// or mariadb:// for MySQL, and sqlite: or file: followed by a path for SQLite.
     */
    public static function url(string $databaseUrl): SqlStore
    {
        return new SqlStore(Connect::url($databaseUrl));
    }

    /** A store over any Db, with its tables under `$prefix` in place of `rl_` when one is given. */
    public static function fromDb(Db $db, string $prefix = Sql::PREFIX): SqlStore
    {
        return new SqlStore($db, $prefix);
    }

    /** The `prefix` option, or `rl_`. */
    private static function prefix(array $options): string
    {
        return isset($options['prefix']) ? (string) $options['prefix'] : Sql::PREFIX;
    }

    /**
     * SQL written for SQLite and Postgres as MySQL and MariaDB read it, with each `?` filled in by `$escape`
     * (mysql2's escaping by default). See MysqlText::of().
     *
     * @param list<mixed> $params
     * @param (callable(mixed): string)|null $escape
     */
    public static function mysqlText(string $sql, array $params = [], ?callable $escape = null): string
    {
        return MysqlText::of($sql, $params, $escape);
    }
}
