<?php

declare(strict_types=1);

namespace Runlight\Tests\Routes;

use PHPUnit\Framework\TestCase;
use Runlight\Accounts\Accounts;
use Runlight\Accounts\Crypto;
use Runlight\Accounts\Web;
use Runlight\Db\Db;
use Runlight\Http\Request;
use Runlight\Http\Response;
use Runlight\Http\SearchParams;
use Runlight\Json;
use Runlight\Mail\MailError;
use Runlight\Mail\Smtp;
use Runlight\Runlight;
use Runlight\Scratch;
use Runlight\Store\Stores;
use Runlight\Tests\Conformance\Player;

/**
 * What PHP must hold to where it differs from a long-lived process: limits that hold for requests sent at once
 * to many processes, nothing made from an address left behind, a sign-in for no account that costs one check,
 * and an app that carries on while the analytics database is down.
 */
final class SafeguardsTest extends TestCase
{
    private const NOW = 1_791_806_400_000;

    /** @var array<string, mixed> */
    private array $env = [];
    private string $dir = '';

    protected function setUp(): void
    {
        $this->env = Player::clearEnv();
        $this->dir = sys_get_temp_dir() . '/runlight-safe-' . bin2hex(random_bytes(6));
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        Player::restoreEnv($this->env);
        self::remove($this->dir);
    }

    private static function remove(string $path): void
    {
        if (is_dir($path) && !is_link($path)) {
            foreach (scandir($path) ?: [] as $name) {
                if ($name !== '.' && $name !== '..') {
                    self::remove("$path/$name");
                }
            }
            rmdir($path);
        } elseif (file_exists($path)) {
            unlink($path);
        }
    }

    /** @param array<string, mixed> $options */
    private function made(array $options = []): Runlight
    {
        return new Runlight($options + ['store' => Stores::sqlite("{$this->dir}/runlight.db"), 'now' => fn (): int => self::NOW, 'sites' => [['id' => 'a', 'name' => 'A', 'hostnames' => ['a.example.com']]]]);
    }

