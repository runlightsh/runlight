<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Core\KeyValueStore\KeyValueExpirableFactoryInterface;
use Drupal\Core\KeyValueStore\KeyValueStoreExpirableInterface;
use Drupal\Core\Routing\TrustedRedirectResponse;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Url;
use GuzzleHttp\ClientInterface;

/**
 * Connecting to a Runlight without copying keys.
 *
 * The module registers itself with the Runlight's OAuth server, sends the
 * admin to its consent page to pick this site, and on the way back swaps the
 * code, checked with PKCE, for the site's dashboard key, agents key, and id,
 * which it keeps in state, never in exported configuration.
 */
final class Connect {

  use StringTranslationTrait;

  /**
   * The key-value collection holding attempts waiting on the consent page.
   */
  public const PENDING = 'runlight.connect';

  /**
   * How long an attempt may wait on the consent page, in seconds.
   */
  private const WAIT = 15 * 60;

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
   * Whether this admin is somewhere a Runlight can send people back to.
   *
   * @return bool
   *   On https, or this computer while trying things out.
   */
  public static function possible(): bool {
    return self::returnable(self::back());
  }

  /**
   * Whether a Runlight sends people back to an address.
   *
   * @param string $back
   *   The address.
   */
  public static function returnable(string $back): bool {
    $parts = parse_url($back);
    $host = strtolower((string) ($parts['host'] ?? ''));
    $local = ['localhost', '127.0.0.1', '[::1]'];
    return strtolower((string) ($parts['scheme'] ?? '')) === 'https' || in_array($host, $local, TRUE);
  }

  /**
   * The scheme, host, and port of an address, as a browser writes its origin.
   *
   * A default port is left out, so https://x:443 and https://x are the same.
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
   * JSON from the Runlight.
   *
   * @param string $method
   *   The method.
   * @param string $url
   *   The address.
   * @param array<string, mixed> $options
   *   Guzzle's request options.
   *
   * @return array{0: array<string, mixed>|null, 1: string}
   *   The JSON, or NULL when it could not be reached or did not answer with
   *   any, and why it could not be reached.
   */
  private function json(string $method, string $url, array $options = []): array {
    try {
      $response = $this->httpClient->request($method, $url, $options + [
        'timeout' => 10,
        'http_errors' => FALSE,
        'allow_redirects' => FALSE,
      ]);
    }
    catch (\Throwable $e) {
      return [NULL, $e->getMessage()];
    }
    $body = json_decode((string) $response->getBody(), TRUE);
    return [is_array($body) ? $body : NULL, ''];
  }

