<?php

declare(strict_types=1);

namespace Runlight\Tests\Routes;

use PHPUnit\Framework\TestCase;
use Runlight\Http\Request;
use Runlight\Http\Response;
use Runlight\Json;
use Runlight\OAuth;
use Runlight\Runlight;
use Runlight\Store\Stores;
use Runlight\Tests\Conformance\Player;
use Runlight\Tests\Core\Harness;
use Runlight\Zip;

/** The routes' parts of the 2026-10-16 audit fixes, as audit.test.ts, mail.test.ts, oauth.test.ts, journeys.test.ts, and hostname-suggestions.test.ts test them. */
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
}
