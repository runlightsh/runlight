<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Core\Cache\CacheBackendInterface;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\DestructableInterface;
use Drupal\Core\Language\LanguageManagerInterface;
use Drupal\Core\Mail\MailManagerInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\State\StateInterface;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use GuzzleHttp\ClientInterface;
use Psr\Log\LoggerInterface;
use Runlight\Bridge\HttpFoundation;
use Runlight\Http\Request;
use Runlight\Log;
use Runlight\Routes;
use Runlight\Runlight;
use Runlight\Server\DbIp;
use Symfony\Component\HttpFoundation\Request as SymfonyRequest;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * Runlight running in this Drupal.
 *
 * Its dashboard and endpoints are at /runlight on this site, its numbers in
 * this site's database, the people who may administer Runlight are its
 * owners, those who may view it its readers, and Drupal's cron runs its
 * hourly upkeep.
 */
final class Local implements DestructableInterface {

  use StringTranslationTrait;

  /**
   * The state entry holding the secret Runlight signs with, made once.
   */
  public const SECRET = 'runlight.secret';

  /**
   * The state entry holding the host the site was last visited at.
   */
  public const HOST = 'runlight.host';

  /**
   * The state entry holding when the upkeep last finished, or was first due.
   */
  public const CHECKED = 'runlight.checked';

  /**
   * This site's id in Runlight, which counts this one site.
   */
  public const SITE = 'default';

  /**
   * Runlight, once made in this request.
   */
  private ?Runlight $runlight = NULL;

  /**
   * Runlight's routes, once made in this request.
   */
  private ?Routes $routes = NULL;

  /**
   * The request last seen.
   */
  private ?SymfonyRequest $seen = NULL;

  public function __construct(
    private readonly ConfigFactoryInterface $configFactory,
    private readonly StateInterface $state,
    private readonly Setup $setup,
    private readonly Storage $storage,
    private readonly AccountInterface $currentUser,
    private readonly RequestStack $requestStack,
    private readonly ClientInterface $httpClient,
    private readonly LoggerInterface $logger,
    private readonly CacheBackendInterface $cacheBackend,
    private readonly TimeInterface $time,
    private readonly MailManagerInterface $mailManager,
    private readonly LanguageManagerInterface $languageManager,
  ) {}

  /**
   * Whether Runlight runs in this Drupal.
   *
   * @return bool
   *   Chosen in the settings, and possible on this server.
   */
  public function active(): bool {
    return $this->setup->mode() === 'local' && $this->missing() === '';
  }

  /**
   * What stops Runlight running in this Drupal.
   *
   * @return string
   *   A sentence for the settings page, or an empty string when nothing does.
   */
  public function missing(): string {
    // Composer brings the library with the module; a copy put in place by
    // hand has none.
    if (!class_exists(Runlight::class)) {
      return (string) $this->t('Running Runlight in this Drupal needs the Runlight library, which Composer installs with the module. Install the module with <code>composer require drupal/runlight</code>.');
    }
    foreach (['pdo', 'mbstring', 'openssl'] as $extension) {
      if (!extension_loaded($extension)) {
        return (string) $this->t('Running Runlight in this Drupal needs PHP’s @extension extension, which this server does not have.', ['@extension' => $extension]);
      }
    }
    if ($this->storage->kind() === '' && $this->storage->clash()) {
      return (string) $this->t('Drupal’s database already has tables starting @prefix that are not this site’s Runlight’s, so Runlight leaves them alone. Running it in this Drupal then needs a private files folder, set with <code>@setting</code> in settings.php, and PHP’s pdo_sqlite extension for a SQLite file there.', [
        '@prefix' => $this->storage->prefix(),
        '@setting' => "\$settings['file_private_path']",
      ]);
    }
    if ($this->storage->kind() === '') {
      return (string) $this->t('Running Runlight in this Drupal needs Drupal’s database on Postgres, MySQL 8.0.20, or MariaDB 11.4 or later, or else a private files folder, set with <code>@setting</code> in settings.php, and PHP’s pdo_sqlite extension for a SQLite file there.', ['@setting' => "\$settings['file_private_path']"]);
    }
    return '';
  }

  /**
   * The request being served.
   *
   * Once the answer is out, Drupal has taken it off the stack, and a page
   * from the page cache never put it there, so the one last seen stands in.
   *
   * @param \Symfony\Component\HttpFoundation\Request|null $seen
   *   A request the caller has, which then stands in.
   *
   * @return \Symfony\Component\HttpFoundation\Request|null
   *   The request, if there is one.
   */
  public function request(?SymfonyRequest $seen = NULL): ?SymfonyRequest {
    $this->seen = $seen ?? $this->requestStack->getCurrentRequest() ?? $this->seen;
    return $this->seen;
  }

