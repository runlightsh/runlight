<?php

declare(strict_types=1);

namespace Runlight\Tests;

use PHPUnit\Framework\TestCase;
use Runlight\Assistant;
use Runlight\AssistantError;
use Runlight\Http\CurlFetcher;
use Runlight\Http\FetchError;
use Runlight\Http\Response;
use Runlight\Mail\MailError;
use Runlight\Mail\Transports;
use Runlight\MetadataAddressError;
use Runlight\PrivateAddressError;
use Runlight\RedirectRefusedError;
use Runlight\Safefetch;
use Runlight\Tests\Support\FakeFetcher;
use Runlight\Tests\Support\LocalServer;

/** Ports safefetch.test.ts, replays the address checks in tests/fixtures/outbound.json, and covers each hop's checks. */
final class SafefetchTest extends TestCase
{
    /** A DNS stand-in. */
    private static function dns(array $names): \Closure
    {
        return static fn (string $name): array => $names[$name] ?? [];
    }

    public function testLinkLocalAndCloudMetadataAddressesAreToldApartFromLoopbackAndPrivateOnes(): void
    {
        foreach (['169.254.169.254', '169.254.0.1', '100.100.100.200', 'fe80::1', 'fe80::a9fe:a9fe', 'fd00:ec2::254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '::ffff:0:a9fe:a9fe'] as $ip) {
            $this->assertTrue(Safefetch::metadataAddress($ip), $ip);
        }
        foreach (['127.0.0.1', '::1', '10.0.0.5', '192.168.1.20', 'fd00::1', 'fd00:ec2::253', '93.184.215.14', 'not an address'] as $ip) {
            $this->assertFalse(Safefetch::metadataAddress($ip), $ip);
        }
        $this->assertTrue(Safefetch::metadataHost('metadata.google.internal'));
        $this->assertTrue(Safefetch::metadataHost('[fd00:ec2::254]'));
        $this->assertTrue(Safefetch::metadataHost('169.254.169.254'));
        $this->assertFalse(Safefetch::metadataHost('localhost'), 'a model on this computer is fine');
        $this->assertFalse(Safefetch::metadataHost('192.168.1.20'));
        $this->assertTrue(Safefetch::metadataHost('rebind.example', self::dns(['rebind.example' => ['93.184.215.14', '169.254.169.254']])), 'any address the name resolves to');
    }

    public function testOnlyAddressesOnThePublicInternetCountAsPublic(): void
    {
        foreach (['93.184.215.14', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:82a::200e', '::ffff:0:808:808', '64:ff9b::808:808'] as $ip) {
            $this->assertTrue(Safefetch::publicAddress($ip), $ip);
        }
        foreach ([
            '127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
            '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a00:1',
            '2002:a00:1::', '2001:db8::1', '2001:0:4136:e378::1', '[::1]', 'not an address', '1.2.3', '1.2.3.256',
            // IPv4-translated loopback, local-use NAT64, the old site-local, ORCHID, the newer documentation prefix, and discard.
            '::ffff:0:7f00:1', '64:ff9b:1::7f00:1', 'fec0::1', '2001:20::1', '3fff::1', '100::1',
        ] as $ip) {
            $this->assertFalse(Safefetch::publicAddress($ip), $ip);
        }
    }

    public function testAnInstallOnThisMachineIsOnlyHttpLocalhostOrLoopbackAndNothingAfterIt(): void
    {
        foreach (['https://example.com/runlight', 'https://example.com'] as $url) {
            $this->assertTrue(Safefetch::installAddress($url, false), $url);
        }
        foreach (['http://127.0.0.1:8080/runlight', 'http://localhost', 'http://example.com', 'ftp://example.com'] as $url) {
            $this->assertFalse(Safefetch::installAddress($url, false), $url);
        }
        foreach (['http://127.0.0.1:8080/runlight', 'http://localhost', 'http://localhost:3000/runlight'] as $url) {
            $this->assertTrue(Safefetch::installAddress($url, true), $url);
        }
        // A trailing newline cannot pass for the end of the address.
        foreach (['http://10.0.0.1', 'http://localhost.example.com', 'http://localhost@example.com', 'http://127.0.0.1:80@example.com', "http://localhost\n", "http://127.0.0.1:80\n"] as $url) {
            $this->assertFalse(Safefetch::installAddress($url, true), $url);
        }
    }

    public function testAddressChecksMatchTypeScript(): void
    {
        foreach (MailTest::fixture()['ips'] as $case) {
            $this->assertSame($case['public'], Safefetch::publicAddress($case['ip']), $case['ip']);
        }
    }

    public function testAPublicFetchNeverReachesTheInstallsOwnNetworkHoweverTheAddressIsWritten(): void
    {
        // Something listening locally, which none of these may reach.
        $inside = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) explode(':', stream_socket_get_name($inside, false))[1];
        try {
            foreach (["http://127.0.0.1:$port/", "https://127.0.0.1:$port/", "https://[::1]:$port/", "https://[::ffff:127.0.0.1]:$port/", "https://localhost:$port/", "https://LOCALHOST.:$port/", "https://app.localhost:$port/"] as $url) {
                try {
                    Safefetch::publicFetch($url, ['timeoutMs' => 2000]);
                    $this->fail("$url should be refused");
                } catch (PrivateAddressError) {
                    $this->addToAssertionCount(1);
                }
            }
            $read = [$inside];
            $write = $except = null;
            $this->assertSame(0, stream_select($read, $write, $except, 0), 'nothing connected');
            $this->assertTrue(Safefetch::resolvesPrivately('localhost'));
            $this->assertFalse(Safefetch::resolvesPrivately('name.that.does.not.resolve.invalid'));
            $this->assertSame([], Safefetch::publicAddresses('name.that.does.not.resolve.invalid'));
            $this->assertSame(['8.8.8.8'], Safefetch::publicAddresses('8.8.8.8'));
            $this->assertSame([], Safefetch::publicAddresses('localhost'));
        } finally {
            fclose($inside);
        }
    }

    public function testTheCheckedAddressesArePinned(): void
    {
        $fetcher = new FakeFetcher(static fn () => new Response('ok'));
        $answer = Safefetch::publicFetch('https://Example.com/icon', ['timeoutMs' => 2000, 'headers' => ['user-agent' => 'Runlight'], 'maxBytes' => 10, 'lookup' => self::dns(['example.com' => ['93.184.215.14', '2606:4700::1111']])], $fetcher);
        $this->assertSame('ok', $answer->text());
        $this->assertSame(['example.com:443:93.184.215.14,[2606:4700::1111]'], $fetcher->inits[0]['resolve']);
        $this->assertSame('manual', $fetcher->inits[0]['redirect']);
        $this->assertSame(10, $fetcher->inits[0]['maxBytes']);
        $this->assertSame(['method' => 'GET', 'url' => 'https://example.com/icon', 'headers' => ['user-agent' => 'Runlight'], 'body' => ''], $fetcher->requests[0]);

        $literal = new FakeFetcher(static fn () => new Response('ok'));
        Safefetch::publicFetch('https://93.184.215.14:8443/', ['timeoutMs' => 2000, 'lookup' => self::dns([])], $literal);
        $this->assertArrayNotHasKey('resolve', $literal->inits[0], 'an address needs no pin');
    }

    public function testANameWithAnyPrivateAddressIsRefused(): void
    {
        $fetcher = new FakeFetcher(static fn () => new Response('ok'));
        foreach (['inside.example' => ['10.0.0.5'], 'mixed.example' => ['93.184.215.14', '169.254.169.254'], 'mapped.example' => ['::ffff:127.0.0.1']] as $name => $addresses) {
            try {
                Safefetch::publicFetch("https://$name/", ['timeoutMs' => 2000, 'lookup' => self::dns([$name => $addresses])], $fetcher);
                $this->fail("$name should be refused");
            } catch (PrivateAddressError $error) {
                $this->assertSame("$name is not a public address", $error->getMessage());
            }
        }
        $this->assertSame([], $fetcher->requests);
        $this->expectException(FetchError::class);
        Safefetch::publicFetch('https://nowhere.example/', ['timeoutMs' => 2000, 'lookup' => self::dns([])], $fetcher);
    }

    public function testRedirectsAreFollowedByHandUnderTheSameRules(): void
    {
        $dns = self::dns(['a.example' => ['93.184.215.14'], 'b.example' => ['1.1.1.1'], 'inside.example' => ['192.168.0.2']]);
        $hops = static fn (array $answers) => new FakeFetcher(static function (string $url) use (&$answers): Response {
            return array_shift($answers) ?? new Response('end');
        });

        $fetcher = $hops([Response::redirect('/next', 301), Response::redirect('https://b.example/last', 302), new Response('done')]);
        $answer = Safefetch::publicFetch('https://a.example/', ['timeoutMs' => 2000, 'redirects' => 3, 'lookup' => $dns], $fetcher);
        $this->assertSame('done', $answer->text());
        $this->assertSame(['https://a.example/', 'https://a.example/next', 'https://b.example/last'], array_column($fetcher->requests, 'url'));
        $this->assertSame(['b.example:443:1.1.1.1'], $fetcher->inits[2]['resolve']);

        $fetcher = $hops([Response::redirect('https://b.example/', 302)]);
        $this->assertSame(302, Safefetch::publicFetch('https://a.example/', ['timeoutMs' => 2000, 'lookup' => $dns], $fetcher)->status, 'a redirect past the last comes back as it is');

        foreach (['https://10.0.0.1/' => '10.0.0.1', 'https://inside.example/' => 'inside.example', 'http://b.example/' => 'http://b.example/', 'https://[fe80::1]/' => 'fe80::1'] as $location => $what) {
            try {
                Safefetch::publicFetch('https://a.example/', ['timeoutMs' => 2000, 'redirects' => 3, 'lookup' => $dns], $hops([Response::redirect($location)]));
                $this->fail("$location should be refused");
            } catch (PrivateAddressError $error) {
                $this->assertSame("$what is not a public address", $error->getMessage());
            }
        }
    }

    public function testRunningOutOfTimeSaysSo(): void
    {
        $fetcher = new FakeFetcher(static fn () => throw new FetchError('Operation timed out', true));
        try {
            Safefetch::publicFetch('https://a.example/', ['timeoutMs' => 2000, 'lookup' => self::dns(['a.example' => ['1.1.1.1']])], $fetcher);
            $this->fail('should time out');
        } catch (FetchError $error) {
            $this->assertTrue($error->timedOut);
            $this->assertSame('The operation was aborted due to timeout', $error->getMessage());
        }
        $refused = new FakeFetcher(static fn () => throw new FetchError('Connection refused'));
        $this->expectExceptionMessage('Connection refused');
        Safefetch::publicFetch('https://a.example/', ['timeoutMs' => 2000, 'lookup' => self::dns(['a.example' => ['1.1.1.1']])], $refused);
    }

    public function testAServicesRedirectsAreFollowedOnlyWhileEachOneStaysOffLinkLocalAndMetadataAddresses(): void
    {
        $server = new LocalServer();
        $base = "http://127.0.0.1:{$server->port}";
        $to = static fn (string $where, int $status = 302): string => "$base/redirect?status=$status&to=" . rawurlencode($where);
        // Every request made goes through here, so a refused one is seen never to have been asked.
        $asked = [];
        $fetcher = new FakeFetcher(static function (string $url, array $init) use (&$asked): Response {
            $asked[] = $url;
            return (new CurlFetcher())->fetch($url, $init);
        });
        $ask = ['method' => 'POST', 'headers' => ['authorization' => 'Bearer key', 'content-type' => 'application/json'], 'body' => '{}'];
        $echo = static fn (Response $answer): array => json_decode($answer->text(), true);
        try {
            // A service on this computer is fine; a redirect to a metadata address is refused before it is asked.
            foreach ([[$to('http://169.254.169.254/latest/meta-data/'), '169.254.169.254'], [$to('http://[fd00:ec2::254]/', 307), 'fd00:ec2::254']] as [$url, $host]) {
                $asked = [];
                try {
                    Safefetch::serviceFetch($url, $ask, $fetcher);
                    $this->fail("$host should be refused");
                } catch (MetadataAddressError $error) {
                    $this->assertSame($host, $error->host);
                    $this->assertSame("$host is a link-local or cloud metadata address, which Runlight never connects to", $error->getMessage());
                }
                $this->assertSame([$url], $asked, 'nothing was asked there');
            }
            $asked = [];
            try {
                Safefetch::serviceFetch('http://169.254.169.254/v1/models', [], $fetcher);
                $this->fail('a metadata address is refused');
            } catch (MetadataAddressError) {
                $this->assertSame([], $asked);
            }

            // Followed as fetch follows them on the same origin: a 303 goes on as a GET with no body, and a 307 keeps both.
            $seen = $echo(Safefetch::serviceFetch($to('/request', 303), $ask, $fetcher));
            $this->assertSame(['GET', '', ['Bearer key']], [$seen['method'], $seen['body'], $seen['headers']['authorization'] ?? null]);
            $this->assertArrayNotHasKey('content-type', $seen['headers']);
            $seen = $echo(Safefetch::serviceFetch($to('/request', 307), $ask, $fetcher));
            $this->assertSame(['POST', '{}', ['Bearer key'], ['application/json']], [$seen['method'], $seen['body'], $seen['headers']['authorization'] ?? null, $seen['headers']['content-type'] ?? null]);

            // A redirect to another origin is refused before anything is sent there, whatever header carries the key,
            // and a 307 or 308 would have carried the body too.
            $other = "http://localhost:{$server->port}/request";
            foreach ([
                ['authorization', 303], ['proxy-authorization', 307], ['cookie', 302], ['x-api-key', 307], ['api-key', 308], ['x-postmark-server-token', 307],
            ] as [$name, $status]) {
                $asked = [];
                $url = $to($other, $status);
                try {
                    Safefetch::serviceFetch($url, [...$ask, 'headers' => [...$ask['headers'], $name => 'secret']], $fetcher);
                    $this->fail("$name should not follow a redirect to another origin");
                } catch (RedirectRefusedError $error) {
                    $this->assertSame(["127.0.0.1:{$server->port}", "http://localhost:{$server->port}"], [$error->host, $error->to]);
                    $this->assertSame("127.0.0.1:{$server->port} redirected to http://localhost:{$server->port}. Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead", $error->getMessage());
                }
                $this->assertSame([$url], $asked, "$name: exactly one request, and none to the other origin");
            }
            // https to http on the same host is another origin too, and so is another scheme.
            foreach (['https://127.0.0.1:' . $server->port . '/request' => 'https://127.0.0.1:' . $server->port, 'ftp://127.0.0.1/x' => 'ftp:'] as $location => $to_) {
                $asked = [];
                try {
                    Safefetch::serviceFetch($to($location, 308), $ask, $fetcher);
                    $this->fail("$location should be refused");
                } catch (RedirectRefusedError $error) {
                    $this->assertSame($to_, $error->to);
                }
                $this->assertCount(1, $asked);
            }

            // Past the last redirect, the redirect comes back as it is.
            $asked = [];
            $loop = "$base/redirect?to=" . rawurlencode('/redirect?to=%2Fredirect');
            $this->assertSame(302, Safefetch::serviceFetch($loop, ['redirects' => 2], $fetcher)->status);
            $this->assertCount(3, $asked);

            // The AI assistant and a mail webhook refuse such a redirect with the address it led to.
            try {
                Assistant::listModels(['provider' => 'custom', 'baseUrl' => $to('http://169.254.169.254/') . '#', 'key' => ''], $fetcher);
                $this->fail('the assistant should refuse');
            } catch (AssistantError $error) {
                $this->assertSame(['address_refused', ['host' => '169.254.169.254']], [$error->code, $error->params]);
            }
            try {
                Assistant::listModels(['provider' => 'custom', 'baseUrl' => $to($other) . '#', 'key' => ''], $fetcher);
                $this->fail('the assistant should refuse');
            } catch (AssistantError $error) {
                $this->assertSame(['redirect_refused', ['host' => "127.0.0.1:{$server->port}", 'to' => "http://localhost:{$server->port}"]], [$error->code, $error->params]);
            }
            $message = ['to' => 'me@example.com', 'from' => 'reports@example.com', 'subject' => 'Hi', 'html' => '<p>Hi</p>', 'text' => 'Hi'];
            try {
                Transports::send(['service' => 'webhook', 'url' => "http://localhost:{$server->port}/redirect?to=" . rawurlencode('http://169.254.169.254/')], $message, $fetcher);
                $this->fail('the webhook should refuse');
            } catch (MailError $error) {
                $this->assertSame('address_refused', $error->code);
                $this->assertSame('169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to', $error->getMessage());
                $this->assertSame(['host' => '169.254.169.254'], $error->params);
            }
            try {
                Transports::send(['service' => 'webhook', 'url' => $to($other)], $message, $fetcher);
                $this->fail('the webhook should refuse');
            } catch (MailError $error) {
                $this->assertSame(['redirect_refused', ['host' => "127.0.0.1:{$server->port}", 'to' => "http://localhost:{$server->port}"]], [$error->code, $error->params]);
            }
        } finally {
            $server->stop();
        }
    }

    public function testAnAnswerFromAModelAMailServiceOrALinkDomainIsReadOnlySoFar(): void
    {
        $server = new LocalServer();
        try {
            $base = "http://127.0.0.1:{$server->port}";
            $endless = static fn (int $status = 200): string => "$base/bytes?n=60000000&status=$status";
            $fetcher = new CurlFetcher();
            $before = memory_get_peak_usage(true);

            // A model's answer or list of models is read to 4 MiB and then counts as unreadable.
            try {
                Assistant::listModels(['provider' => 'custom', 'baseUrl' => $endless() . '#', 'key' => ''], $fetcher);
                $this->fail('an endless list is no list');
            } catch (AssistantError $error) {
                $this->assertNotSame('unreachable', $error->code);
            }
            try {
                $reply = Assistant::chat(['provider' => 'custom', 'baseUrl' => $endless() . '#', 'key' => '', 'model' => 'm'], [['role' => 'user', 'content' => 'hi']], ['site' => ['id' => 'a', 'name' => 'A', 'timezone' => 'UTC'], 'today' => '2026-10-12', 'view' => '', 'language' => 'en'], static fn () => null, $fetcher);
                $this->assertSame([], $reply['tools'], 'an endless answer says nothing');
            } catch (AssistantError $error) {
                $this->assertNotSame('unreachable', $error->code);
            }

            // A mail service's error text is read to 64 KiB, and a success is not read at all.
            $message = ['to' => 'me@example.com', 'from' => 'reports@example.com', 'subject' => 'Hi', 'html' => '<p>Hi</p>', 'text' => 'Hi'];
            try {
                Transports::send(['service' => 'webhook', 'url' => $endless(500)], $message, $fetcher);
                $this->fail('a 500 is refused');
            } catch (MailError $error) {
                $this->assertSame('mail_refused', $error->code);
            }
            Transports::send(['service' => 'webhook', 'url' => $endless()], $message, $fetcher);

            // And the service fetch itself hands back no more than it was told to read.
            $answer = Safefetch::serviceFetch($endless(), ['maxBytes' => 1000, 'truncate' => true]);
            $this->assertSame(1000, strlen($answer->text()));
            $this->assertLessThan(24 * 1024 * 1024, memory_get_peak_usage(true) - $before, 'none of it was held');
        } finally {
            $server->stop();
        }
    }

    public function testAServiceIsFetchedFromTheAddressItsNameWasCheckedAt(): void
    {
        $server = new LocalServer();
        try {
            $asked = [];
            $fetcher = new FakeFetcher(static function (string $url, array $init) use (&$asked): Response {
                $asked[] = [$url, $init['resolve'] ?? null];
                return (new CurlFetcher())->fetch($url, $init);
            });
            $port = $server->port;
            // A name is looked up here, and the request is pinned to what was checked; private and local addresses stay allowed.
            $answer = Safefetch::serviceFetch("http://models.example:$port/request", ['lookup' => static fn (string $name): array => ['127.0.0.1']], $fetcher);
            $this->assertSame(200, $answer->status);
            $this->assertSame([["http://models.example:$port/request", ["models.example:$port:127.0.0.1"]]], $asked);

            // An address written out is pinned to itself, so no proxy is asked to connect to it.
            $asked = [];
            Safefetch::serviceFetch("http://127.0.0.1:$port/request", [], $fetcher);
            $this->assertSame([["http://127.0.0.1:$port/request", ["127.0.0.1:$port:127.0.0.1"]]], $asked);

            // A name that answers a metadata address, in any of its records, is refused before it is asked.
            foreach ([['169.254.169.254'], ['93.184.215.14', 'fd00:ec2::254'], ['fe80::1']] as $addresses) {
                $asked = [];
                try {
                    Safefetch::serviceFetch("http://models.example:$port/", ['lookup' => static fn (): array => $addresses], $fetcher);
                    $this->fail('a metadata address should be refused');
                } catch (MetadataAddressError $error) {
                    $this->assertSame('models.example', $error->host);
                }
                $this->assertSame([], $asked);
            }

            // A name that does not resolve fails closed, rather than going to a connection that may resolve it.
            $asked = [];
            foreach ([static fn (): array => [], static fn (): array => throw new \RuntimeException('no resolver')] as $lookup) {
                try {
                    Safefetch::serviceFetch("http://models.example:$port/", ['lookup' => $lookup], $fetcher);
                    $this->fail('a failed lookup should be refused');
                } catch (FetchError $error) {
                    $this->assertSame('Could not look up models.example', $error->getMessage());
                }
            }
            $this->assertSame([], $asked);

            // The pin holds on a redirect to the same origin: the next hop is looked up and pinned again.
            $asked = [];
            $hops = 0;
            $lookup = static function (string $name) use (&$hops): array {
                $hops++;
                return ['127.0.0.1'];
            };
            Safefetch::serviceFetch("http://models.example:$port/redirect?to=" . rawurlencode('/request'), ['lookup' => $lookup], $fetcher);
            $this->assertSame(2, $hops);
            $this->assertCount(2, $asked);
            $this->assertSame(["models.example:$port:127.0.0.1"], $asked[1][1]);
        } finally {
            $server->stop();
        }
    }
}
