<?php

declare(strict_types=1);

namespace Runlight\Tests\Accounts;

use PHPUnit\Framework\TestCase;
use Runlight\Accounts\Pages;
use Runlight\Http\Request;
use Runlight\Http\Response;
use Runlight\Http\SearchParams;
use Runlight\Json;
use Runlight\Messages;
use Runlight\Runlight;
use Runlight\Store\Stores;
use Runlight\Tests\Conformance\Player;

/** The account and OAuth pages in the visitor's language, as account-languages.test.ts tests them. */
final class LanguagesTest extends TestCase
{
    private const FRENCH = ['accept-language' => 'fr-FR,fr;q=0.9,en;q=0.8'];

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

    /** @param array<string, string> $headers */
    private static function req(string $path, string $method = 'GET', array $headers = [], string $body = ''): Request
    {
        return new Request("https://example.com$path", $method, $headers, $body);
    }

    /** @param array<string, string> $fields @param array<string, string> $headers */
    private static function form(string $path, array $fields, array $headers = []): Request
    {
        return self::req($path, 'POST', ['content-type' => 'application/x-www-form-urlencoded'] + $headers, (new SearchParams($fields))->toString());
    }

    private static function cookieOf(Response $response): string
    {
        return explode(';', $response->headers->getSetCookie()[0] ?? '')[0];
    }

    public function testAcceptLanguagePicksTheFirstLanguageTheDashboardSpeaks(): void
    {
        $pick = static fn (string $header): string => Messages::acceptedLanguage(self::req('/', 'GET', ['accept-language' => $header]));
        $this->assertSame('fr', $pick('fr-FR,fr;q=0.9,en;q=0.8'));
        $this->assertSame('de', $pick('xx, DE-at;q=0.5'));
        $this->assertSame('en', $pick('xx,yy'));
        $this->assertSame('en', Messages::acceptedLanguage(self::req('/')));
    }

    public function testAMessageForAPageEscapesItsOwnTextAndFillsOnlyWhatTheCallerMadeSafe(): void
    {
        $h = Messages::translator('en')['html'];
        $this->assertSame('Open your Runlight dashboard at <a href="/">x</a> and sign in, then connect Claude &lt;b&gt; again.', $h('oauth.signIn', ['link' => '<a href="/">x</a>', 'app' => 'Claude &lt;b&gt;']));
        $this->assertSame('Connect {app}', $h('oauth.connectTitle'), 'a name nobody gave stays as it is');
    }

    public function testEveryAccountPageComesOutInFrenchWhenAsked(): void
    {
        $cases = [
            ['sign in', Pages::loginPage('/runlight', ['forgot' => 'https://runlight.sh/docs'], 'fr'), 'Se connecter'],
            ['the code step', Pages::codePage('/runlight', ['pending' => 'p', 'next' => '/'], 'fr'), 'Saisissez votre code'],
            ['an invite', Pages::invitePage('/runlight', ['code' => 'c', 'email' => 'a@example.com', 'role' => 'viewer', 'host' => 'stats.example.com'], 'fr'), 'Rejoindre Runlight'],
            ['an invite that is gone', Pages::inviteGonePage('/runlight', 'fr'), 'Cette invitation ne fonctionne plus'],
            ['setup', Pages::setupPage('/runlight', ['code' => '', 'askCode' => true], 'fr'), 'Créez votre compte'],
            ['setup locked', Pages::setupLockedPage('/runlight', false, 'fr'), 'Terminez la configuration'],
            ['setup needing a token', Pages::setupNeedsTokenPage('/runlight', 'fr'), 'Terminez la configuration'],
        ];
        foreach ($cases as [$name, $html, $heading]) {
            $this->assertStringContainsString('<html lang="fr">', $html, $name);
            $this->assertStringContainsString("<h1>$heading</h1>", $html, $name);
            $this->assertStringContainsString("<title>$heading | Runlight</title>", $html, $name);
            $this->assertStringContainsString('<script src="/runlight/auth.js?lang=fr"></script>', $html, "$name loads the French script");
            $this->assertStringContainsString('aria-label="Changer de thème"', $html, $name);
        }
        $invite = Pages::invitePage('', ['code' => 'c', 'email' => 'a@example.com', 'role' => 'member', 'host' => 'stats.example.com', 'site' => '<Blog>'], 'fr');
        $this->assertStringContainsString('Votre rôle : membre, qui peut modifier les réglages de &lt;Blog&gt; uniquement.', $invite, 'the role is French too, and the site name stays escaped');
        $this->assertStringContainsString('<a href="https://x.example/?a=1&amp;b=2" target="_blank" rel="noopener">la documentation explique', Pages::loginPage('', ['forgot' => 'https://x.example/?a=1&b=2'], 'fr'));
        $script = Pages::authJs('fr');
        foreach (['"Afficher le mot de passe"', '"Masquer le mot de passe"', '"Thème : réglage de l’appareil"', '"Thème : sombre"', '["Trop court", "Faible", "Moyen", "Bon", "Fort"]'] as $words) {
            $this->assertStringContainsString($words, $script, $words);
        }
        $this->assertStringNotContainsString('Show password', $script);
        $this->assertSame(Pages::AUTH_JS, Pages::authJs('en'));
        $this->assertSame(Pages::AUTH_JS, Pages::authJs('xx'), 'a language Runlight does not speak is English');
    }