  /**
   * The request as Runlight reads it.
   *
   * The URL is the one the browser asked for, escapes and all, and the
   * visitor's address is the one Drupal works out, which follows its
   * reverse_proxy settings, since Runlight believes no header itself here.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request Drupal is serving.
   *
   * @return \Runlight\Http\Request
   *   Runlight's request.
   *
   * @throws \Runlight\Http\BodyTooLarge
   *   When the body is past Runlight's limit.
   */
  public static function visitorRequest(SymfonyRequest $request): Request {
    $read = HttpFoundation::request($request);
    return new Request($read->url, $read->method, $read->headers, $read->text(), (string) $request->getClientIp());
  }

  /**
   * The path Runlight answers under, after the folder Drupal lives in, if any.
   */
  public function base(): string {
    return rtrim((string) $this->request()?->getBasePath(), '/') . '/runlight';
  }

  /**
   * Runlight's full address on this site.
   */
  public function address(): string {
    $request = $this->request();
    return ($request !== NULL ? $request->getSchemeAndHttpHost() : '') . $this->base();
  }

  /**
   * This site's domains, as Runlight counts them.
   *
   * Drupal knows its domain only from requests, so the last one a visit came
   * to is kept for cron, which runs with none. An address such as 127.0.0.1
   * is no domain, so then any host counts.
   *
   * @return list<string>
   *   The domain, or none.
   */
  private function hostnames(): array {
    $request = $this->request();
    $host = PHP_SAPI === 'cli' || $request === NULL ? '' : strtolower($request->getHost());
    if ($host !== '' && !filter_var(trim($host, '[]'), FILTER_VALIDATE_IP) && $host !== $this->state->get(self::HOST)) {
      $this->state->set(self::HOST, $host);
    }
    if ($host === '') {
      $host = (string) $this->state->get(self::HOST, '');
    }
    return $host === '' || filter_var(trim($host, '[]'), FILTER_VALIDATE_IP) ? [] : [$host];
  }

  /**
   * Drupal's default timezone, when Runlight knows it.
   */
  private function timezone(): string {
    $zone = (string) $this->configFactory->get('system.date')->get('timezone.default');
    return in_array($zone, \DateTimeZone::listIdentifiers(), TRUE) ? $zone : 'UTC';
  }

  /**
   * The secret Runlight signs sessions and tickets with, made the first time.
   */
  private function secret(): string {
    $secret = (string) $this->state->get(self::SECRET, '');
    if ($secret === '') {
      $secret = bin2hex(random_bytes(32));
      $this->state->set(self::SECRET, $secret);
    }
    return $secret;
  }

  /**
   * Whether visitors' countries are looked up.
   */
  private function locations(): bool {
    return (bool) $this->configFactory->get('runlight.settings')->get('locations');
  }

  /**
   * DB-IP's free country data, kept in Runlight's folder.
   */
  private function dbIp(): DbIp {
    return new DbIp(
      $this->storage->geoFolder(),
      'country',
      [new Fetcher($this->httpClient, $this->logger), 'download'],
      fn (string $line) => $this->logger->info('@line', ['@line' => $line]),
    );
  }

  /**
   * Runlight's shared values, in Drupal's cache.
   */
  public function cache(): Cache {
    return new Cache($this->cacheBackend, $this->time);
  }

  /**
   * Runlight, made on first use in a request.
   */
  public function runlight(): Runlight {
    if ($this->runlight !== NULL) {
      return $this->runlight;
    }
    // Runlight's notes, such as a report it could not send, go to Drupal's log.
    Log::to(fn (string $line) => $this->logger->warning('@line', ['@line' => $line]));
    $name = trim(strip_tags((string) $this->configFactory->get('system.site')->get('name')));
    $hostnames = $this->hostnames();
    $options = [
      'store' => $this->storage->store(),
      'site' => [
        'id' => self::SITE,
        'name' => $name !== '' ? $name : ($hostnames[0] ?? 'My site'),
        'hostnames' => $hostnames,
        'timezone' => $this->timezone(),
      ],
      'secret' => $this->secret(),
      // The visitor's address comes with each request, as Drupal works it out
      // from its reverse_proxy settings, so no header is believed here.
      'trustProxy' => FALSE,
      'fetcher' => new Fetcher($this->httpClient, $this->logger),
      // Rate counts and the site's icon go in Drupal's cache, never in files.
      'cache' => $this->cache(),
      'linkPath' => rtrim((string) $this->request()?->getBasePath(), '/') . '/go',
    ];
    if ($this->locations()) {
      $lookup = $this->dbIp()->lookup();
      if ($lookup !== NULL) {
        $options['geo'] = $lookup;
      }
    }
    // With a mailer such as SMTP set up, reports go through Drupal, until the
    // dashboard names another service.
    $mailer = Mailer::option($this->configFactory, $this->mailManager, $this->languageManager->getDefaultLanguage()->getId());
    if ($mailer !== NULL) {
      $options['mail'] = $mailer;
    }
    return $this->runlight = new Runlight($options);
  }

