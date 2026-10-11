<?php

declare(strict_types=1);

namespace Runlight\Db;

/**
 * A Db whose tables and indexes start with a prefix of the app's choosing in place of `rl_`, such as
 * `wp_rl_` inside WordPress, so two apps sharing one database each keep a set of their own. Runlight's SQL
 * names every table and index `rl_` and something, and those names alone are rewritten on the way through,
 * in each statement and in the names a schema check compares as text. SqlStore puts one in front of its Db
 * when given a prefix, so the accounts and importers that reach the Db through the store follow it too.
 */
final class Prefixed implements Db
{
    public function __construct(public readonly Db $inner, public readonly string $prefix)
    {
        // A name in a statement, and short enough that the longest index name stays inside MySQL's 64.
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,31}\z/', $prefix)) {
            throw new \InvalidArgumentException('Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit');
        }
    }

    /** A statement with each of Runlight's names under the prefix. */
    public function sql(string $sql): string
    {
        return (string) preg_replace('/\brl_(?=[a-z])/', $this->prefix, $sql);
    }

    public function dialect(): string
    {
        return $this->inner->dialect();
    }

    public function all(string $sql, array $params = []): array
    {
        return $this->inner->all($this->sql($sql), $params);
    }

    public function run(string $sql, array $params = []): void
    {
        $this->inner->run($this->sql($sql), $params);
    }

    /** How many rows an UPDATE or DELETE matched, counted by the Db underneath when it can, as SqlStore asks. */
    public function affected(string $sql, array $params = []): int
    {
        if (method_exists($this->inner, 'affected')) {
            return $this->inner->affected($this->sql($sql), $params);
        }
        return count($this->inner->all($this->sql("$sql RETURNING 1"), $params));
    }

    /** Whether the Db underneath is reached one statement at a time with a cap on statements (Cloudflare D1). */
    public function metered(): bool
    {
        return method_exists($this->inner, 'metered') && $this->inner->metered();
    }

    public function transaction(callable $fn): mixed
    {
        return $this->inner->transaction(fn (Db $db) => $fn($db === $this->inner ? $this : new self($db, $this->prefix)));
    }

    public function exclusive(callable $fn): mixed
    {
        return $this->inner->exclusive(fn (Db $db) => $fn($db === $this->inner ? $this : new self($db, $this->prefix)));
    }

    public function close(): void
    {
        $this->inner->close();
    }
}