  /**
   * Starts connecting, from the Connect button on the settings page.
   *
   * @param string $address
   *   The Runlight's address, as entered.
   *
   * @return \Drupal\Core\Routing\TrustedRedirectResponse|\Drupal\Core\StringTranslation\TranslatableMarkup
   *   The way to the Runlight's consent page, or why there is none.
   */
  public function start(string $address): TrustedRedirectResponse|TranslatableMarkup {
    if ($address === '') {
      return $this->t('Enter your Runlight’s address, then press Connect.');
    }
    if (!in_array(strtolower((string) parse_url($address, PHP_URL_SCHEME)), ['http', 'https'], TRUE)) {
      return $this->t('Enter a web address, such as https://stats.example.com.');
    }
    if (!self::possible()) {
      return $this->t('Connecting needs this site’s admin on https. Copy the keys from Runlight’s Settings, Install into the fields below instead.');
    }

    [$meta, $error] = $this->json('GET', $address . '/.well-known/oauth-authorization-server');
    if ($error !== '') {
      return $this->t('Could not reach a Runlight at @address: @error', ['@address' => $address, '@error' => $error]);
    }
    $unknown = $this->t('Could not connect to a Runlight at @address. Check the address, which is shown in Runlight under Settings, Install.', ['@address' => $address]);
    if ($meta === NULL || !is_string($meta['authorization_endpoint'] ?? NULL) || !is_string($meta['token_endpoint'] ?? NULL) || !is_string($meta['registration_endpoint'] ?? NULL)) {
      return $unknown;
    }
    // Its endpoints must be on its own address, so an address cannot send
    // this server's requests elsewhere.
    $origin = self::origin($address);
    foreach (['authorization_endpoint', 'token_endpoint', 'registration_endpoint'] as $endpoint) {
      if (self::origin($meta[$endpoint]) !== $origin) {
        return $unknown;
      }
    }
    if (!in_array('cms', (array) ($meta['scopes_supported'] ?? []), TRUE)) {
      return $this->t('Your Runlight is older than this module. Update it, or copy the keys from its Settings, Install into the fields below.');
    }

    [$client, $error] = $this->json('POST', $meta['registration_endpoint'], [
      'json' => [
        'client_name' => (string) $this->t('Drupal at @host', ['@host' => (string) parse_url(self::back(), PHP_URL_HOST)]),
        'redirect_uris' => [self::back()],
      ],
    ]);
    if ($client === NULL || !is_string($client['client_id'] ?? NULL)) {
      $reason = is_string($client['error_description'] ?? NULL) ? $client['error_description'] : ($error !== '' ? $error : $this->t('It did not say why.'));
      return $this->t('Your Runlight would not let this site connect: @reason', ['@reason' => $reason]);
    }

    $state = bin2hex(random_bytes(16));
    $verifier = rtrim(strtr(base64_encode(random_bytes(48)), '+/', '-_'), '=');
    $this->pending()->setWithExpire((string) $this->currentUser->id(), [
      'state' => $state,
      'verifier' => $verifier,
      'client' => $client['client_id'],
      'token' => $meta['token_endpoint'],
      'address' => $address,
    ], self::WAIT);
    $challenge = rtrim(strtr(base64_encode(hash('sha256', $verifier, TRUE)), '+/', '-_'), '=');
    $query = http_build_query([
      'response_type' => 'code',
      'client_id' => $client['client_id'],
      'redirect_uri' => self::back(),
      'code_challenge' => $challenge,
      'code_challenge_method' => 'S256',
      'scope' => 'cms',
      'state' => $state,
    ], '', '&', PHP_QUERY_RFC3986);
    $to = $meta['authorization_endpoint'] . (str_contains($meta['authorization_endpoint'], '?') ? '&' : '?') . $query;
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
   * @return array{0: bool, 1: \Drupal\Core\StringTranslation\TranslatableMarkup}
   *   Whether it connected, and what to say about it.
   */
  public function finish(array $query): array {
    // Each attempt works once, and only for the admin who started it: the
    // state it was sent with proves that.
    $uid = (string) $this->currentUser->id();
    $pending = $this->pending()->get($uid);
    $this->pending()->delete($uid);
    $state = is_string($query['state'] ?? NULL) ? $query['state'] : '';
    if (!is_array($pending) || !hash_equals((string) ($pending['state'] ?? ''), $state)) {
      return [FALSE, $this->t('That connection took too long or was already used. Press Connect again.')];
    }
    if (isset($query['error'])) {
      if ($query['error'] === 'access_denied') {
        return [FALSE, $this->t('The connection was not allowed.')];
      }
      $reason = is_string($query['error_description'] ?? NULL) ? $query['error_description'] : (string) $query['error'];
      return [FALSE, $this->t('Your Runlight did not connect this site: @reason', ['@reason' => $reason])];
    }
    $code = is_string($query['code'] ?? NULL) ? $query['code'] : '';

    [$granted, $error] = $this->json('POST', $pending['token'], [
      'form_params' => [
        'grant_type' => 'authorization_code',
        'code' => $code,
        'client_id' => $pending['client'],
        'redirect_uri' => self::back(),
        'code_verifier' => $pending['verifier'],
      ],
    ]);
    if ($error !== '') {
      return [FALSE, $this->t('Could not reach your Runlight to finish connecting: @error', ['@error' => $error])];
    }
    if ($granted === NULL || !is_string($granted['access_token'] ?? NULL) || !is_string($granted['agents_key'] ?? NULL)) {
      return [FALSE, $this->t('Your Runlight did not give this site its keys. Press Connect again.')];
    }
    $site = is_string($granted['site'] ?? NULL) ? $granted['site'] : '';
    // Connecting chooses this Runlight; the counting checkboxes stay as they
    // are.
    $this->setup->save([
      'mode' => 'remote',
      'address' => (string) $pending['address'],
      'site' => $site,
      'observe_key' => $granted['agents_key'],
      'dashboard_key' => $granted['access_token'],
    ]);
    return [TRUE, $this->t('Connected. Runlight counts this site as @site.', ['@site' => $site])];
  }

}
