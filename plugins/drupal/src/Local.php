<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Core\Config\ConfigBase;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\DestructableInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\State\StateInterface;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use GuzzleHttp\ClientInterface;
use Psr\Log\LoggerInterface;
use Runlight\Http\Request;
use Runlight\Routes;
use Runlight\Runlight;
use Runlight\Server\DbIp;
use Symfony\Component\HttpFoundation\Request as SymfonyRequest;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * Runlight running in this Drupal: its dashboard and endpoints at /runlight
 * on this site, its numbers in this site's database, the people who may
 * administer Runlight as its owners, and Drupal's cron for its hourly upkeep.
 */
final class Local implements DestructableInterface {

  use StringTranslationTrait;

  /** The state entry holding the secret Runlight signs with, made once. */
  public const SECRET = 'runlight.secret';

  /** This site's id in Runlight, which counts this one site. */
  public const SITE = 'default';

  private ?Runlight $runlight = NULL;
  private ?Routes $routes = NULL;
  private ?SymfonyRequest $seen = NULL;

  public function __construct(
    private readonly ConfigFactoryInterface $configFactory,
    private readonly StateInterface $state,
    private readonly Storage $storage,
    private readonly AccountInterface $currentUser,
    private readonly RequestStack $requestStack,
    private readonly ClientInterface $httpClient,
    private readonly LoggerInterface $logger,
  ) {}

  /**
   * Where Runlight runs: "local", "remote", or an empty string until the
   * admin chooses on the setup screen, so nothing is counted before then. An
   * address saved before there was a choice means another Runlight.
   */
  public static function mode(string|null $saved, string|null $address): string {
    return in_array($saved, ['local', 'remote'], TRUE) ? $saved : ((string) $address !== '' ? 'remote' : '');
  }

  /**
   * Whether Runlight is set up: running here, or another Runlight chosen with
   * at least its address or a key saved. Until then the settings page shows
   * the setup screen.
   */
  public static function setUp(ConfigBase $config): bool {
    $mode = self::mode($config->get('mode'), $config->get('address'));
    return $mode === 'local' || ($mode === 'remote' && ((string) $config->get('address') !== '' || (string) $config->get('observe_key') !== '' || (string) $config->get('dashboard_key') !== ''));
  }

  /** Whether Runlight runs in this Drupal: chosen in the settings, and possible on this server. */
  public function active(): bool {
    $config = $this->configFactory->get('runlight.settings');
    return self::mode($config->get('mode'), $config->get('address')) === 'local' && $this->missing() === '';
  }

  /**
   * What stops Runlight running in this Drupal, in a sentence for the
   * settings page, or an empty string when nothing does.
   */
  public function missing(): string {
    // Composer brings the library with the module; a copy put in place by hand has none.
    if (!class_exists(Runlight::class)) {
      return (string) $this->t('Running Runlight in this Drupal needs the Runlight library, which Composer installs with the module. Install the module with <code>composer require drupal/runlight</code>.');
    }
    foreach (['pdo', 'mbstring', 'openssl'] as $extension) {
      if (!extension_loaded($extension)) {
        return (string) $this->t('Running Runlight in this Drupal needs PHP’s @extension extension, which this server does not have.', ['@extension' => $extension]);
      }
    }
    if ($this->storage->kind() === '') {
      return (string) $this->t('Running Runlight in this Drupal needs PHP’s pdo_sqlite extension, or Drupal’s database on Postgres, or on MySQL 8.4 or MariaDB 11.4 or later, and this server has neither.');
    }
    return '';
  }

  /**
   * The request being served. Once the answer is out, Drupal has taken it
   * off the stack, and a page from the page cache never put it there, so the
   * one last seen stands in.
   */
  public function request(?SymfonyRequest $seen = NULL): ?SymfonyRequest {
    $this->seen = $seen ?? $this->requestStack->getCurrentRequest() ?? $this->seen;
    return $this->seen;
  }

  /** The path Runlight answers under, after the folder Drupal lives in, if any. */
  public function base(): string {
    return rtrim((string) $this->request()?->getBasePath(), '/') . '/runlight';
  }

