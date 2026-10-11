<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Component\Render\MarkupInterface;
use Drupal\Core\KeyValueStore\KeyValueExpirableFactoryInterface;
use Drupal\Core\KeyValueStore\KeyValueStoreExpirableInterface;
use Drupal\Core\Render\Markup;
use Drupal\Core\Routing\TrustedRedirectResponse;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Url;
use GuzzleHttp\ClientInterface;
use Runlight\Cms\Connect as CmsConnect;

/**
 * Connecting to a Runlight without copying keys.
 *
 * The package's Connect (Runlight\Cms\Connect) registers the module with the
 * Runlight's OAuth server, sends the admin to its consent page to pick this
 * site, and on the way back swaps the code, checked with PKCE, for the site's
 * dashboard key, agents key, and id. This class gives it Drupal's HTTP client
 * and the module's words, keeps the attempt in key-value storage, and keeps
 * the keys in state, never in exported configuration.
 */
final class Connect {

  use StringTranslationTrait;

  /**
   * The key-value collection holding attempts waiting on the consent page.
   */
  public const PENDING = 'runlight.connect';

  public function __construct(
    private readonly ClientInterface $httpClient,
    private readonly KeyValueExpirableFactoryInterface $keyValue,
    private readonly Setup $setup,
    private readonly AccountInterface $currentUser,
  ) {}

  /**
   * Where the Runlight sends the admin back to, which it is registered with.
   */
  private static function back(): string {
    return Url::fromRoute('runlight.connected', [], ['absolute' => TRUE])->toString(TRUE)->getGeneratedUrl();
  }

  /**
   * Attempts waiting on the consent page, one per admin, keyed by user id.
   */
  private function pending(): KeyValueStoreExpirableInterface {
    return $this->keyValue->get(self::PENDING);
  }

  /**
   * The scheme, host, and port of an address, as a browser writes its origin.
   *
   * A default port is left out, so https://x:443 and https://x are the same,
   * as in the package's Connect::origin(). The module keeps its own, so the
   * dashboard of a Runlight elsewhere opens without the package.
   *
   * @param string $address
   *   The address.
   *
   * @return string
   *   The origin, or an empty string for an address without one.
   */
  public static function origin(string $address): string {
    $parts = parse_url($address);
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
      return '';
    }
    $scheme = strtolower($parts['scheme']);
    $port = (int) ($parts['port'] ?? 0);
    $default = ($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80);
    return $scheme . '://' . strtolower($parts['host']) . ($port && !$default ? ':' . $port : '');
  }

  /**
   * The package's Connect, with Drupal's HTTP client and this module's words.
   *
   * @return \Runlight\Cms\Connect|null
   *   The package's Connect, or NULL when Composer did not install the
   *   package with the module.
   */
  private function connect(): ?CmsConnect {
    if (!class_exists(CmsConnect::class)) {
      return NULL;
    }
    return new CmsConnect(new Fetcher($this->httpClient), self::back(), fn (string $code, array $params): string => (string) $this->say($code, $params));
  }

  /**
   * What to say about each step of connecting, by the package's codes.
   *
   * @param string $code
   *   What happened.
   * @param array<string, string> $params
   *   Its details.
   */
  private function say(string $code, array $params): TranslatableMarkup|string {
    return match ($code) {
      'address' => $this->t('Enter your Runlight’s address, then press Connect.'),
      'scheme' => $this->t('Enter a web address, such as https://stats.example.com.'),
      'https' => $this->t('Connecting needs this site’s admin on https. Copy the keys from Runlight’s Settings, Install into the fields below instead.'),
      'unreachable' => $this->t('Could not reach a Runlight at @address: @error', [
        '@address' => $params['address'],
        '@error' => $params['error'],
      ]),
      'unknown' => $this->t('Could not connect to a Runlight at @address. Check the address, which is shown in Runlight under Settings, Install.', ['@address' => $params['address']]),
      'older' => $this->t('Your Runlight is older than this module. Update it, or copy the keys from its Settings, Install into the fields below.'),
      'client' => $this->t('Drupal at @host', ['@host' => $params['host']]),
      'silent' => $this->t('It did not say why.'),
      'refused' => $this->t('Your Runlight would not let this site connect: @reason', ['@reason' => $params['reason']]),
      'expired' => $this->t('That connection took too long or was already used. Press Connect again.'),
      'denied' => $this->t('The connection was not allowed.'),
      'failed' => $this->t('Your Runlight did not connect this site: @reason', ['@reason' => $params['reason']]),
      'lost' => $this->t('Could not reach your Runlight to finish connecting: @error', ['@error' => $params['error']]),
      'keys' => $this->t('Your Runlight did not give this site its keys. Press Connect again.'),
      'connected' => $this->t('Connected. Runlight counts this site as @site.', ['@site' => $params['site']]),
      default => $code,
    };
  }

  /**
   * Starts connecting, from the Connect button on the settings page.
   *
   * @param string $address
   *   The Runlight's address, as entered.
   *
   * @return \Drupal\Core\Routing\TrustedRedirectResponse|\Drupal\Component\Render\MarkupInterface
   *   The way to the Runlight's consent page, or why there is none.
   */
  public function start(string $address): TrustedRedirectResponse|MarkupInterface {
    $connect = $this->connect();
    if ($connect === NULL) {
      return $this->t('Connecting needs the Runlight PHP library, which Composer installs with the module. Copy the keys from Runlight’s Settings, Install into the fields below instead.');
    }
    [$to, $pending, $error] = $connect->start($address);
    if ($to === NULL) {
      // Made by say() through t(), which escaped what it put in.
      return Markup::create($error);
    }
    $this->pending()->setWithExpire((string) $this->currentUser->id(), $pending, CmsConnect::WAIT);
    // Never cached: the state in it is this admin's, for this one attempt.
    $response = new TrustedRedirectResponse($to);
    $response->getCacheableMetadata()->setCacheMaxAge(0);
    return $response;
  }

  /**
   * Finishes connecting when the Runlight sends the admin back.
   *
   * @param array<string, mixed> $query
   *   The query the Runlight sent the admin back with.
   *
   * @return array{0: bool, 1: \Drupal\Component\Render\MarkupInterface}
   *   Whether it connected, and what to say about it.
   */
  public function finish(array $query): array {
    // Each attempt works once, and only for the admin who started it: the
    // state it was sent with proves that.
    $uid = (string) $this->currentUser->id();
    $pending = $this->pending()->get($uid);
    $this->pending()->delete($uid);
    $connect = $this->connect();
    if ($connect === NULL) {
      return [FALSE, $this->t('That connection took too long or was already used. Press Connect again.')];
    }
    [$granted, $message] = $connect->finish($query, $pending);
    // Made by say() through t(), which escaped what it put in.
    $message = Markup::create($message);
    if ($granted === NULL) {
      return [FALSE, $message];
    }
    // Connecting chooses this Runlight; the counting checkboxes stay as they
    // are.
    $this->setup->save([
      'mode' => 'remote',
      'address' => $granted['address'],
      'site' => $granted['site'],
      'observe_key' => $granted['agentsKey'],
      'dashboard_key' => $granted['dashboardKey'],
    ]);
    return [TRUE, $message];
  }

}
