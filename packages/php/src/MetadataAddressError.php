<?php

declare(strict_types=1);

namespace Runlight;

/** Refused before anything was fetched, because the address is link-local or a cloud's metadata service. */
final class MetadataAddressError extends \RuntimeException
{
    public function __construct(public readonly string $host)
    {
        parent::__construct("$host is a link-local or cloud metadata address, which Runlight never connects to");
    }
}
