<?php

declare(strict_types=1);

namespace Runlight\Tests\Cms;

use PHPUnit\Framework\TestCase;
use Runlight\Cms\Connect;
use Runlight\Http\Fetcher;
use Runlight\Http\FetchError;
use Runlight\Http\Request;
use Runlight\Http\Response;
use Runlight\Http\Url;
use Runlight\Json;
use Runlight\OAuth;
use Runlight\Routes;
use Runlight\Tests\Conformance\Player;
use Runlight\Tests\Core\Router;
use Runlight\Tests\Routes\Make;

/** A CMS plugin's Connect, against a Runlight in this process, as the WordPress, Drupal, and Craft plugins run it. */
final class ConnectTest extends TestCase
{
    private const BACK = 'https://cms.example/admin/runlight/connected';

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

    /** A Fetcher that hands each request to a Runlight's routes, recording the addresses asked. */
    private static function served(Routes $routes, array &$asked = []): Fetcher
    {
        return new class ($routes, $asked) implements Fetcher {
            /** @param list<string> $asked */
            public function __construct(private readonly Routes $routes, private array &$asked)
            {
            }

            public function fetch(string $url, array $init = []): Response
            {
                $this->asked[] = ($init['method'] ?? 'GET') . ' ' . $url;
                return $this->routes->handle(new Request($url, $init['method'] ?? 'GET', $init['headers'] ?? [], $init['body'] ?? ''));
            }
        };
    }

    /** The plugin's words: each code, with its details as JSON. */
    private static function say(string $code, array $params): string
    {
        return $params === [] ? $code : $code . ' ' . Json::encode($params);
    }

    public function testAPluginConnectsAndGetsItsSitesKeysOverOAuth(): void
    {
        Make::needsCore($this);
        $rl = Make::runlight(['sites' => [['id' => 'blog', 'name' => 'Blog', 'hostnames' => ['cms.example']]]]);
        $routes = $rl->routes(['token' => 'secret']);
        $asked = [];
        $connect = new Connect(self::served($routes, $asked), self::BACK, self::say(...));

        // A default port is the same origin as none, so the endpoints the metadata names pass the check.
        [$to, $pending, $error] = $connect->start('https://x.com:443/runlight', 'kept as entered');
        $this->assertSame('', $error);
        $consent = new Url((string) $to);
        $this->assertSame('https://x.com/runlight/oauth/authorize', $consent->origin() . $consent->pathname);
        $q = $consent->searchParams();
        $this->assertSame(['code', self::BACK, 'S256', 'cms'], [$q->get('response_type'), $q->get('redirect_uri'), $q->get('code_challenge_method'), $q->get('scope')]);
        $this->assertSame($pending['state'], $q->get('state'));
        $this->assertSame(OAuth::s256($pending['verifier']), $q->get('code_challenge'), 'the challenge is the verifier hashed');
        $this->assertSame('kept as entered', $pending['address']);
        $this->assertSame(['GET https://x.com:443/runlight/.well-known/oauth-authorization-server', 'POST https://x.com/runlight/oauth/register'], $asked);

        // The owner picks the site on the consent page, and the Runlight sends the admin back.
        $form = ['authorization' => 'Bearer secret', 'origin' => 'https://x.com', 'content-type' => 'application/x-www-form-urlencoded'];
        $allowed = $routes->handle(new Request('https://x.com/runlight/oauth/authorize', 'POST', $form, $q->toString() . '&decision=allow&site=blog'));
        $back = new Url($allowed->headers->get('location') ?? '');
        $this->assertSame(self::BACK, $back->origin() . $back->pathname);
        $query = [];
        foreach ($back->searchParams() as $name => $value) {
            $query[$name] = $value;
        }

        [$granted, $message] = $connect->finish($query, $pending);
        $this->assertSame('connected {"site":"blog"}', $message);
        $this->assertSame(['kept as entered', 'blog'], [$granted['address'], $granted['site']]);
        $this->assertSame(OAuth::agentsKey($rl, 'blog'), $granted['agentsKey']);
        $tokens = Make::body($routes->handle(Make::owner('/runlight/api/tokens')))['tokens'];
        $this->assertSame([['embed', 'blog']], array_map(static fn (array $t): array => [$t['scope'], $t['site']], $tokens), 'the dashboard key is the site\'s embed token');

        // A code works once.
        $this->assertSame([null, 'keys'], $connect->finish($query, $pending));
    }

