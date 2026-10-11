<?php

declare(strict_types=1);

namespace Runlight\Http;

/**
 * The one place the package reads the request PHP is serving from its superglobals, for Request::fromGlobals().
 * A host that keeps its own copy of them, such as WordPress, which adds slashes to $_SERVER, passes that copy to
 * Request::fromServer() instead.
 */
final class Globals
{
    /** @throws BodyTooLarge past the body's limit */
    public static function request(): Request
    {
        return Request::fromServer($_SERVER);
    }
}