  /**
   * Runlight's routes, signed in through Drupal.
   */
  public function routes(): Routes {
    if ($this->routes !== NULL) {
      return $this->routes;
    }
    $request = $this->request();
    return $this->routes = $this->runlight()->routes([
      'basePath' => $this->base(),
      'token' => NULL,
      // Given here, so Runlight never reads them from the environment: Drupal's
      // cron runs the upkeep, and no other site reports AI agents to this one.
      'cronSecret' => '',
      'observeKey' => '',
      'authorize' => fn (Request $request): bool|string => $this->access($request),
      'signIn' => $this->base() . '/login',
      'origin' => $request !== NULL ? $request->getSchemeAndHttpHost() : NULL,
      'geoCredit' => $this->locations(),
      'cms' => 'Drupal',
    ]);
  }

  /**
   * What the signed-in user may do in Runlight.
   *
   * @param \Runlight\Http\Request $request
   *   The request, whose changes must come from this site's own pages.
   *
   * @return bool|string
   *   TRUE for an owner, "read" for a reader, FALSE for neither.
   */
  public function access(Request $request): bool|string {
    if (!self::sameSite($request)) {
      return FALSE;
    }
    if ($this->currentUser->hasPermission('administer runlight')) {
      return TRUE;
    }
    return $this->currentUser->hasPermission('view runlight') ? 'read' : FALSE;
  }

  /**
   * Whether a change comes from a page on the site it is sent to.
   *
   * Drupal's session cookie goes along with a request from any site, so a
   * change is taken only from this site's own pages, as the browser says
   * where a request comes from. Reading is safe from anywhere.
   *
   * @param \Runlight\Http\Request $request
   *   The request.
   */
  public static function sameSite(Request $request): bool {
    if (in_array($request->method, ['GET', 'HEAD', 'OPTIONS'], TRUE)) {
      return TRUE;
    }
    $fetch = strtolower((string) $request->headers->get('sec-fetch-site'));
    if ($fetch !== '') {
      return $fetch === 'same-origin' || $fetch === 'none';
    }
    $origin = (string) $request->headers->get('origin');
    if ($origin === '') {
      return TRUE;
    }
    return strtolower((string) parse_url($origin, PHP_URL_HOST)) === strtolower((string) parse_url($request->url, PHP_URL_HOST));
  }

  /**
   * Runs the upkeep: salts, reports, retention, totals, and location data.
   *
   * A failure is logged rather than thrown, so the rest of cron still runs.
   */
  public function check(): void {
    if (!$this->active()) {
      return;
    }
    try {
      if ($this->locations()) {
        $this->dbIp()->refresh((int) floor(microtime(TRUE) * 1000));
      }
      $this->runlight()->check();
      $this->cache()->sweep();
      $this->state->set(self::CHECKED, $this->time->getCurrentTime());
    }
    catch (\Throwable $e) {
      $this->logger->error('Runlight’s hourly check failed: @message', ['@message' => $e->getMessage()]);
    }
  }

  /**
   * Whether the upkeep has not finished for over a day.
   *
   * @return bool
   *   TRUE when cron is not running, or the check keeps failing.
   */
  public function overdue(): bool {
    $checked = $this->state->get(self::CHECKED);
    return is_int($checked) && $this->time->getCurrentTime() - $checked > 25 * 3600 && $this->active();
  }

  /**
   * Starts running Runlight here, once the admin has chosen it.
   *
   * The store is opened, which keeps the choice and makes the tables, so the
   * first visits never race to make them, and the upkeep is due from now.
   */
  public function start(): void {
    if (!is_int($this->state->get(self::CHECKED))) {
      $this->state->set(self::CHECKED, $this->time->getCurrentTime());
    }
    if ($this->missing() === '') {
      $this->storage->store();
    }
  }

  /**
   * Records a page served to an AI agent, once the page has been sent.
   *
   * @param string $url
   *   The page's address.
   * @param string $agent
   *   The agent's user agent.
   */
  public function observe(string $url, string $agent): void {
    $this->runlight()->observe(new Request($url, 'GET', ['user-agent' => $agent]));
  }

  /**
   * Finishes what Runlight left for after the answer.
   *
   * Such as a retention change's deletions, at the end of a request that made
   * it.
   */
  public function destruct(): void {
    $this->runlight?->idle();
  }

}
