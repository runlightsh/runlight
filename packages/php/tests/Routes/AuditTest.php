<?php

declare(strict_types=1);

namespace Runlight\Tests\Routes;

use PHPUnit\Framework\TestCase;
use Runlight\Accounts\Throttle;
use Runlight\Db\Connect;
use Runlight\Db\Db;
use Runlight\Http\Request;
use Runlight\Http\Response;
use Runlight\Http\SearchParams;
use Runlight\Http\Url;
use Runlight\Json;
use Runlight\OAuth;
use Runlight\Runlight;
use Runlight\Store\SqlStore;
use Runlight\Store\Stores;
use Runlight\Tests\Conformance\Player;
use Runlight\Tests\Core\Harness;
use Runlight\Zip;

/**
 * The routes' parts of the 2026-10-16 audit fixes, as audit.test.ts, mail.test.ts, oauth.test.ts, journeys.test.ts, and
 * hostname-suggestions.test.ts test them, and the 2026-10-23 audit's, as audit.test.ts tests them.
 */
final class AuditTest extends TestCase
{
    /** @var array<string, mixed> */
    private array $env = [];

    protected function setUp(): void
    {
        $this->env = Player::clearEnv();
    }

    protected function tearDown(): void
    {
        Player::restoreEnv($this->env);
    }

    private static function get(\Runlight\Routes $routes, string $path): Response
    {
        return $routes->handle(new Request("https://example.com/runlight$path", 'GET', ['authorization' => 'Bearer secret']));
    }

    public function testNMonthsBackFromAMonthsLastDaysStaysInThatMonthAndPagingTakesWholeNumbers(): void
    {
        $now = 0;
        $rl = new Runlight(['store' => Stores::sqlite(':memory:'), 'site' => ['hostnames' => ['example.com']], 'now' => static function () use (&$now): int {
            return $now;
        }]);
        $rl->init();
        $rl->setRetention('default', 6);
        $utc = static fn (int $y, int $m, int $d, int $h): int => gmmktime($h, 0, 0, $m, $d, $y) * 1000;
        foreach ([
            [$utc(2026, 8, 31, 12), $utc(2026, 2, 28, 12)],
            [$utc(2026, 8, 30, 12), $utc(2026, 2, 28, 12)],
            [$utc(2028, 8, 31, 12), $utc(2028, 2, 29, 12)],
            [$utc(2026, 10, 6, 12), $utc(2026, 4, 6, 12)],
            [$utc(2026, 3, 31, 12), $utc(2025, 9, 30, 12)],
        ] as [$at, $cutoff]) {
            $now = $at;
            $this->assertSame($cutoff, $rl->retentionCutoff('default'), gmdate('c', intdiv($at, 1000)));
        }
        $routes = $rl->routes(['token' => 'secret']);
        foreach (['limit=2.5', 'page=1e20', 'limit=-3&page=0', 'limit=abc&page=2.5'] as $query) {
            $this->assertSame(200, self::get($routes, "/api/breakdown?period=7d&dimension=page&$query")->status, $query);
        }
    }

    public function testAFractionOrAHugeNumberFallsBackToTheDefaultPageAndLimit(): void
    {
        $t = new Harness('sqlite', ['site' => ['hostnames' => ['example.com']]]);
        foreach (range(1, 12) as $i) {
            $t->send(['k' => 'pageview', 'u' => "https://example.com/p$i", 'i' => "pv$i"], ['ip' => "203.0.113.$i"]);
        }
        $routes = $t->rl->routes(['token' => 'secret']);
        $rows = static fn (string $query): int => count(Json::decode(self::get($routes, "/api/breakdown?period=today&dimension=page&$query")->text(), true)['rows']);
        $this->assertSame(10, $rows(''), 'ten a page');
        $this->assertSame(10, $rows('limit=2.5'), 'a fraction is the default');
        $this->assertSame(10, $rows('page=1e20'), 'a huge page is the first');
        $this->assertSame(5, $rows('limit=5'));
        $this->assertSame(2, $rows('limit=10&page=2'));
    }

