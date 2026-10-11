<?php

declare(strict_types=1);

namespace Runlight\Db;

/**
 * Another process held the lock for creating tables past the wait, such as one building an index on a big table
 * after an upgrade. The request that waited fails with this, rather than waiting for good.
 *
 * A Db's exclusive() waits for its lock at most wait() seconds and then throws this. The wait is WAIT, or less
 * while a tracker hit runs init(), which waits a moment at most and then drops the hit.
 */
final class TablesBusy extends \RuntimeException
{
    /** The longest a process waits for another one creating or upgrading the tables before it gives up, in seconds. */
    public const WAIT = 30;

    private static ?float $tests = null;
    private static ?float $limit = null;

    public function __construct(float $waited = self::WAIT)
    {
        parent::__construct('Runlight: another process is creating or upgrading the tables, and had not finished after ' . (int) round($waited) . ' seconds. Try again in a minute.');
    }

    /** How long exclusive() waits for the lock for creating tables, in seconds: WAIT, unless a test or atMost() has set less. */
    public static function wait(): float
    {
        return min(self::$tests ?? self::WAIT, self::$limit ?? INF);
    }

    /**
     * Runs `$fn` with the wait for the lock at most `$seconds`, as for a tracker hit, which should not hold its
     * request for the full wait.
     *
     * @template T
     * @param callable(): T $fn
     * @return T
     */
    public static function atMost(float $seconds, callable $fn): mixed
    {
        $was = self::$limit;
        self::$limit = min($seconds, $was ?? INF);
        try {
            return $fn();
        } finally {
            self::$limit = $was;
        }
    }

    /** For tests: exclusive() waits this many seconds instead, or WAIT again with null. */
    public static function inTests(?float $seconds): void
    {
        self::$tests = $seconds;
    }
}
