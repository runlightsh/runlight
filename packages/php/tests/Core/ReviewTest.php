<?php

declare(strict_types=1);

namespace Runlight\Tests\Core;

use PHPUnit\Framework\TestCase;
use Runlight\Accounts\Crypto;
use Runlight\Accounts\Lockout;
use Runlight\AgentCheck;
use Runlight\Http\Request;
use Runlight\Icon;
use Runlight\Importers\CsvVisits;
use Runlight\Importers\Write;
use Runlight\Json;
use Runlight\LinkError;
use Runlight\Payload;
use Runlight\Runlight;
use Runlight\Server\Config;
use Runlight\Server\Standalone;
use Runlight\Sources;
use Runlight\Store\Sql;
use Runlight\Store\Stores;
use Runlight\Tests\Store\Databases;
use Runlight\Ua;

/** What core-review.test.ts and auth-review.test.ts pin in TypeScript, where no fixture or scenario replays it here. */
final class ReviewTest extends TestCase
{
    private const GPTBOT = 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)';

    protected function tearDown(): void
    {
        Databases::cleanup();
    }

    /** @return list<array<string, mixed>> */
    private static function fetches(Harness $t): array
    {
        return $t->store()->db->all("SELECT hostname, title, name FROM rl_events WHERE kind = 'fetch' ORDER BY id");
    }

    public function testFetchesSeenLiveAreLimitedPerAddressAndThoseALogReaderReportsAreNot(): void
    {
        $t = new Harness('sqlite', ['site' => ['hostnames' => ['example.com']], 'rateLimit' => 1]);
        $seen = static fn (array $context = []): bool => $t->rl->observe(new Request('https://example.com/post', 'GET', ['user-agent' => self::GPTBOT, 'host' => 'example.com', 'x-forwarded-for' => '203.0.113.9']), null, $context);
        $this->assertSame(array_fill(0, 10, true), array_map(static fn (): bool => $seen(), range(1, 10)), 'ten times the tracker limit');
        $this->assertFalse($seen());
        $this->assertTrue($seen(['agentIp' => '']), 'a reported fetch is never limited, even with no address');
        $this->assertTrue($seen(['agentIp' => '203.0.113.9']));
        $this->assertCount(12, self::fetches($t));

        $off = new Harness('sqlite', ['site' => ['hostnames' => ['example.com']], 'rateLimit' => false]);
        foreach (range(1, 30) as $_) {
            $this->assertTrue($off->rl->observe(new Request('https://example.com/post', 'GET', ['user-agent' => self::GPTBOT, 'host' => 'example.com', 'x-forwarded-for' => '203.0.113.9'])));
        }
    }

    public function testAFetchIsFiledUnderTheHostAProxyNamesOnlyWhenProxyHeadersAreBelieved(): void
    {
        $t = new Harness('sqlite', ['sites' => [['id' => 'a', 'hostnames' => ['a.example.com']], ['id' => 'b', 'hostnames' => ['b.example.com']]]]);
        $headers = ['user-agent' => self::GPTBOT, 'host' => 'a.example.com', 'x-forwarded-host' => 'www.b.example.com:8443, proxy.internal'];
        // From a private address the proxy's word counts; from a public one the request's own host does.
        $this->assertTrue($t->rl->observe(new Request('https://a.example.com/post', 'GET', $headers), null, ['ip' => '10.0.0.5']));
        $this->assertTrue($t->rl->observe(new Request('https://a.example.com/post', 'GET', $headers), null, ['ip' => '93.184.216.34']));
        $this->assertSame(['b.example.com', 'a.example.com'], array_column(self::fetches($t), 'hostname'));
    }

    public function testAUserAgentGivenAsTextStandsInForTheHeaderWhateverItHolds(): void
    {
        $t = new Harness('sqlite', ['site' => ['hostnames' => ['example.com']]]);
        $logged = self::GPTBOT . "\n\u{4E2D}\u{6587}";
        $this->assertTrue($t->rl->observe(new Request('https://example.com/post'), null, ['agentIp' => '', 'userAgent' => $logged]));
        $this->assertFalse($t->rl->observe(new Request('https://example.com/post', 'GET', ['user-agent' => self::GPTBOT]), null, ['agentIp' => '', 'userAgent' => 'Mozilla/5.0 a browser']), 'the text wins over the header');
        $this->assertSame(['GPTBot'], array_column(self::fetches($t), 'name'));
    }

    public function testANewerDaysSaltIsNeverDeleted(): void
    {
        $store = Databases::fresh('sqlite');
        $store->migrate();
        foreach (['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'] as $day) {
            $store->salt($day, "salt-$day");
        }
        // A process whose clock is a moment behind keeps the 5th and 6th; the 7th, which another just made, stays.
        $store->dropSaltsExcept(['2026-10-05', '2026-10-06']);
        $this->assertNull($store->saltIfExists('2026-10-04'));
        $this->assertSame(['salt-2026-10-05', 'salt-2026-10-06', 'salt-2026-10-07'], array_map($store->saltIfExists(...), ['2026-10-05', '2026-10-06', '2026-10-07']));
    }

    public function testADownloadedAddressListStandsInForTheShippedOneOnlyWhileItIsNewer(): void
    {
        $url = 'https://openai.com/gptbot.json';
        $shipped = (int) (strtotime(AgentCheck::bundled()['fetchedAt']) * 1000);
        $elsewhere = [$url => ['192.0.2.0/24']];
        $check = static function (array $saved, int $now): string {
            $t = new Harness('sqlite', ['site' => ['hostnames' => ['example.com']]]);
            $t->now = $now;
            $t->rl->init();
            $t->store()->setSetting('agent-ranges', Json::encode($saved));
            // 20.171.206.17 is in the list that came with this version, and not in the saved one.
            $t->rl->observe(new Request('https://example.com/post', 'GET', ['user-agent' => self::GPTBOT, 'host' => 'example.com', 'x-forwarded-for' => '20.171.206.17']));
            return (string) self::fetches($t)[0]['title'];
        };
        $now = $shipped + 30 * 86_400_000;
        $this->assertSame('verified', $check(['at' => $shipped - 86_400_000, 'lists' => $elsewhere], $now), 'a copy saved before this version\'s lists were made is left aside');
        $this->assertSame('verified', $check(['at' => $now, 'lists' => $elsewhere, 'fetched' => [$url => $shipped - 86_400_000]], $now), 'and so is one list that has not downloaded since');
        $this->assertSame('mismatch', $check(['at' => $now, 'lists' => $elsewhere], $now), 'a copy from before each list had its own time goes by the time of the whole');
        $this->assertSame('mismatch', $check(['at' => $now, 'lists' => $elsewhere, 'fetched' => [$url => $now]], $now));
    }

    public function testStoredTextIsTidiedAndCutByCharacter(): void
    {
        $this->assertSame('ab', Payload::cleanText("a\0b", 500));
        $whole = str_repeat('x', 499) . "\u{1F600}y";
        $this->assertSame(str_repeat('x', 499) . "\u{1F600}", Payload::cleanText($whole, 500), 'the emoji is one character, kept whole');
        $hit = Payload::parsePayload('{"k":"event","u":"https://example.com/","n":" Sign\u0000up ","t":"a\u0000b","l":"en\u0000-GB","s":"si\u0000te","p":{"half":"a\ud83db","\u0000":"gone"," \u0000k ":"v"}}');
        $this->assertSame(['Signup', 'site'], [$hit['name'], $hit['site']]);
        $this->assertSame(['half' => "a\u{FFFD}b", 'k' => 'v'], $hit['props']);
        $page = Sources::parsePage(new \Runlight\Http\Url('https://example.com/?utm_source=a%00b&ref=%20c%00d%20'));
        $this->assertSame(['ab', 'cd'], [$page['utm']['source'], $page['ref']]);
    }

    public function testOnlyTheStartOfAUserAgentIsReadAndSafariIsReadInOnePass(): void
    {
        $long = Harness::CHROME_MAC . str_repeat(' x', 300) . ' GPTBot/1.2 bot';
        $this->assertGreaterThan(Ua::MAX_UA, strlen($long));
        $this->assertNull(Ua::aiAgent($long));
        $this->assertFalse(Ua::isBot($long), 'a bot token past the cap is not seen');
        foreach (['Version/18 Safari/605.1.15', 'Version/18.1.1 Safari/605.1.15', 'Version/18.0 Mobile/15E148 Safari/604.1'] as $tail) {
            $client = Ua::parseClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) $tail");
            $this->assertSame(['Safari', '18'], [$client['browser'], $client['browserVersion']], $tail);
        }
        $this->assertSame('Chrome', Ua::parseClient(Harness::CHROME_MAC, ['brands' => str_repeat(' ', 600) . '"Brave"'])['browser'], 'a hint past the cap is not read');
    }

    public function testAnAddressIsNoLongerThanOneCanBeAndALinkTagIsReadWithinBounds(): void
    {
        $this->assertTrue(Runlight::isEmail('me@example.com'));
        $this->assertTrue(Runlight::isEmail(str_repeat('a', 308) . '@example.com'), '320 characters');
        $this->assertFalse(Runlight::isEmail(str_repeat('a', 309) . '@example.com'));
        $this->assertFalse(Runlight::isEmail(str_repeat('a@', 200_000)));

        $this->assertSame(['https://example.com/a.png'], Icon::iconLinks('<link rel="icon" href="/a.png">', 'https://example.com'));
        $this->assertSame([], Icon::iconLinks('<link rel="icon" ' . str_repeat('x', 4100) . ' href="/a.png">', 'https://example.com'));
        $this->assertSame(['https://example.com/b.png'], Icon::iconLinks(str_repeat('<link ', 5000) . '<link rel="icon" href="/b.png">', 'https://example.com'));
    }

    public function testACodesLockGrowsEachTimeTheTriesRunOutAndAlwaysEnds(): void
    {
        $store = Databases::fresh('sqlite');
        $lock = new Lockout($store, 'code');
        $minute = 60_000;
        $now = 1_791_288_000_000;
        // Five tries, the fifth starting the lock, then none until it ends.
        $this->assertSame([true, true, true, true, true, false], array_map(static fn (): bool => $lock->take('u1', $now), range(1, 6)));
        $this->assertFalse($lock->take('u1', $now + 15 * $minute - 1));
        // Each time the tries run out again the lock is twice as long, up to a day.
        $lengths = [];
        $at = $now;
        for ($round = 0; $round < 10; $round++) {
            $entry = Json::decode((string) array_values($store->settingsStartingWith('lockout:code:'))[0]['value'], true);
            $lengths[] = intdiv($entry['until'] - $at, $minute);
            $at = $entry['until'];
            foreach (range(1, 5) as $_) {
                $this->assertTrue($lock->take('u1', $at));
            }
        }
        $this->assertSame([15, 30, 60, 120, 240, 480, 960, 1440, 1440, 1440], $lengths);
        $this->assertFalse($lock->take('u1', $at + 1));

        // Before the fifth try the count starts again fifteen minutes after the first, and a right code clears it.
        foreach (range(1, 4) as $_) {
            $this->assertTrue($lock->take('u2', $now));
        }
        $this->assertSame([true, true, true, true, true, false], array_map(static fn (): bool => $lock->take('u2', $now + 15 * $minute), range(1, 6)));
        foreach (range(1, 4) as $_) {
            $lock->take('u3', $now);
        }
        $lock->clear('u3');
        $this->assertSame([true, true, true, true, true], array_map(static fn (): bool => $lock->take('u3', $now), range(1, 5)));
        // A browser the account signed in from before counts on its own.
        $this->assertTrue($lock->take("u3\ndevice", $now));

        // A week after its last lock ended a key is forgotten, and the first lock is fifteen minutes again.
        $this->assertCount(4, $store->settingsStartingWith('lockout:code:'));
        Lockout::sweep($store, $at + 30 * 86_400_000);
        $this->assertSame([], $store->settingsStartingWith('lockout:code:'));
        $this->assertTrue($lock->take('u1', $at + 30 * 86_400_000));
    }

    public function testEveryCodeIsComparedAndTheCurrentStepIsTheOneKept(): void
    {
        $secret = 'JBSWY3DPEHPK3PXP';
        $now = 1_791_288_000_000;
        $step = intdiv($now, Crypto::STEP_MS);
        foreach ([-1, 0, 1] as $drift) {
            $this->assertSame($step + $drift, Crypto::matchStep($secret, Crypto::totp($secret, $step + $drift), $now, -1));
        }
        $this->assertNull(Crypto::matchStep($secret, Crypto::totp($secret, $step), $now, $step), 'a code already used');
        $this->assertNull(Crypto::matchStep($secret, Crypto::totp($secret, $step + 2), $now, -1));
        $this->assertNull(Crypto::matchStep($secret, '', $now, -1));
    }

    public function testPropsTheDatabaseCannotReadCountAsNone(): void
    {
        $this->assertSame('e.props', Sql::readableProps('sqlite'));
        $this->assertSame('(CASE WHEN JSON_VALID(e.props) THEN e.props END)', Sql::readableProps('mysql'));
        // The pattern exactly as Postgres must receive it, which is what TypeScript sends.
        $pattern = '(?<!\\\\)(\\\\\\\\)*(\\\\u0000|\\\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\\\u[dD][c-fC-F][0-9a-fA-F]{2}))|(?<!\\\\)(?<!\\\\u[dD][89abAB][0-9a-fA-F]{2})(\\\\\\\\)*\\\\u[dD][c-fC-F][0-9a-fA-F]{2}';
        $this->assertSame("(CASE WHEN e.props !~ '$pattern' THEN e.props END)::jsonb", Sql::readableProps('postgres'));
        $this->assertStringContainsString('(?<!\\\\)(\\\\\\\\)*(\\\\u0000|', Sql::readableProps('postgres'));
    }

    public function testImportedColumnsHoldNoAddressAndNoUserAgent(): void
    {
        $this->assertSame(['Chrome', 'Arc', '', '', ''], array_map(Write::browser(...), ['chrome', 'arc', '203.0.113.7', 'Mozilla/5.0 (X11; Linux x86_64)', '2001:db8::1']));
        $this->assertSame(['macOS', 'Haiku', '', ''], array_map(Write::system(...), ['Mac OS', 'Haiku', '9front', 'x' . str_repeat('y', 40)]));
        $this->assertSame(['Paris', '', '', ''], array_map(Write::place(...), ['Paris', 'at 203.0.113.7', 'fe80::1', 'Mozilla/5.0 AppleWebKit']));
        $this->assertSame(['1440x900', '', ''], array_map(Write::screen(...), [' 1440x900 ', '1440 x 900', '203.0.113.7']));
        $this->assertSame(['pt-BR', 'en', '', ''], array_map(Write::language(...), [' pt-BR ', 'en', 'english (us)', '203.0.113.7']));
        // A bare number is a Unix time, so a date written 20240501 would land in 1970: no row is that old.
        $this->assertNan(CsvVisits::rowTime(['time' => '20240501'], 'runlight'));
        $this->assertNan(CsvVisits::rowTime(['time' => '1999-12-31T23:59:59Z'], 'runlight'));
        $this->assertSame(946_684_800_000, CsvVisits::rowTime(['time' => '2000-01-01T00:00:00Z'], 'runlight'));
        $this->assertSame(100_000, Write::MAX_LINK_CLICKS);
    }

    public function testALinkImportedOnceAndDeletedSinceIsLeftDeleted(): void
    {
        $t = new Harness('sqlite', ['site' => ['hostnames' => ['example.com']]]);
        $t->rl->init();
        $foreign = ['sourceId' => 'abc', 'slug' => 'sale', 'domain' => '', 'name' => 'Sale', 'url' => 'https://example.org/sale', 'createdAt' => $t->now - 86_400_000];
        $history = ['daily' => [['day' => '2026-10-01', 'clicks' => 3]]];
        $first = Write::writeLink($t->rl, 'default', 'dub', $foreign, $history);
        $this->assertSame(['created', 3], [$first['status'], $first['clicks']]);
        $id = Write::importedLinkId('dub', 'abc');
        $t->rl->links->remove($id);
        $this->assertNull($t->store()->linkById($id));
        $this->assertTrue($t->store()->linkExists($id));
        $this->assertFalse($t->store()->linkExists('nothere'));
        $this->assertSame('skipped', Write::writeLink($t->rl, 'default', 'dub', $foreign, $history)['status']);
        $this->assertSame(3, $t->count("SELECT COUNT(*) AS n FROM rl_events WHERE kind = 'click'"), 'its clicks are still there');

        // No link brings more than the cap with it, however many a source says there were.
        $many = Write::writeLink($t->rl, 'default', 'dub', ['sourceId' => 'big', 'slug' => 'big'] + $foreign, ['daily' => array_map(static fn (int $d): array => ['day' => sprintf('2026-09-%02d', $d), 'clicks' => 10_000], range(1, 12))]);
        $this->assertSame(100_000, $many['clicks']);
    }

    public function testTheStandaloneServerKeepsItsOwnPagesBackAsSlugsAndCountsGuessesAtAShortToken(): void
    {
        $now = 1_791_374_400_000;
        $make = static fn (string $token, array $more = []): Standalone => new Standalone(['store' => Stores::sqlite(':memory:'), 'secret' => str_repeat('s', 64), 'now' => static fn (): int => $now, 'token' => $token] + $more);
        $server = $make('short-token');
        $server->runlight->addSite(['hostnames' => ['blog.example.com']]);
        $links = $server->runlight->links;
        foreach (['login', 'api', 'mcp', 'e', 'embed', 'healthz', 'pick-return', 'setup', 'invite', 'logout'] as $slug) {
            try {
                $links->create('blog.example.com', ['url' => 'https://example.org/', 'slug' => $slug]);
                $this->fail("/$slug was taken");
            } catch (LinkError $error) {
                $this->assertSame('link_reserved', $error->code);
            }
        }
        $this->assertSame('sale', $links->create('blog.example.com', ['url' => 'https://example.org/', 'slug' => 'sale'])['slug']);
        // A link made before the slug was kept back keeps it, and can still be changed.
        $links->reserved = [];
        $old = $links->create('blog.example.com', ['url' => 'https://example.org/', 'slug' => 'login']);
        $links->reserved = ['login'];
        $this->assertSame('login', $links->update($old['id'], ['slug' => 'login', 'name' => 'Old'])['slug']);

        $ask = static fn (Standalone $s, string $bearer, string $ip = '203.0.113.9'): int => $s->handle(new Request('https://stats.example.com/api/sites', 'GET', ['authorization' => "Bearer $bearer"]), ['ip' => $ip])->status;
        $this->assertSame(200, $ask($server, 'short-token'));
        $this->assertSame(array_fill(0, 10, 401), array_map(static fn (int $i): int => $ask($server, "guess-$i"), range(1, 10)));
        $this->assertSame(401, $ask($server, 'short-token'), 'ten wrong guesses hold that address, the right token included');
        $this->assertSame(200, $ask($server, 'short-token', '203.0.113.10'), 'and no other address');
        foreach (range(1, 12) as $i) {
            $ask($server, "rl_made-in-settings-$i", '203.0.113.11');
        }
        $this->assertSame(200, $ask($server, 'short-token', '203.0.113.11'), 'a token made in Settings is never a guess at this one');

        $long = $make(str_repeat('t', 40));
        foreach (range(1, 12) as $i) {
            $ask($long, "guess-$i");
        }
        $this->assertSame(200, $ask($long, str_repeat('t', 40)), 'a long token counts nothing');

        // The name a request came in on is the proxy's word only where a proxy is believed.
        $named = $make(str_repeat('t', 40), ['url' => 'https://stats.example.com']);
        $named->runlight->init();
        $named->runlight->store->addLinkDomain('go.example.com', 'x', $now);
        $spoof = new Request('https://go.example.com/', 'GET', ['host' => 'go.example.com', 'x-forwarded-host' => 'stats.example.com']);
        $this->assertSame(404, $named->handle($spoof, ['ip' => '93.184.216.34'])->status, 'a client straight from the internet cannot name the host, so the link domain answers');
        $this->assertNotSame(404, $named->handle(new Request('https://go.example.com/', 'GET', ['host' => 'go.example.com', 'x-forwarded-host' => 'stats.example.com']), ['ip' => '10.0.0.2'])->status);

        $this->assertNull(Config::shortWarning('RUNLIGHT_TOKEN', str_repeat('t', 32)));
        $this->assertNull(Config::shortWarning('RUNLIGHT_SECRET', null));
        $this->assertStringContainsString('RUNLIGHT_TOKEN is only 11 characters long', (string) Config::shortWarning('RUNLIGHT_TOKEN', 'short-token'));
    }
}