    public function testTheSetupLockedPageSaysWhereTheFileIsInEveryLanguage(): void
    {
        $en = Pages::setupLockedPage('', true);
        $this->assertStringContainsString("<p>Runlight has no account yet. Open the setup link in the file setup.txt in Runlight's data folder (<code>vendor/bin/runlight setup</code> prints it too), which carries a one-time code, to create the first account.</p>", $en);
        $this->assertStringContainsString('<html lang="en">', $en);
        $fr = Pages::setupLockedPage('', true, 'fr');
        $this->assertStringContainsString('<html lang="fr">', $fr);
        $this->assertStringContainsString('<code>vendor/bin/runlight setup</code>', $fr);
        $this->assertStringContainsString('setup.txt', $fr);
        $this->assertStringNotContainsString('Runlight has no account yet', $fr);
        $this->assertNotSame(Pages::setupLockedPage('', false, 'fr'), $fr, 'and not the sentence about a log');
    }

    public function testTheAccountRoutesAnswerInTheBrowsersLanguageAndInEnglishAsBeforeWithoutOne(): void
    {
        $rl = new Runlight(['store' => Stores::sqlite(':memory:'), 'secret' => str_repeat('k', 64)]);
        $routes = $rl->routes(['token' => 'app-token', 'accounts' => true]);
        $get = static fn (string $path, array $headers = []): string => $routes->handle(self::req("/runlight$path", 'GET', $headers))->text();

        $setup = $get('/setup', self::FRENCH);
        $this->assertStringContainsString('<html lang="fr">', $setup);
        $this->assertStringContainsString('<h1>Créez votre compte</h1>', $setup);
        $english = $get('/setup', ['accept-language' => 'en-GB,fr;q=0.5']);
        $this->assertSame($get('/setup'), $english, 'English asked for is English as it always was');
        $this->assertStringContainsString('<html lang="en">', $english);
        $this->assertStringContainsString('<script src="/runlight/auth.js"></script>', $english);
        $this->assertStringContainsString('<html lang="en">', $get('/setup', ['accept-language' => 'xx']), 'an unknown language is English');

        $fields = ['code' => 'guess', 'email' => 'jon@example.com', 'password' => 'a long password', 'again' => 'a long password'];
        $this->assertStringContainsString('Ce n’est pas le RUNLIGHT_TOKEN de cette application.', $routes->handle(self::form('/runlight/setup', $fields, self::FRENCH))->text());
        $short = ['code' => 'app-token', 'email' => 'jon@example.com', 'password' => 'short', 'again' => 'short'];
        $this->assertStringContainsString('Utilisez un mot de passe d’au moins 10 caractères.', $routes->handle(self::form('/runlight/setup', $short, self::FRENCH))->text());
        $this->assertStringContainsString('role="alert">Use a password of at least 10 characters</p>', $routes->handle(self::form('/runlight/setup', $short))->text());

        $owner = self::cookieOf($routes->handle(self::form('/runlight/setup', ['code' => 'app-token', 'email' => 'jon@example.com', 'password' => 'a long password', 'again' => 'a long password'])));
        $wrong = $routes->handle(self::form('/runlight/login', ['email' => 'jon@example.com', 'password' => 'not the password'], self::FRENCH));
        $this->assertSame(401, $wrong->status);
        $this->assertStringContainsString('Cet e-mail et ce mot de passe ne correspondent à aucun compte.', $wrong->text());
        $this->assertStringContainsString('Ce lien de connexion a expiré.', $get('/login/link?ticket=nope', self::FRENCH));

        $sent = Json::decode($routes->handle(self::req('/runlight/api/people', 'POST', ['cookie' => $owner, 'content-type' => 'application/json'], Json::encode(['allSites' => true, 'email' => 'mo@example.com', 'role' => 'viewer'])))->text(), true);
        $link = parse_url($sent['link']);
        parse_str($link['query'], $query);
        $this->assertStringContainsString('Votre rôle : lecteur, qui peut lire les statistiques de tous les sites.', $get(substr($link['path'], strlen('/runlight')) . '?' . $link['query'], self::FRENCH));
        $mismatch = $routes->handle(self::form('/runlight/invite', ['code' => $query['code'], 'password' => 'a long password', 'again' => 'another one'], self::FRENCH))->text();
        $this->assertStringContainsString('Les deux mots de passe ne sont pas identiques.', $mismatch);
        $this->assertStringContainsString('<h1>Cette invitation ne fonctionne plus</h1>', $get('/invite?code=nope', self::FRENCH));

        $this->assertSame(Pages::AUTH_JS, $get('/auth.js', self::FRENCH));
        $this->assertSame(Pages::authJs('fr'), $get('/auth.js?lang=fr'));

        $locked = (new Runlight(['store' => Stores::sqlite(':memory:'), 'secret' => str_repeat('k', 64)]))->routes(['accounts' => true]);
        $page = $locked->handle(self::req('/runlight/setup', 'GET', self::FRENCH));
        $this->assertSame(403, $page->status);
        $this->assertStringContainsString('<h1>Terminez la configuration</h1>', $page->text());
    }

