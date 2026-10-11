<?php

declare(strict_types=1);

namespace Runlight\Tests;

use PHPUnit\Framework\TestCase;
use Runlight\Body;
use Runlight\Http\BodyTooLong;
use Runlight\Http\CurlFetcher;
use Runlight\Http\FetchError;
use Runlight\Http\Response;
use Runlight\Tests\Support\LocalServer;

/**
 * Capped reads: Body's checks, and the Fetcher's maxBytes, truncate, and resolve against a real server. The same
 * server checks what Response::emit() sends and what Request::fromGlobals() reads.
 */
final class BodyTest extends TestCase
{
    private static ?LocalServer $server = null;
    private static int $port = 0;

    public static function setUpBeforeClass(): void
    {
        self::$server = new LocalServer();
        self::$port = self::$server->port;
    }

    public static function tearDownAfterClass(): void
    {
        self::$server?->stop();
    }

    public function testTextIsReadUpToTheCap(): void
    {
        $this->assertSame('hello', Body::readTextCapped(new Response('hello'), 5));
        $this->assertSame(['a' => 1], Body::readJsonCapped(new Response('{"a":1}'), 100, true));
        $this->assertEquals((object) ['a' => 1], Body::readJsonCapped(new Response('{"a":1}'), 100));
        $this->assertSame("a\u{FFFD}b", Body::readTextCapped(new Response("a\xffb"), 10), 'as TextDecoder reads bytes that are not UTF-8');
        $this->assertSame('x', Body::readTextCapped(new Response("\xEF\xBB\xBFx"), 10));
        $this->expectException(BodyTooLong::class);
        $this->expectExceptionMessage('Body over 4 bytes');
        Body::readTextCapped(new Response('hello'), 4);
    }

    public function testADeclaredLengthOverTheCapIsRefusedUnread(): void
    {
        $this->expectException(BodyTooLong::class);
        Body::readTextCapped(new Response('', 200, ['content-length' => '1000']), 10);
    }

    public function testTheFetcherStopsReadingPastMaxBytes(): void
    {
        $fetcher = new CurlFetcher();
        $url = 'http://127.0.0.1:' . self::$port . '/bytes?n=300000';
        $this->assertSame(300_000, strlen($fetcher->fetch($url, ['maxBytes' => 300_000])->text()));
        try {
            $fetcher->fetch($url, ['maxBytes' => 100_000]);
            $this->fail('a body past maxBytes is refused');
        } catch (BodyTooLong $error) {
            $this->assertSame('Body over 100000 bytes', $error->getMessage());
        }
        $start = $fetcher->fetch($url, ['maxBytes' => 100_000, 'truncate' => true]);
        $this->assertSame(200, $start->status);
        $this->assertSame(str_repeat('a', 100_000), $start->text(), 'with truncate, the start comes back');
        $this->assertSame('text/html', explode(';', (string) $start->headers->get('content-type'))[0]);
    }

    public function testTheFetcherConnectsToThePinnedAddress(): void
    {
        $port = self::$port;
        $answer = (new CurlFetcher())->fetch("http://pinned.invalid:$port/", ['resolve' => ["pinned.invalid:$port:127.0.0.1"]]);
        $this->assertSame("host pinned.invalid:$port", $answer->text());
    }

    public function testAPinThatCannotBeAppliedRefusesTheFetchRatherThanLookingTheNameUpAgain(): void
    {
        $port = self::$port;
        $streams = new \ReflectionMethod(CurlFetcher::class, 'viaStreams');
        foreach ([
            'another host' => ["http://pinned.invalid:$port/", ["other.invalid:$port:127.0.0.1"]],
            'another port' => ["http://pinned.invalid:$port/", ['pinned.invalid:' . ($port + 1) . ':127.0.0.1']],
            'no port given means 80' => ['http://pinned.invalid/', ["pinned.invalid:$port:127.0.0.1"]],
        ] as $what => [$url, $pins]) {
            foreach (['curl' => fn () => (new CurlFetcher())->fetch($url, ['resolve' => $pins]), 'streams' => fn () => $streams->invoke(new CurlFetcher(), $url, ['resolve' => $pins])] as $how => $fetch) {
                try {
                    $fetch();
                    $this->fail("$what ($how) should be refused");
                } catch (FetchError $error) {
                    $this->assertStringContainsString('so it is not fetched', $error->getMessage(), "$what ($how)");
                }
            }
        }
    }

