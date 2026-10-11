<?php

declare(strict_types=1);

namespace Runlight;

/**
 * Where Runlight writes its notes: a failed report, a lost connection, a warning about its setup. They go to PHP's
 * error log (see ErrorLog) unless an app sends them elsewhere with Log::to(), as the WordPress plugin does, which
 * writes them only while WordPress's debug log is on.
 */
final class Log
{
    /** @var (\Closure(string): void)|null */
    private static ?\Closure $handler = null;

    /** Sends every note from now on to `$handler`, or back to PHP's error log with null. */
    public static function to(?callable $handler): void
    {
        self::$handler = $handler === null ? null : \Closure::fromCallable($handler);
    }

    public static function write(string $line): void
    {
        if (self::$handler !== null) {
            (self::$handler)($line);
            return;
        }
        ErrorLog::write($line);
    }
}
