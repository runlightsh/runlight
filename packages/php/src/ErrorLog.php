<?php

declare(strict_types=1);

namespace Runlight;

/** Where Log writes when an app has not sent the notes elsewhere: PHP's own error log. */
final class ErrorLog
{
    public static function write(string $line): void
    {
        error_log($line);
    }
}