  /** Runlight's full address on this site. */
  public function address(): string {
    $request = $this->request();
    return ($request !== NULL ? $request->getSchemeAndHttpHost() : '') . $this->base();
  }

  /** This site's domain, as Runlight counts it; an address such as 127.0.0.1 is no domain, so then any host counts. */
  private function hostnames(): array {
    $host = strtolower((string) $this->request()?->getHost());
    return $host === '' || filter_var(trim($host, '[]'), FILTER_VALIDATE_IP) ? [] : [$host];
  }

  /** Drupal's default timezone, when Runlight knows it. */
  private function timezone(): string {
    $zone = (string) $this->configFactory->get('system.date')->get('timezone.default');
    return in_array($zone, \DateTimeZone::listIdentifiers(), TRUE) ? $zone : 'UTC';
  }

  /** The secret Runlight signs sessions and tickets with, made the first time. */
  private function secret(): string {
    $secret = (string) $this->state->get(self::SECRET, '');
    if ($secret === '') {
      $secret = bin2hex(random_bytes(32));
      $this->state->set(self::SECRET, $secret);
    }
    return $secret;
  }

  /** Whether visitors' countries are looked up. */
  private function locations(): bool {
    return (bool) $this->configFactory->get('runlight.settings')->get('locations');
  }

  /** DB-IP's free country data, kept in Runlight's folder. */
  private function dbIp(): DbIp {
    return new DbIp(
      $this->storage->folder() . '/geo',
      'country',
      [new Fetcher($this->httpClient), 'download'],
      fn (string $line) => $this->logger->info('@line', ['@line' => $line]),
    );
  }

  /** Runlight, made on first use in a request. */
  public function runlight(): Runlight {
    if ($this->runlight !== NULL) {
      return $this->runlight;
    }
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
      // Hosts and CDNs in front of Drupal name the visitor in a header, and Runlight needs them told apart.
      'trustProxy' => TRUE,
      'fetcher' => new Fetcher($this->httpClient),
      'dataDir' => $this->storage->folder(),
      'linkPath' => rtrim((string) $this->request()?->getBasePath(), '/') . '/go',
    ];
    if ($this->locations()) {
      $lookup = $this->dbIp()->lookup();
      if ($lookup !== NULL) {
        $options['geo'] = $lookup;
      }
    }
    // With a mailer such as SMTP set up, reports go through Drupal, until the dashboard names another service.
    $mailer = property_exists(Runlight::class, 'appMailer')
      ? Mailer::option($this->configFactory, \Drupal::service('plugin.manager.mail'), \Drupal::languageManager()->getDefaultLanguage()->getId())
      : NULL;
    if ($mailer !== NULL) {
      $options['mail'] = $mailer;
    }
    return $this->runlight = new Runlight($options);
  }

  /** Runlight's routes, signed in through Drupal: those who may administer Runlight own it. */
  public function routes(): Routes {
    if ($this->routes !== NULL) {
      return $this->routes;
    }
    $request = $this->request();
    return $this->routes = $this->runlight()->routes([
      'basePath' => $this->base(),
      'token' => NULL,
      'authorize' => fn (): bool => $this->currentUser->hasPermission('administer runlight'),
      'signIn' => $this->base() . '/login',
      'origin' => $request !== NULL ? $request->getSchemeAndHttpHost() : NULL,
      'geoCredit' => $this->locations(),
      'cms' => 'Drupal',
    ]);
  }

  /** Runs the upkeep: salts, reports, retention, daily totals, and location data. */
  public function check(): void {
    if (!$this->active()) {
      return;
    }
    if ($this->locations()) {
      $this->dbIp()->refresh((int) floor(microtime(TRUE) * 1000));
    }
    $this->runlight()->check();
  }

  /** Records a page served to an AI agent, once the page has been sent. */
  public function observe(string $url, string $agent): void {
    $this->runlight()->observe(new Request($url, 'GET', ['user-agent' => $agent]));
  }

  /**
   * Finishes what Runlight left for after the answer, such as a retention
   * change's deletions, at the end of a request that made it.
   */
  public function destruct(): void {
    $this->runlight?->idle();
  }

}