    public function testAPinnedRequestGoesThroughNoProxyEvenOneTheEnvironmentNames(): void
    {
        $port = self::$port;
        // A proxy that would look the name up itself. Nothing may connect to it.
        $proxy = stream_socket_server('tcp://127.0.0.1:0');
        $address = 'http://' . stream_socket_get_name($proxy, false);
        $saved = [];
        foreach (['http_proxy', 'HTTPS_PROXY', 'ALL_PROXY'] as $name) {
            $saved[$name] = getenv($name);
            putenv("$name=$address");
        }
        try {
            $answer = (new CurlFetcher())->fetch("http://pinned.invalid:$port/", ['resolve' => ["pinned.invalid:$port:127.0.0.1"], 'timeoutMs' => 5000]);
            $this->assertSame("host pinned.invalid:$port", $answer->text());
            $read = [$proxy];
            $write = $except = null;
            $this->assertSame(0, stream_select($read, $write, $except, 0), 'nothing went through the proxy');
        } finally {
            foreach ($saved as $name => $value) {
                putenv($value === false ? $name : "$name=$value");
            }
            fclose($proxy);
        }
    }

    public function testAPinnedRequestFollowsARedirectOnlyToAPinnedAddress(): void
    {
        $port = self::$port;
        $pins = ['resolve' => ["pinned.invalid:$port:127.0.0.1"]];
        $streams = new \ReflectionMethod(CurlFetcher::class, 'viaStreams');
        $same = "http://pinned.invalid:$port/redirect?to=" . rawurlencode("http://pinned.invalid:$port/");
        $this->assertSame("host pinned.invalid:$port", (new CurlFetcher())->fetch($same, $pins)->text(), 'the same host and port keep their pin');
        $manual = (new CurlFetcher())->fetch($same, [...$pins, 'redirect' => 'manual']);
        $this->assertSame(302, $manual->status);
        $elsewhere = "http://pinned.invalid:$port/redirect?to=" . rawurlencode("http://elsewhere.invalid:$port/");
        try {
            (new CurlFetcher())->fetch($elsewhere, $pins);
            $this->fail('a redirect to a name with no pin is refused');
        } catch (FetchError $error) {
            $this->assertSame("Runlight: no checked address is pinned for elsewhere.invalid:$port, so it is not fetched", $error->getMessage());
        }
        $this->assertSame(302, $streams->invoke(new CurlFetcher(), $elsewhere, [...$pins, 'redirect' => 'manual'])->status, 'the stream fallback follows nothing by itself');
    }

    public function testTheStreamFallbackConnectsToThePinnedAddressAndCapsToo(): void
    {
        $port = self::$port;
        $streams = new \ReflectionMethod(CurlFetcher::class, 'viaStreams');
        $answer = $streams->invoke(new CurlFetcher(), "http://pinned.invalid:$port/", ['resolve' => ["pinned.invalid:$port:127.0.0.1"]]);
        $this->assertSame("host pinned.invalid:$port", $answer->text());
        $start = $streams->invoke(new CurlFetcher(), "http://127.0.0.1:$port/bytes?n=50000", ['maxBytes' => 1000, 'truncate' => true]);
        $this->assertSame(str_repeat('a', 1000), $start->text());
        $this->expectException(BodyTooLong::class);
        $streams->invoke(new CurlFetcher(), "http://127.0.0.1:$port/bytes?n=50000", ['maxBytes' => 1000]);
    }

    /** The status line and headers of an answer from the test server, lower-cased names to values. */
    private static function headersOf(string $path): array
    {
        $socket = stream_socket_client('tcp://127.0.0.1:' . self::$port, $errno, $errstr, 5);
        fwrite($socket, "GET $path HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
        $answer = (string) stream_get_contents($socket);
        fclose($socket);
        $lines = explode("\r\n", explode("\r\n\r\n", $answer, 2)[0]);
        $headers = ['status' => explode(' ', array_shift($lines))[1]];
        foreach ($lines as $line) {
            [$name, $value] = explode(':', $line, 2);
            $headers[strtolower($name)] = trim($value);
        }
        return $headers;
    }

    public function testEmitSendsNoContentTypeForAnAnswerWithoutOneAndLeavesTheRestAlone(): void
    {
        $untyped = self::headersOf('/emit/untyped');
        $this->assertSame('202', $untyped['status']);
        $this->assertArrayNotHasKey('content-type', $untyped, 'PHP adds no default type');
        $this->assertSame('no-store', $untyped['cache-control']);
        $this->assertSame('application/json', self::headersOf('/emit/typed')['content-type']);
        $this->assertSame('text/x-app;charset=UTF-8', self::headersOf('/emit/app-typed')['content-type'], 'a type the app set first stays');
    }

    public function testFromGlobalsReadsTheRequestAsSent(): void
    {
        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => "Content-Type: text/plain\r\nUser-Agent: Bot \"quoted\" O'Brien\r\nCookie: a=\"b\"",
            'content' => 'it\'s "here"',
        ]]);
        $answer = json_decode((string) file_get_contents('http://127.0.0.1:' . self::$port . "/request?q=it's", false, $context), true);
        $this->assertSame('http://127.0.0.1:' . self::$port . "/request?q=it's", $answer['url']);
        $this->assertSame('POST', $answer['method']);
        $this->assertSame(['Bot "quoted" O\'Brien'], $answer['headers']['user-agent']);
        $this->assertSame(['a="b"'], $answer['headers']['cookie']);
        $this->assertSame('it\'s "here"', $answer['body']);
    }
}