    public function testACsvValueWithASemicolonOrATabIsQuotedSoNoLocaleSplitsAFormulaOutOfIt(): void
    {
        $this->assertSame("\"x;=1+1\",\"a\tb\",'=1+1,plain", Zip::csvRow(['x;=1+1', "a\tb", '=1+1', 'plain']));
    }

    public function testAJourneysStartEndAndThroughTakeAPageAsWrittenAsFiltersDo(): void
    {
        $t = new Harness('sqlite', ['site' => ['hostnames' => ['example.com']]]);
        $t->send(['k' => 'pageview', 'u' => 'https://example.com/café', 'i' => 'a']);
        $t->advance(30_000);
        $t->send(['k' => 'pageview', 'u' => 'https://example.com/pricing', 'i' => 'b']);
        $routes = $t->rl->routes(['token' => 'secret']);
        foreach (['start=' . rawurlencode('/café'), 'start=' . rawurlencode('/caf%C3%A9'), 'end=' . rawurlencode('/pricing') . '&start=' . rawurlencode('/café'), 'through=' . rawurlencode('0:/café')] as $query) {
            $answer = Json::decode(self::get($routes, "/api/journeys?period=today&$query")->text(), true);
            $this->assertSame(1, $answer['visits'], $query);
        }
    }

    public function testHostnameSuggestionsComeOneHostnameAtATimeAndNotForACsv(): void
    {
        $t = new Harness('sqlite', ['sites' => [['id' => 'a', 'name' => 'A', 'hostnames' => ['blog.example.com', 'blog-staging.example.com', 'shop.example.com']]]]);
        foreach (['blog.example.com', 'blog-staging.example.com', 'shop.example.com'] as $i => $host) {
            $t->send(['s' => 'a', 'k' => 'pageview', 'u' => "https://$host/", 'i' => "h$i"], ['ip' => '203.0.113.' . ($i + 2)]);
        }
        $routes = $t->rl->routes(['token' => 'secret']);
        $values = static fn (string $query): array => array_column(Json::decode(self::get($routes, "/api/breakdown?site=a&period=today&dimension=hostname$query")->text(), true)['rows'], 'value');
        $this->assertSame(['blog-staging.example.com', 'blog.example.com', 'shop.example.com'], $values('&suggestions=1'));
        $this->assertSame(['blog-staging.example.com', 'blog.example.com'], $values('&suggestions=1&limit=2'));
        $this->assertCount(3, $values(''), 'the ordinary report');
    }

    public function testATestEmailGoesOnceAMinutePerMailServiceAndIsCountedOnceSent(): void
    {
        $now = 1_791_288_000_000;
        $sent = [];
        $fail = false;
        $rl = new Runlight([
            'store' => Stores::sqlite(':memory:'),
            'site' => ['hostnames' => ['example.com']],
            'secret' => str_repeat('s', 32),
            'now' => static function () use (&$now): int {
                return $now;
            },
            'mail' => ['send' => static function (array $mail) use (&$sent, &$fail): void {
                if ($fail) {
                    throw new \RuntimeException('SMTP connect() failed');
                }
                $sent[] = $mail;
            }, 'from' => 'reports@example.com', 'via' => 'Mailer'],
        ]);
        $routes = $rl->routes(['token' => 'secret']);
        $test = static fn (): Response => $routes->handle(new Request('https://example.com/runlight/api/mail/test', 'POST', ['authorization' => 'Bearer secret', 'content-type' => 'application/json'], '{"to":"jon@example.com"}'));
        $this->assertSame(200, $test()->status);
        $this->assertCount(1, $sent);
        // Another test through it straight away waits a minute, so the button cannot flood an inbox.
        $again = $test();
        $this->assertSame([429, 'test_soon'], [$again->status, Json::decode($again->text(), true)['code']]);
        $this->assertCount(1, $sent);
        $now += 60_000;
        $fail = true;
        $this->assertSame(400, $test()->status, 'a failure comes back as a mail error');
        $fail = false;
        $this->assertSame(200, $test()->status, 'and a test that failed is not counted, so it can be tried at once');
        $this->assertCount(2, $sent);
    }