    public function testTheOauthConsentPageAndItsMessagesComeOutInFrenchWhenAsked(): void
    {
        $rl = new Runlight(['store' => Stores::sqlite(':memory:'), 'sites' => [['id' => 'a', 'name' => 'Site A', 'hostnames' => ['a.com']], ['id' => 'b', 'name' => 'Site B', 'hostnames' => ['b.com']]]]);
        $routes = $rl->routes(['token' => 'secret']);
        $callback = 'https://claude.ai/api/mcp/auth_callback';
        $registered = $routes->handle(self::req('/runlight/oauth/register', 'POST', ['content-type' => 'application/json'], Json::encode(['client_name' => 'Claude', 'redirect_uris' => [$callback]])));
        $clientId = Json::decode($registered->text(), true)['client_id'];
        $params = (new SearchParams(['response_type' => 'code', 'client_id' => $clientId, 'redirect_uri' => $callback, 'code_challenge' => str_repeat('a', 43), 'code_challenge_method' => 'S256']))->toString();
        $owner = ['authorization' => 'Bearer secret'];
        $page = static fn (string $query, array $headers): string => $routes->handle(self::req("/runlight/oauth/authorize?$query", 'GET', $headers))->text();

        $consent = $page($params, $owner + self::FRENCH);
        $this->assertStringContainsString('<html lang="fr">', $consent);
        $this->assertStringContainsString('<title>Connecter Claude | Runlight</title>', $consent);
        $this->assertStringContainsString('<h1>Connecter Claude</h1>', $consent);
        $this->assertStringContainsString('<strong>Claude</strong> veut lire vos statistiques Runlight', $consent);
        $this->assertStringContainsString('Autoriser vous renvoie vers <strong>claude.ai</strong>.', $consent);
        $this->assertStringContainsString('<option value="">Tous les sites</option><option value="a">Site A uniquement</option>', $consent);
        $this->assertStringContainsString('class="ghost">Refuser</button><button type="submit" name="decision" value="allow">Autoriser</button>', $consent);
        $english = $page($params, $owner);
        $this->assertStringContainsString('<html lang="en">', $english);
        $this->assertStringContainsString('<h1>Connect Claude</h1>', $english);
        $this->assertStringContainsString('<strong>Claude</strong> wants to read your Runlight stats so it can answer questions about them.', $english);

        $this->assertStringContainsString('Son jeton apparaît dans Réglages, MCP &amp; API, où le supprimer déconnecte Claude.', $page("$params&scope=manage", $owner + self::FRENCH));
        $signedOut = $routes->handle(self::req("/runlight/oauth/authorize?$params", 'GET', self::FRENCH));
        $this->assertSame(401, $signedOut->status);
        $this->assertStringContainsString('<h1>Connectez-vous d’abord</h1>', $signedOut->text());
        $this->assertStringContainsString('<h1>Cette application n’est pas enregistrée</h1><p>Recommencez la connexion depuis l’application.</p>', $page(str_replace($clientId, 'nope', $params), $owner + self::FRENCH));
        $forged = $routes->handle(self::req('/runlight/oauth/authorize', 'POST', $owner + self::FRENCH + ['origin' => 'https://evil.example', 'content-type' => 'application/x-www-form-urlencoded'], "$params&decision=allow"));
        $this->assertSame(403, $forged->status);
        $this->assertStringContainsString('<h1>Cette demande vient d’un autre site</h1>', $forged->text());
    }
}
