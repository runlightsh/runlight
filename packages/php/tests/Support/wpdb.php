<?php

declare(strict_types=1);

/**
 * A stand-in for WordPress's $wpdb with the members WpdbDb uses, over mysqli as WordPress connects: errors
 * kept in last_error rather than thrown, utf8mb4, and the session's SQL mode without the modes WordPress
 * takes out (wpdb::set_sql_mode), so Runlight's SQL meets the same server settings it meets in WordPress.
 */
class wpdb
{
    private const INCOMPATIBLE_MODES = ['NO_ZERO_DATE', 'ONLY_FULL_GROUP_BY', 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'TRADITIONAL', 'ANSI'];

    public string $last_error = '';
    public int $rows_affected = 0;
    private \mysqli $dbh;

    public function __construct(string $host, int $port, string $user, string $password, string $name)
    {
        mysqli_report(MYSQLI_REPORT_OFF);
        $this->dbh = new \mysqli($host, $user, $password, $name, $port);
        if ($this->dbh->connect_errno) {
            throw new \RuntimeException('wpdb: ' . $this->dbh->connect_error);
        }
        $this->dbh->set_charset('utf8mb4');
        $modes = explode(',', (string) $this->dbh->query('SELECT @@SESSION.sql_mode')->fetch_row()[0]);
        $modes = array_filter($modes, static fn (string $m): bool => $m !== '' && !in_array(strtoupper($m), self::INCOMPATIBLE_MODES, true));
        $this->dbh->query("SET SESSION sql_mode='" . implode(',', $modes) . "'");
    }

    public function query(string $sql): int|bool
    {
        $this->last_error = '';
        $result = $this->dbh->query($sql);
        if ($result === false) {
            $this->last_error = $this->dbh->error;
            return false;
        }
        if ($result instanceof \mysqli_result) {
            $count = $result->num_rows;
            $result->free();
            return $count;
        }
        $this->rows_affected = $this->dbh->affected_rows;
        return $this->rows_affected;
    }

    public function get_results(string $sql, string $output): ?array
    {
        $this->last_error = '';
        $result = $this->dbh->query($sql);
        if ($result === false) {
            $this->last_error = $this->dbh->error;
            return null;
        }
        if (!$result instanceof \mysqli_result) {
            return [];
        }
        $rows = $result->fetch_all(MYSQLI_ASSOC);
        $result->free();
        return $rows;
    }

    public function get_var(string $sql): ?string
    {
        $rows = $this->get_results($sql, 'ARRAY_A');
        if (!$rows) {
            return null;
        }
        $value = array_values($rows[0])[0] ?? null;
        return $value === null ? null : (string) $value;
    }

    public function _real_escape(string $value): string
    {
        return $this->dbh->real_escape_string($value);
    }
}
