<?php

declare(strict_types=1);

namespace Runlight\Db;

use Runlight\Json;

/**
 * SQL written for SQLite and Postgres, as MySQL and MariaDB read it, with no PDO, so a driver over another
 * connection (the WordPress plugin's $wpdb) turns statements into MySQL's form the same way PdoDb does: a
 * "quoted" identifier is quoted with backticks, and a backslash inside 'text' is doubled, since MySQL reads it
 * as an escape where standard SQL takes it literally.
 */
final class MysqlText
{
    /**
     * `$sql` as MySQL reads it. With `$params`, each `?` outside quotes becomes its value through `$escape`
     * (literal() by default), as mysql2 fills them in; without, the placeholders stay for the driver. A backslash
     * inside 'text' is doubled unless `$backslashEscapes` is false, for a session in NO_BACKSLASH_ESCAPES mode,
     * where a backslash is only itself.
     *
     * @param list<mixed>|null $params
     * @param (callable(mixed): string)|null $escape
     */
    public static function of(string $sql, ?array $params = null, ?callable $escape = null, bool $backslashEscapes = true): string
    {
        $out = '';
        $n = 0;
        $quote = null;
        $length = strlen($sql);
        for ($i = 0; $i < $length; $i++) {
            $ch = $sql[$i];
            if ($quote !== null) {
                if ($ch === $quote) {
                    $quote = null;
                    $out .= $ch === '"' ? '`' : $ch;
                } elseif ($quote === "'" && $ch === '\\' && $backslashEscapes) {
                    $out .= '\\\\';
                } elseif ($quote === '"' && $ch === '`') {
                    $out .= '``';
                } else {
                    $out .= $ch;
                }
            } elseif ($ch === "'" || $ch === '"' || $ch === '`') {
                $quote = $ch;
                $out .= $ch === '"' ? '`' : $ch;
            } elseif ($ch === '?' && $params !== null) {
                if ($n >= count($params)) {
                    throw new \InvalidArgumentException('Runlight: a statement has more placeholders than values');
                }
                $out .= ($escape ?? self::literal(...))($params[$n++]);
            } else {
                $out .= $ch;
            }
        }
        if ($params !== null && $n !== count($params)) {
            throw new \InvalidArgumentException('Runlight: a statement has more values than placeholders');
        }
        return $out;
    }

    /** A value as a MySQL literal, as mysql2's escape() writes the values Runlight binds. */
    public static function literal(mixed $value): string
    {
        return match (true) {
            $value === null => 'NULL',
            is_bool($value) => $value ? 'true' : 'false',
            is_int($value) => (string) $value,
            is_float($value) => Json::number($value),
            default => "'" . strtr((string) $value, ["\0" => '\\0', "\x08" => '\\b', "\t" => '\\t', "\x1a" => '\\Z', "\n" => '\\n', "\r" => '\\r', '"' => '\\"', "'" => "\\'", '\\' => '\\\\']) . "'",
        };
    }
}