    /**
     * Runs `$code` in several PHP processes at once, each a request of its own, and gives what each printed.
     *
     * @return list<string>
     */
    private function atOnce(string $code, int $processes): array
    {
        $autoload = dirname(__DIR__, 2) . '/vendor/autoload.php';
        $running = [];
        for ($i = 0; $i < $processes; $i++) {
            $process = proc_open([PHP_BINARY, '-r', 'require ' . var_export($autoload, true) . ';' . $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $this->assertIsResource($process);
            $running[] = [$process, $pipes];
        }
        $printed = [];
        foreach ($running as [$process, $pipes]) {
            $printed[] = (string) stream_get_contents($pipes[1]);
            stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);
        }
        return $printed;
    }

    public function testAnAccountKeptToOneSiteCannotMoveItHoweverTheBodyIsWritten(): void
    {
        $rl = new Runlight(['store' => Stores::sqlite(':memory:'), 'managedSites' => true, 'secret' => str_repeat('k', 64), 'now' => fn (): int => self::NOW]);
        $site = $rl->addSite(['hostnames' => ['blog.example.com']])['id'];
        $rl->addSite(['hostnames' => ['shop.example.com']]);
        $web = new Web(['runlight' => $rl, 'secret' => str_repeat('k', 64), 'base' => '/runlight', 'now' => fn (): int => self::NOW, 'firstAccount' => 'locked', 'forgot' => 'https://example.com/forgot']);
        $web->accounts->setPassword('owner@example.com', 'a long password', self::NOW);
        $member = $web->accounts->setPassword('member@example.com', 'a long password', self::NOW, 'member', $site);
        $cookie = Accounts::SESSION_COOKIE . '=' . rawurlencode($web->accounts->sessionFor($member, self::NOW));
        $routes = $rl->routes(['token' => 'app-token', 'accounts' => $web]);
        $patch = static fn (string $body): Response => $routes->handle(new Request("https://example.com/runlight/api/sites/$site", 'PATCH', ['cookie' => $cookie, 'content-type' => 'application/json'], $body));

        $moved = '{"hostnames":["elsewhere.example.com"]}';
        // A byte order mark, and a byte that is not UTF-8, are read by the route, so the check reads them too.
        foreach ([$moved, "\xEF\xBB\xBF$moved", '{"hostnames":["elsewhere.example.com"],"name":"' . "\xFF" . '"}'] as $body) {
            $refused = $patch($body);
            $this->assertSame([403, 'site_domains'], [$refused->status, Make::body($refused)['code']]);
        }
        $this->assertSame(['blog.example.com'], $rl->site($site)['hostnames']);
        $this->assertSame(200, $patch('{"name":"The blog"}')->status, 'its name is still its to change');
        $this->assertSame('The blog', $rl->site($site)['name']);

        // The consent page is refused by the path under the base, not by any address that mentions it.
        $consent = $routes->handle(new Request('https://example.com/runlight/oauth/authorize?client_id=x', 'GET', ['cookie' => $cookie]));
        $this->assertNotSame(200, $consent->status);
        $read = $routes->handle(new Request("https://example.com/runlight/api/sites?next=/oauth/", 'GET', ['cookie' => $cookie]));
        $this->assertSame(200, $read->status);
        $this->assertSame([$site], array_column(Make::body($read)['sites'], 'id'));
    }

    public function testSamplesAskedForAtOnceFromManyProcessesSendOne(): void
    {
        $rl = $this->made(['secret' => str_repeat('k', 64)]);
        $routes = $rl->routes(['token' => 'secret']);
        // Nothing listens there, so a sample that gets past the limit fails fast, and one the limit holds is a 429.
        $rl->saveMailSettings(['service' => 'webhook', 'url' => 'http://127.0.0.1:9/hook', 'from' => 'reports@example.com']);
        $report = Make::body($routes->handle(Make::owner('/runlight/api/reports?site=a', 'POST', ['email' => 'me@example.com'])))['report']['id'];
        $code = '$rl = new \Runlight\Runlight(["store" => \Runlight\Store\Stores::sqlite(' . var_export("{$this->dir}/runlight.db", true) . '), "secret" => ' . var_export(str_repeat('k', 64), true) . ', "now" => fn () => ' . self::NOW . ', "sites" => [["id" => "a", "name" => "A", "hostnames" => ["a.example.com"]]]]);'
            . 'echo $rl->routes(["token" => "secret"])->handle(new \Runlight\Http\Request("https://example.com/runlight/api/reports/' . $report . '/send?site=a", "POST", ["authorization" => "Bearer secret", "content-type" => "application/json"], "{}"))->status;';
        $statuses = $this->atOnce($code, 6);
        $this->assertSame(1, count(array_filter($statuses, static fn (string $s): bool => $s !== '429')), implode(' ', $statuses));
        $this->assertSame((string) self::NOW, $rl->store->setting("sample-sent:$report"));
    }

    public function testATurnIsTakenOnceAndPutBackWhenItCameToNothing(): void
    {
        $store = $this->made()->store;
        $store->migrate();
        $this->assertSame('', $store->claimSetting('turn', 1000, 60_000), 'nothing was there');
        $this->assertNull($store->claimSetting('turn', 30_000, 60_000), 'too soon');
        $this->assertSame('1000', $store->claimSetting('turn', 61_000, 60_000));
        $this->assertSame('61000', $store->setting('turn'));

        // A test email that failed gives its minute back, so it can be tried again at once.
        $rl = $this->made(['secret' => str_repeat('k', 64)]);
        $routes = $rl->routes(['token' => 'secret']);
        $rl->saveMailSettings(['service' => 'webhook', 'url' => 'http://127.0.0.1:9/hook', 'from' => 'reports@example.com']);
        $test = static fn (): int => $routes->handle(Make::owner('/runlight/api/mail/test', 'POST', ['to' => 'me@example.com']))->status;
        $this->assertSame(400, $test());
        $this->assertSame(400, $test(), 'not a 429');

        $this->assertTrue($store->editSetting('list', static fn (array $held): array => [...$held, 1]));
        $this->assertTrue($store->editSetting('list', static fn (array $held): array => [...$held, 2]));
        $this->assertFalse($store->editSetting('list', static fn (array $held): ?array => null));
        $this->assertSame('[1,2]', $store->setting('list'));
    }

    public function testQuestionsBeingAnsweredAndThoseOfTheHourAreCountedAcrossProcesses(): void
    {
        $rl = $this->made();
        $rl->init();
        // The model is never reached; a question that gets past the limits fails fast instead.
        $rl->saveAssistantSettings(['provider' => 'custom', 'model' => 'm', 'baseUrl' => 'http://127.0.0.1:9/v1', 'key' => 'k']);
        $ask = function (): int {
            // A new handler each time, as each PHP request is.
            $routes = $this->made()->routes(['authorize' => static fn (): bool => true, 'accountOf' => static fn (): string => 'o1']);
            $body = json_encode(['site' => 'a', 'messages' => [['role' => 'user', 'content' => 'hi']]]);
            return $routes->handle(new Request('https://x.com/runlight/api/assistant/chat', 'POST', ['content-type' => 'application/json'], (string) $body))->status;
        };

        // Two being answered by other processes hold both places; one that began longer ago than an answer may take does not.
        $rl->store->setSetting('assistant-open:o1', Json::encode(['pa' => self::NOW - 1000, 'pb' => self::NOW - 2000]));
        $this->assertSame(429, $ask());
        $rl->store->setSetting('assistant-open:o1', Json::encode(['pa' => self::NOW - 1000, 'pb' => self::NOW - 600_000]));
        $this->assertNotSame(429, $ask());
        $this->assertSame(['pa'], array_keys(Json::decode((string) $rl->store->setting('assistant-open:o1'), true)), 'its own place is given back');
        $this->assertSame([self::NOW], Json::decode((string) $rl->store->setting('assistant-hour:o1'), true));

        $rl->store->setSetting('assistant-open:o1', null);
        $rl->store->setSetting('assistant-hour:o1', Json::encode(array_fill(0, 29, self::NOW - 60_000)));
        $this->assertNotSame(429, $ask(), 'the thirtieth of the hour');
        $this->assertSame(429, $ask());
        $this->assertCount(30, Json::decode((string) $rl->store->setting('assistant-hour:o1'), true));
    }

    public function testASignInForNoAccountIsCheckedOnceAgainstAHashNothingMatches(): void
    {
        $decoy = Crypto::decoyHash();
        $new = explode('$', Crypto::hashPassword('a long password'));
        $parts = explode('$', $decoy);
        $this->assertSame(array_slice($new, 0, 4), array_slice($parts, 0, 4), 'at the cost of a new hash');
        $this->assertSame([strlen($new[4]), strlen($new[5])], [strlen($parts[4]), strlen($parts[5])]);
        $this->assertFalse(Crypto::weakerThanNow($decoy));
        $this->assertSame($decoy, Crypto::decoyHash(), 'the same every time, so none is made per request');
        $this->assertFalse(Crypto::checkPassword('a long password', $decoy));
        $this->assertFalse(Crypto::checkPassword('', $decoy));

        $accounts = new Accounts($this->made()->store, str_repeat('k', 64));
        $this->assertNull($accounts->signIn('nobody@example.com', 'a long password'));
        $this->assertFalse((new \ReflectionClass(Accounts::class))->hasProperty('decoy'));
    }

    public function testNothingMadeFromAnAddressOutlivesItsUseWithNoScheduledCheck(): void
    {
        $now = self::NOW;
        $rl = $this->made(['now' => function () use (&$now): int {
            return $now;
        }]);
        $routes = $rl->routes(['token' => 'secret']);
        $register = static fn (): int => $routes->handle(new Request('https://example.com/runlight/oauth/register', 'POST', ['content-type' => 'application/json'], '{"redirect_uris":["https://app.example.com/back"]}', '203.0.113.9'))->status;
        $statuses = array_map(static fn (): int => $register(), range(1, 11));
        $this->assertSame([...array_fill(0, 10, 201), 429], $statuses);
        $this->assertNull($rl->store->setting('oauth-registrations'), 'no count under a key that never changes');
        $this->assertCount(1, $rl->store->settingsStartingWith('throttle:oauth-register:'));
        $this->assertCount(1, $rl->store->settingsStartingWith('throttle-key:'));

        // A row an earlier version left, and no scheduled check: three days on, the first request clears it all.
        $rl->store->setSetting('oauth-registrations', '{"window":1,"counts":{"0123456789abcdef":3}}');
        $now += 3 * 86_400_000;
        $later = $this->made(['now' => fn (): int => $now]);
        $later->routes(['token' => 'secret'])->handle(Make::owner('/runlight/api/sites'));
        $this->assertNull($later->store->setting('oauth-registrations'));
        $this->assertSame([], $later->store->settingsStartingWith('throttle:'));
        $this->assertSame([], $later->store->settingsStartingWith('throttle-key:'));
        $this->assertSame((string) $now, $later->store->setting('tidied-at'));

        // The rate limit's files: a window that ended and the key of a day gone by go on the next request as well.
        $data = "{$this->dir}/data";
        mkdir($data, 0700);
        $rate = (string) Scratch::dir('runlight-rate', $data);
        file_put_contents("$rate/12345", '{"0123456789abcdef":4}');
        file_put_contents("$rate/key-19000", random_bytes(16));
        $shared = new Runlight(['store' => Stores::sqlite("{$this->dir}/shared.db"), 'dataDir' => $data, 'site' => ['id' => 'a']]);
        $shared->init();
        $this->assertSame([], glob("$rate/*"));
    }

    public function testASmtpNameThatDoesNotResolveIsRefusedRatherThanLookedUpAgain(): void
    {
        try {
            Smtp::send(['host' => 'smtp.runlight-nowhere.invalid', 'port' => '2525', 'security' => 'none'], ['to' => 'me@example.com', 'from' => 'reports@example.com', 'subject' => 's', 'text' => 't', 'html' => 'h'], 'reports@example.com');
            $this->fail('It connected.');
        } catch (MailError $error) {
            $this->assertSame('mail_unreachable', $error->code);
            $this->assertSame('the name does not resolve', $error->params['detail']);
        }
    }

    public function testAccountsWithNoSecretStaySignedInFromOneRequestToTheNext(): void
    {
        $routes = fn (): \Runlight\Routes => (new Runlight(['store' => Stores::sqlite("{$this->dir}/open.db"), 'now' => fn (): int => self::NOW, 'site' => ['id' => 'a']]))->routes(['token' => null, 'accounts' => true]);
        $form = (new SearchParams(['email' => 'jon@example.com', 'password' => 'a long password', 'again' => 'a long password']))->toString();
        $made = $routes()->handle(new Request('https://example.com/runlight/setup', 'POST', ['content-type' => 'application/x-www-form-urlencoded'], $form));
        $this->assertSame(303, $made->status);
        $cookie = explode(';', $made->headers->get('set-cookie') ?? '')[0];
        // Another request is another process, with nothing of the first one's left.
        $this->assertSame(200, $routes()->handle(new Request('https://example.com/runlight/api/sites', 'GET', ['cookie' => $cookie]))->status);
        $this->assertSame(401, $routes()->handle(new Request('https://example.com/runlight/api/sites'))->status);
    }

    public function testAnAppCarriesOnWhileTheDatabaseCannotSayWhichNamesAreLinkDomains(): void
    {
        $down = new class () implements Db {
            public int $asked = 0;

            public function dialect(): string
            {
                return 'sqlite';
            }

            public function all(string $sql, array $params = []): array
            {
                $this->asked++;
                throw new \RuntimeException('the database is down');
            }

            public function run(string $sql, array $params = []): void
            {
                $this->asked++;
                throw new \RuntimeException('the database is down');
            }

            public function transaction(callable $fn): mixed
            {
                return $fn($this);
            }

            public function exclusive(callable $fn): mixed
            {
                return $fn($this);
            }

            public function close(): void
            {
            }
        };
        $logged = [];
        \Runlight\Log::to(static function (string $line) use (&$logged): void {
            $logged[] = $line;
        });
        try {
            $now = self::NOW;
            $rl = new Runlight(['store' => Stores::fromDb($down), 'now' => function () use (&$now): int {
                return $now;
            }]);
            $page = new Request('https://app.example.com/pricing');
            $this->assertNull($rl->linkDomainResponse($page), 'the app answers its own page');
            $asked = $down->asked;
            $this->assertGreaterThan(0, $asked);
            $this->assertNull($rl->linkDomainResponse($page));
            $this->assertSame($asked, $down->asked, 'not asked again for a few seconds');
            $now += 6000;
            $this->assertNull($rl->linkDomainResponse($page));
            $this->assertGreaterThan($asked, $down->asked);
            $this->assertCount(2, $logged);

            // On its own clock the word is shared, so the next request, a process of its own, does not ask either.
            $data = "{$this->dir}/down";
            mkdir($data, 0700);
            $first = new Runlight(['store' => Stores::fromDb($down), 'dataDir' => $data]);
            $this->assertNull($first->linkDomainResponse($page));
            $asked = $down->asked;
            $second = new Runlight(['store' => Stores::fromDb($down), 'dataDir' => $data]);
            $this->assertNull($second->linkDomainResponse($page));
            $this->assertSame($asked, $down->asked);
        } finally {
            \Runlight\Log::to(null);
        }
    }
}