    public function testASitesAgentsKeyIsKeptSealedAndOneKeptAsPlainTextBeforeStillWorksAndIsSealedWhenRead(): void
    {
        $rl = new Runlight(['store' => Stores::sqlite(':memory:'), 'site' => ['hostnames' => ['example.com']], 'secret' => str_repeat('s', 32)]);
        $rl->init();
        $key = OAuth::agentsKey($rl, 'default');
        $stored = (string) $rl->store->setting('observe-key:default');
        $this->assertStringNotContainsString($key, $stored, 'not in the database as it is');
        $routes = $rl->routes(['token' => 'owner']);
        $observe = static fn (string $bearer): int => $routes->handle(new Request('https://example.com/runlight/api/observe', 'POST', ['authorization' => "Bearer $bearer", 'content-type' => 'application/json'], Json::encode(['url' => 'https://example.com/', 'userAgent' => 'Mozilla/5.0 (compatible; GPTBot/1.2)'])))->status;
        $this->assertSame(204, $observe($key));
        // A key from before, kept as it was.
        $rl->store->setSetting('observe-key:default', 'rlo_legacykeylegacykey00');
        $this->assertSame(204, $observe('rlo_legacykeylegacykey00'));
        $this->assertSame('rlo_legacykeylegacykey00', OAuth::agentsKey($rl, 'default'), 'shown as it was');
        $this->assertStringNotContainsString('rlo_legacy', (string) $rl->store->setting('observe-key:default'), 'and sealed now');
        $this->assertSame(204, $observe('rlo_legacykeylegacykey00'), 'still working');
        $this->assertSame(401, $observe('rlo_wrongkeywrongkeywron'));
        $this->assertNotSame($key, OAuth::agentsKey($rl, 'default', true), 'replacing it still makes a new one');
    }

    // The audit of 2026-10-23.

    /** @param array<string, string> $headers */
    private static function accountReq(string $path, string $method = 'GET', array $headers = [], string $body = ''): Request
    {
        return new Request("https://example.com/runlight$path", $method, $headers, $body);
    }

    /**
     * @param array<string, string> $fields
     * @param array<string, string> $headers
     */
    private static function formPost(string $path, array $fields, array $headers = []): Request
    {
        return self::accountReq($path, 'POST', ['content-type' => 'application/x-www-form-urlencoded', ...$headers], (new SearchParams($fields))->toString());
    }

    private static function cookieFrom(Response $response): string
    {
        return explode(';', $response->headers->get('set-cookie') ?? '')[0];
    }

    /**
     * An install with accounts: its owner, and a member who joined by invite.
     *
     * @return array{handler: \Closure(Request): Response, json: \Closure(string, string, string, mixed=): Response, owner: string, member: string}
     */
    private static function withMember(): array
    {
        $rl = new Runlight(['store' => Stores::sqlite(':memory:'), 'secret' => str_repeat('k', 64)]);
        $routes = $rl->routes(['token' => 'app-token', 'accounts' => true]);
        $handler = static fn (Request $r): Response => $routes->handle($r);
        $json = static fn (string $cookie, string $method, string $path, mixed $body = null): Response => $handler(self::accountReq($path, $method, ['cookie' => $cookie, 'content-type' => 'application/json'], $body === null ? '' : Json::encode($body)));
        $owner = self::cookieFrom($handler(self::formPost('/setup', ['code' => 'app-token', 'email' => 'jon@example.com', 'password' => 'a long password', 'again' => 'a long password'])));
        $invite = new Url(Json::decode($json($owner, 'POST', '/api/people', ['allSites' => true, 'email' => 'mo@example.com', 'role' => 'member'])->text(), true)['link']);
        $member = self::cookieFrom($handler(self::formPost('/invite', ['code' => (string) $invite->searchParams()->get('code'), 'password' => 'a long password', 'again' => 'a long password'])));
        return ['handler' => $handler, 'json' => $json, 'owner' => $owner, 'member' => $member];
    }

