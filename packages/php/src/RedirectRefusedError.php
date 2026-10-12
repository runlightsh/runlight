<?php

declare(strict_types=1);

namespace Runlight;

/** Refused before anything was sent, because a service's redirect led to another origin. */
final class RedirectRefusedError extends \RuntimeException
{
    public function __construct(public readonly string $host, public readonly string $to)
    {
        parent::__construct("$host redirected to $to. Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead");
    }
}
