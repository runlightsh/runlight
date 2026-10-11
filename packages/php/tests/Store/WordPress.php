<?php

declare(strict_types=1);

namespace Runlight\Tests\Store;

use Runlight\Db\Db;

/**
 * The WordPress plugin's own drivers (plugins/wordpress/includes), so the store tests run on what the plugin
 * runs on: PHP's SQLite3 rather than PDO, and MySQL through $wpdb, here a small stand-in over mysqli with the
 * few members WpdbDb uses. Neither is there outside a checkout of the whole repository.
 */
final class WordPress
{
    private static function includes(): string
    {
        return dirname(__DIR__, 4) . '/plugins/wordpress/includes';
    }

    public static function available(): bool
    {
        return is_file(self::includes() . '/Sqlite3Db.php') && class_exists(\SQLite3::class);
    }

    public static function mysqlAvailable(): bool
    {
        return is_file(self::includes() . '/WpdbDb.php') && class_exists(\mysqli::class);
    }

    private static function load(): void
    {
        if (!defined('ABSPATH')) {
            define('ABSPATH', sys_get_temp_dir() . '/');
        }
        if (!defined('ARRAY_A')) {
            define('ARRAY_A', 'ARRAY_A');
        }
        if (!class_exists(\wpdb::class, false)) {
            require __DIR__ . '/../Support/wpdb.php';
        }
        require_once self::includes() . '/Sqlite3Db.php';
        require_once self::includes() . '/WpdbDb.php';
    }

    /** The plugin's SQLite3 driver over a new file, as the plugin keeps one in uploads. */
    public static function sqlite3(string $file): Db
    {
        self::load();
        return new \Runlight\WordPress\Sqlite3Db($file);
    }

    /** The plugin's $wpdb driver over a database a mysql:// URL names. */
    public static function wpdb(string $url): Db
    {
        self::load();
        $parts = parse_url($url);
        $wpdb = new \wpdb(
            (string) ($parts['host'] ?? '127.0.0.1'),
            (int) ($parts['port'] ?? 3306),
            rawurldecode((string) ($parts['user'] ?? 'root')),
            rawurldecode((string) ($parts['pass'] ?? '')),
            rawurldecode(ltrim((string) ($parts['path'] ?? ''), '/')),
        );
        return new \Runlight\WordPress\WpdbDb($wpdb);
    }
}