    public function testAMemberSeesAndRevokesOnlyTheTokensTheyMadeAndCannotReplaceASitesAgentsKey(): void
    {
        ['json' => $json, 'owner' => $owner, 'member' => $member] = self::withMember();
        $make = static fn (string $cookie, string $name): string => Json::decode($json($cookie, 'POST', '/api/tokens', ['name' => $name])->text(), true)['token']['id'];
        $owners = $make($owner, "Owner's");
        $mine = $make($member, "Member's");
        $listed = static function (string $cookie) use ($json): array {
            $ids = array_column(Json::decode($json($cookie, 'GET', '/api/tokens')->text(), true)['tokens'], 'id');
            sort($ids);
            return $ids;
        };
        $both = [$owners, $mine];
        sort($both);
        $this->assertSame([$mine], $listed($member));
        $this->assertSame($both, $listed($owner), 'the owner sees every token');
        $this->assertSame(404, $json($member, 'DELETE', "/api/tokens/$owners")->status, "the owner's token is not the member's to revoke");
        $this->assertSame($both, $listed($owner));
        $this->assertSame(200, $json($member, 'DELETE', "/api/tokens/$mine")->status);
        $this->assertSame(403, $json($member, 'POST', '/api/observe-key/new?site=default', new \stdClass())->status);
        $this->assertSame(200, $json($owner, 'POST', '/api/observe-key/new?site=default', new \stdClass())->status);
    }

    public function testSigningOutEndsTheAccountsSessionsEverywhereAndOnlyFromTheDashboardsOwnPages(): void
    {
        ['handler' => $handler, 'json' => $json, 'member' => $member] = self::withMember();
        $other = self::cookieFrom($handler(self::formPost('/login', ['email' => 'mo@example.com', 'password' => 'a long password', 'next' => '/runlight/'])));
        $this->assertSame(200, $json($other, 'GET', '/api/account')->status);
        $crossSite = $handler(self::accountReq('/logout', 'GET', ['cookie' => $member, 'sec-fetch-site' => 'cross-site']));
        $this->assertSame(403, $crossSite->status, 'another site cannot sign anyone out');
        $this->assertSame(200, $json($other, 'GET', '/api/account')->status);
        $out = $handler(self::accountReq('/logout', 'GET', ['cookie' => $member, 'sec-fetch-site' => 'same-origin']));
        $this->assertSame(303, $out->status);
        $this->assertSame(401, $json($member, 'GET', '/api/account')->status, 'the cookie copied before stops working');
        $this->assertSame(401, $json($other, 'GET', '/api/account')->status, 'and so does the one in the other browser');
        $back = self::cookieFrom($handler(self::formPost('/login', ['email' => 'mo@example.com', 'password' => 'a long password', 'next' => '/runlight/'])));
        $this->assertSame(200, $json($back, 'GET', '/api/account')->status, 'signing in again works');
    }

    public function testTheSignInFormsTakeAPostOnlyFromTheirOwnPages(): void
    {
        ['handler' => $handler] = self::withMember();
        foreach (['cross-site', 'same-site'] as $site) {
            $refused = $handler(self::formPost('/login', ['email' => 'mo@example.com', 'password' => 'a long password', 'next' => '/runlight/'], ['sec-fetch-site' => $site]));
            $this->assertSame(403, $refused->status, $site);
            $this->assertNull($refused->headers->get('set-cookie'), "$site: no session is planted");
        }
        $own = $handler(self::formPost('/login', ['email' => 'mo@example.com', 'password' => 'a long password', 'next' => '/runlight/'], ['sec-fetch-site' => 'same-origin']));
        $this->assertSame(303, $own->status);
    }

