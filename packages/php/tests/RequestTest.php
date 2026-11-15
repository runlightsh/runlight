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

    public function testTheRequestTargetNeverChoosesTheHost(): void
    {
        // A target is a path and a query, whatever it looks like, so the host and origin stay the server's own.
        foreach (['//evil.example/oauth/authorize', '/\\evil.example/x', '\\\\evil.example/x', 'http://evil.example/x?a=1', 'HTTPS://evil.example', '@evil.example/x', 'evil.example/x'] as $target) {
            $url = new \Runlight\Http\Url(self::url(['REQUEST_URI' => $target]));
            $this->assertSame('http://stats.example.com', $url->origin(), $target);
        }
        $this->assertSame('http://stats.example.com/x?a=1', self::url(['REQUEST_URI' => 'http://evil.example/x?a=1']));
        $this->assertSame('http://stats.example.com//evil.example/oauth/authorize', self::url(['REQUEST_URI' => '//evil.example/oauth/authorize']));
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
