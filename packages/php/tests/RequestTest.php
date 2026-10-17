<?php

declare(strict_types=1);

namespace Runlight\Tests;

use PHPUnit\Framework\TestCase;
use Runlight\Http\Request;

/** Request::fromServer, which reads the request the web server hands to PHP. */
final class RequestTest extends TestCase
{
    /** @param array<string, string> $extra */
    private static function url(array $extra): string
    {
        $stream = fopen('php://memory', 'rb');
        return Request::fromServer(['REQUEST_METHOD' => 'GET', 'HTTP_HOST' => 'stats.example.com', 'REQUEST_URI' => '/runlight/?a=1', ...$extra], $stream ?: null)->url;
    }

    public function testTheSchemeIsHttpsWhenTheServerSaysSoOrAProxyDoes(): void
    {
        $this->assertSame('http://stats.example.com/runlight/?a=1', self::url([]));
        $this->assertSame('https://stats.example.com/runlight/?a=1', self::url(['HTTPS' => 'on']));
        $this->assertSame('http://stats.example.com/runlight/?a=1', self::url(['HTTPS' => 'off']));
        // The first x-forwarded-proto counts, as the Node adapter reads it, over the connection's own.
        $this->assertSame('https://stats.example.com/runlight/?a=1', self::url(['HTTP_X_FORWARDED_PROTO' => 'https']));
        $this->assertSame('https://stats.example.com/runlight/?a=1', self::url(['HTTP_X_FORWARDED_PROTO' => ' HTTPS , http']));
        $this->assertSame('http://stats.example.com/runlight/?a=1', self::url(['HTTP_X_FORWARDED_PROTO' => 'http, https']));
        $this->assertSame('http://stats.example.com/runlight/?a=1', self::url(['HTTPS' => 'on', 'HTTP_X_FORWARDED_PROTO' => 'http']));
        $this->assertSame('https://stats.example.com/runlight/?a=1', self::url(['HTTPS' => 'on', 'HTTP_X_FORWARDED_PROTO' => '']));
    }
}