    public function testANewPasswordCanTakeBackTheTokensTheAccountMade(): void
    {
        ['json' => $json, 'member' => $member] = self::withMember();
        $json($member, 'POST', '/api/tokens', ['name' => 'Kept']);
        $fresh = self::cookieFrom($json($member, 'POST', '/api/account/password', ['current' => 'a long password', 'next' => 'another long password']));
        $kept = $json($fresh, 'GET', '/api/tokens');
        $this->assertSame(200, $kept->status, $kept->text());
        $this->assertCount(1, Json::decode($kept->text(), true)['tokens'], 'kept unless asked');
        $latest = self::cookieFrom($json($fresh, 'POST', '/api/account/password', ['current' => 'another long password', 'next' => 'a third long password', 'revokeTokens' => true]));
        $this->assertCount(0, Json::decode($json($latest, 'GET', '/api/tokens')->text(), true)['tokens']);
    }

    public function testAFloodOfMadeUpNamesCannotResetTheCountOfOneCloseToItsLimit(): void
    {
        // PHP keeps the counts in the database, so the flood is written there at once rather than tried name by name.
        $store = Stores::sqlite(':memory:');
        $store->migrate();
        $now = 1_791_288_000_000;
        $throttle = new Throttle($store, 'address', 3, clock: static fn (): int => $now);
        $this->assertTrue($throttle->take('target', $now));
        $this->assertTrue($throttle->take('target', $now));
        $store->db->transaction(static function () use ($store, $now): void {
            for ($i = 0; $i < 10_050; $i++) {
                $store->setSetting("throttle:address:made-up-$i", Json::encode(['count' => 1, 'until' => $now + 60_000]));
            }
        });
        $this->assertTrue($throttle->take('one more made up', $now), 'a new name makes the counts go over the ceiling');
        $this->assertCount(9_000, $store->settingsStartingWith('throttle:address:'), 'down to nine tenths of it');
        $this->assertTrue($throttle->take('target', $now));
        $this->assertFalse($throttle->take('target', $now), "the target's earlier tries still count");
    }

    public function testYesterdaysSaltLeavesMemoryWhenItLeavesTheStoreOnTheFirstHitAfterMidnight(): void
    {
        $t = new Harness('sqlite');
        $t->send(['k' => 'pageview', 'u' => 'https://example.com/']);
        $t->advance(13 * 3_600_000);
        $t->send(['k' => 'pageview', 'u' => 'https://example.com/'], ['ip' => '203.0.113.9']);
        $cached = (new \ReflectionProperty(Runlight::class, 'salts'))->getValue($t->rl)['UTC'];
        $this->assertSame('2026-10-07', $cached['day']);
        $this->assertNull($cached['yesterday'], "no visit was left open, so yesterday's salt is gone from here too");
    }