    public function testWhatWentWrongIsSaidInThePluginsWords(): void
    {
        Make::needsCore($this);
        $rl = Make::runlight(['sites' => [['id' => 'blog', 'name' => 'Blog', 'hostnames' => ['cms.example']]]]);
        $connect = new Connect(self::served($rl->routes(['token' => 'secret'])), self::BACK, self::say(...));
        $this->assertSame([null, null, 'address'], $connect->start(''));
        $this->assertSame([null, null, 'scheme'], $connect->start('ftp://x.com'));
        $plain = new Connect(self::served($rl->routes(['token' => 'secret'])), 'http://cms.example/connected', self::say(...));
        $this->assertSame([null, null, 'https'], $plain->start('https://x.com/runlight'));
        $this->assertNotNull((new Connect(self::served($rl->routes(['token' => 'secret'])), 'http://localhost:8080/connected', self::say(...)))->start('https://x.com/runlight')[0], 'this computer needs no https');

        [, $pending] = $connect->start('https://x.com/runlight');
        $state = $pending['state'];
        $this->assertSame([null, 'expired'], $connect->finish(['state' => $state], null), 'nothing kept, or kept for someone else');
        $this->assertSame([null, 'expired'], $connect->finish(['state' => 'another'], $pending));
        $this->assertSame([null, 'denied'], $connect->finish(['state' => $state, 'error' => 'access_denied'], $pending));
        $this->assertSame([null, 'failed {"reason":"Sign in again"}'], $connect->finish(['state' => $state, 'error' => 'server_error', 'error_description' => 'Sign in again'], $pending));
        $this->assertSame([null, 'failed {"reason":"server_error"}'], $connect->finish(['state' => $state, 'error' => 'server_error'], $pending));
    }

    public function testOnlyARunlightsOwnEndpointsAreFollowed(): void
    {
        $meta = static fn (array $changes = []): array => $changes + [
            'authorization_endpoint' => 'https://x.com/runlight/oauth/authorize',
            'token_endpoint' => 'https://x.com/runlight/oauth/token',
            'registration_endpoint' => 'https://x.com/runlight/oauth/register',
            'scopes_supported' => ['read', 'manage', 'cms'],
        ];
        $hostile = new Router([['#/\.well-known/oauth-authorization-server$#', static fn () => $meta(['token_endpoint' => 'http://169.254.169.254/token'])]]);
        $this->assertSame([null, null, 'unknown {"address":"https://x.com/runlight"}'], (new Connect($hostile, self::BACK, self::say(...)))->start('https://x.com/runlight'));
        $this->assertCount(1, $hostile->requests, 'nothing else was asked');
        $nothing = new Router([]);
        $this->assertSame('unknown {"address":"https://x.com/runlight"}', (new Connect($nothing, self::BACK, self::say(...)))->start('https://x.com/runlight')[2]);
        $older = new Router([['#/\.well-known/oauth-authorization-server$#', static fn () => $meta(['scopes_supported' => ['read', 'manage']])]]);
        $this->assertSame('older', (new Connect($older, self::BACK, self::say(...)))->start('https://x.com/runlight')[2]);
        $refused = new Router([
            ['#/\.well-known/oauth-authorization-server$#', static fn () => $meta()],
            ['#/oauth/register$#', static fn () => [400, ['error' => 'invalid_redirect_uri', 'error_description' => 'Use https']]],
        ]);
        $this->assertSame('refused {"reason":"Use https"}', (new Connect($refused, self::BACK, self::say(...)))->start('https://x.com/runlight')[2]);
        $silent = new Router([['#/\.well-known/oauth-authorization-server$#', static fn () => $meta()], ['#/oauth/register$#', static fn () => [500, []]]]);
        $this->assertSame('refused {"reason":"silent"}', (new Connect($silent, self::BACK, self::say(...)))->start('https://x.com/runlight')[2]);
        $registration = Json::decode($silent->requests[1]['init']['body'], true);
        $this->assertSame(['client_name' => 'client {"host":"cms.example"}', 'redirect_uris' => [self::BACK]], $registration, 'named for the address the Runlight sends the admin back to');
        $this->assertSame('manual', $silent->requests[0]['init']['redirect'], 'a redirect is never followed');
    }

    public function testAFailedRequestSaysWhy(): void
    {
        $down = new class () implements Fetcher {
            public function fetch(string $url, array $init = []): Response
            {
                throw new FetchError('Connection refused');
            }
        };
        $connect = new Connect($down, self::BACK, self::say(...));
        $this->assertSame('unreachable {"address":"https://x.com/runlight","error":"Connection refused"}', $connect->start('https://x.com/runlight')[2]);
        $pending = ['state' => 's', 'verifier' => 'v', 'client' => 'c', 'token' => 'https://x.com/runlight/oauth/token', 'address' => 'https://x.com/runlight'];
        $this->assertSame([null, 'lost {"error":"Connection refused"}'], $connect->finish(['state' => 's', 'code' => 'c'], $pending));
    }

    public function testAnOriginIsWrittenAsABrowserWritesIt(): void
    {
        $this->assertSame('https://x.com', Connect::origin('HTTPS://X.com:443/runlight'));
        $this->assertSame('http://x.com:8080', Connect::origin('http://x.com:8080/'));
        $this->assertSame('http://x.com', Connect::origin('http://x.com:80'));
        $this->assertSame('', Connect::origin('x.com'));
        $this->assertTrue(Connect::returnable('https://cms.example/back'));
        $this->assertTrue(Connect::returnable('http://127.0.0.1:8080/back'));
        $this->assertFalse(Connect::returnable('http://cms.example/back'));
    }
}