    public function testAHitTriedAgainAfterTheStoreWasBusyCountsOnce(): void
    {
        // A database that is busy for the next few event rows written.
        $db = new class (Connect::sqlite(':memory:')) implements Db {
            public int $fail = 0;

            public function __construct(private readonly Db $inner)
            {
            }

            public function dialect(): string
            {
                return $this->inner->dialect();
            }

            public function all(string $sql, array $params = []): array
            {
                return $this->inner->all($sql, $params);
            }

            public function run(string $sql, array $params = []): void
            {
                if (str_starts_with($sql, 'INSERT INTO rl_events') && $this->fail-- > 0) {
                    throw new \RuntimeException('SQLITE_BUSY: database is locked');
                }
                $this->inner->run($sql, $params);
            }

            public function transaction(callable $fn): mixed
            {
                return $this->inner->transaction(fn () => $fn($this));
            }

            public function exclusive(callable $fn): mixed
            {
                return $this->inner->exclusive(fn () => $fn($this));
            }

            public function close(): void
            {
                $this->inner->close();
            }
        };
        $t = new Harness(new SqlStore($db));
        $db->fail = 2;
        $t->send(['k' => 'pageview', 'u' => 'https://example.com/', 'i' => 'p1']);
        $db->fail = 1;
        $t->send(['k' => 'engagement', 'u' => 'https://example.com/', 'i' => 'p1', 'e' => 5000]);
        $visit = $db->all('SELECT pageviews, engaged_ms FROM rl_sessions')[0];
        $this->assertSame(1, (int) $visit['pageviews']);
        $this->assertSame(5000, (int) $visit['engaged_ms']);
        $this->assertCount(1, $db->all("SELECT id FROM rl_events WHERE kind = 'pageview'"));
    }

    public function testAFunnelOverMoreVisitsThanTheCapCountsTheNewestAndSaysSo(): void
    {
        $t = new Harness('sqlite');
        $t->rl->store->funnelVisits = 2;
        foreach (['203.0.113.1', '203.0.113.2', '203.0.113.3'] as $ip) {
            $t->send(['k' => 'pageview', 'u' => 'https://example.com/pricing'], ['ip' => $ip]);
            $t->advance(60_000);
        }
        $routes = $t->rl->routes(['token' => 'secret']);
        $routes->handle(new Request('https://example.com/runlight/api/funnels?site=default', 'POST', ['authorization' => 'Bearer secret', 'content-type' => 'application/json'], Json::encode(['name' => 'F', 'steps' => [['kind' => 'page', 'match' => '/pricing'], ['kind' => 'page', 'match' => '/thanks']]])));
        $funnel = Json::decode(self::get($routes, '/api/funnels?period=today')->text(), true)['funnels'][0];
        $this->assertSame(2, $funnel['sampled']);
        $this->assertSame(2, $funnel['steps'][0]['visits']);
        $t->rl->store->funnelVisits = 10;
        $this->assertArrayNotHasKey('sampled', Json::decode(self::get($routes, '/api/funnels?period=today')->text(), true)['funnels'][0]);
    }

    public function testAPropNamedProtoIsKept(): void
    {
        $t = new Harness('sqlite');
        $t->send(['k' => 'event', 'u' => 'https://example.com/', 'n' => 'Odd', 'p' => ['__proto__' => 'x', 'plain' => 'y']]);
        $row = $t->rl->store->db->all("SELECT props FROM rl_events WHERE name = 'Odd'")[0];
        $this->assertSame(['__proto__' => 'x', 'plain' => 'y'], Json::decode((string) $row['props'], true));
    }

    public function testAnAutomaticLinkEventKeepsItsLinkWithoutTheQueryStringOrFragment(): void
    {
        $t = new Harness('sqlite');
        $t->send(['k' => 'event', 'u' => 'https://example.com/', 'n' => 'Outbound link', 'p' => ['url' => 'https://other.example/reset?token=abc&email=a@b.example#top']]);
        $t->send(['k' => 'event', 'u' => 'https://example.com/', 'n' => 'File download', 'p' => ['url' => 'https://example.com/a.pdf?sig=x']]);
        $t->send(['k' => 'event', 'u' => 'https://example.com/', 'n' => 'Signup', 'p' => ['url' => 'https://example.com/?plan=pro']]);
        $rows = $t->rl->store->db->all('SELECT name, props FROM rl_events ORDER BY name');
        $this->assertSame([
            ['File download', 'https://example.com/a.pdf'],
            ['Outbound link', 'https://other.example/reset'],
            ['Signup', 'https://example.com/?plan=pro'],
        ], array_map(static fn (array $r): array => [$r['name'], Json::decode((string) $r['props'], true)['url']], $rows));
    }
}
