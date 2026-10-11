<?php

declare(strict_types=1);

namespace Drupal\runlight\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Site\Settings;
use Drupal\Core\Url;
use Drupal\runlight\Connect;
use Drupal\runlight\Local;
use Drupal\runlight\Setup;
use GuzzleHttp\ClientInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * Reports, Runlight: this site's dashboard.
 *
 * Framed from Runlight in this Drupal, or from your Runlight elsewhere with a
 * ticket the module asks for on every visit to the page.
 */
final class DashboardController extends ControllerBase {

  public function __construct(
    private readonly Local $local,
    private readonly Setup $setup,
    private readonly ClientInterface $httpClient,
    private readonly RequestStack $requestStack,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): static {
    return new static(
      $container->get('runlight.local'),
      $container->get('runlight.setup'),
      $container->get('http_client'),
      $container->get('request_stack'),
    );
  }

  /**
   * The page under Reports.
   *
   * @return array<string, mixed>
   *   A render array.
   */
  public function open(): array {
    $mode = $this->setup->mode();
    $address = $this->setup->get('address');
    $key = $this->setup->get('dashboard_key');
    $settings = Url::fromRoute('runlight.settings')->toString();
    // Each ticket works once, so the page is never cached.
    $build = ['#cache' => ['max-age' => 0]];
    if (!$this->setup->isSetUp()) {
      $build['setup'] = [
        '#markup' => '<p>' . $this->t('Runlight is not counting yet. <a href=":url">Set up Runlight</a>.', [':url' => $settings]) . '</p>',
      ];
      return $build;
    }
    if ($mode === 'local') {
      return $this->local($build, $settings);
    }
    if ($address === '') {
      $build['setup'] = [
        '#markup' => '<p>' . $this->t('Connect this site to your Runlight on the <a href=":url">settings page</a> to see its numbers here.', [':url' => $settings]) . '</p>',
      ];
      return $build;
    }
    $ticket = $key === '' ? NULL : $this->ticket($address, $key);
    $site = is_array($ticket) && $ticket['site'] !== '' ? $ticket['site'] : $this->setup->get('site');
    $build['open'] = [
      '#type' => 'link',
      '#title' => $this->t('Open in Runlight'),
      '#url' => Url::fromUri($address . '/', $site !== '' ? ['query' => ['site' => $site]] : []),
      '#attributes' => ['class' => ['button', 'button--small'], 'target' => '_blank', 'rel' => 'noopener'],
    ];
    if ($ticket === NULL) {
      $build['setup'] = [
        '#markup' => '<p>' . $this->t('To see this site’s numbers here, press Connect on the <a href=":url">settings page</a>, or make a dashboard key in Runlight under Settings, Install and enter it there.', [':url' => $settings]) . '</p>',
      ];
      return $build;
    }
    if (is_string($ticket)) {
      return $build + $this->error($ticket, $settings);
    }
    $build['frame'] = $this->frame($ticket['url'], $address);
    return $build;
  }

  /**
   * The dashboard of Runlight in this Drupal.
   *
   * It is on this site, signed in with this login, so the whole dashboard
   * shows, not a share view.
   *
   * @param array<string, mixed> $build
   *   The page so far.
   * @param string $settings
   *   The settings page's address.
   *
   * @return array<string, mixed>
   *   The page.
   */
  private function local(array $build, string $settings): array {
    $missing = $this->local->missing();
    if ($missing !== '') {
      return $build + $this->error($missing, $settings);
    }
    $build['open'] = [
      '#type' => 'link',
      '#title' => $this->t('Open in Runlight'),
      '#url' => Url::fromUri($this->local->address() . '/'),
      '#attributes' => ['class' => ['button', 'button--small'], 'target' => '_blank', 'rel' => 'noopener'],
    ];
    $build['frame'] = $this->frame($this->local->address() . '/', $this->local->address(), TRUE);
    return $build;
  }

  /**
   * Why there is no dashboard, with the way to the settings.
   *
   * @param string $message
   *   Why.
   * @param string $settings
   *   The settings page's address.
   *
   * @return array<string, mixed>
   *   The render array.
   */
  private function error(string $message, string $settings): array {
    return [
      'error' => [
        '#theme' => 'status_messages',
        '#message_list' => ['error' => [$message]],
        '#status_headings' => ['error' => $this->t('Error message')],
      ],
      'settings' => [
        '#markup' => '<p>' . $this->t('<a href=":url">Check the settings</a>.', [':url' => $settings]) . '</p>',
      ],
    ];
  }

  /**
   * The frame the dashboard opens in, from the Runlight at the address.
   *
   * @param string $url
   *   The page to frame.
   * @param string $address
   *   The Runlight's address.
   * @param bool $full
   *   TRUE for the whole dashboard of Runlight in this site, else another
   *   one's read-only view.
   *
   * @return array<string, mixed>
   *   The render array.
   */
  private function frame(string $url, string $address, bool $full = FALSE): array {
    $frame = [
      '#type' => 'html_tag',
      '#tag' => 'iframe',
      '#value' => '',
      '#attributes' => [
        'id' => 'runlight-embed',
        'src' => $url,
        'data-runlight-origin' => Connect::origin($address),
        'title' => $this->t('Runlight dashboard'),
        'referrerpolicy' => 'no-referrer',
        'style' => 'display:block;width:100%;height:calc(100vh - 200px);min-height:600px;margin-top:12px;border:0;border-radius:8px;background:transparent',
      ],
      '#attached' => ['library' => ['runlight/embed']],
    ];
    // Runlight here is this site's own page, which a sandbox could not hold
    // anyway; another Runlight's view stays sandboxed.
    if (!$full) {
      $frame['#attributes']['sandbox'] = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads';
    }
    return $frame;
  }

  /**
   * Whether the saved address answers as a Runlight.
   *
   * The settings page asks once it has loaded. Only the saved address is
   * checked, never one the request names.
   */
  public function check(): JsonResponse {
    $address = $this->setup->get('address');
    // Nothing to check is null, which JsonResponse would otherwise send as {}.
    $response = $address !== '' ? new JsonResponse($this->answers($address)) : new JsonResponse('null', 200, [], TRUE);
    $response->headers->set('Cache-Control', 'no-store');
    return $response;
  }

  /**
   * Whether the address answers as a Runlight, and what to say about it.
   *
   * @param string $address
   *   The address.
   *
   * @return array{ok: bool, message: string}
   *   The answer.
   */
  private function answers(string $address): array {
    try {
      $response = $this->httpClient->request('GET', $address . '/api', ['timeout' => 5, 'http_errors' => FALSE]);
      $body = json_decode((string) $response->getBody(), TRUE);
      if ($response->getStatusCode() === 200 && is_array($body) && ($body['name'] ?? '') === 'runlight') {
        $message = $this->t('Connected to Runlight @version.', ['@version' => (string) ($body['version'] ?? '')]);
        return ['ok' => TRUE, 'message' => (string) $message];
      }
      $message = $this->t('Something answered, but not Runlight. Check that this is the address Runlight answers at, such as https://example.com/runlight for an app with Runlight mounted, or https://stats.example.com for the standalone server.');
      return ['ok' => FALSE, 'message' => (string) $message];
    }
    catch (\Throwable $e) {
      $message = $this->t('Could not reach it: @message', ['@message' => $e->getMessage()]);
      return ['ok' => FALSE, 'message' => (string) $message];
    }
  }

  /**
   * The origin the admin is served from, which alone may frame the dashboard.
   *
   * It is $settings['runlight_admin_origin'] when settings.php names it, else
   * the request's, which Drupal reads from a proxy's headers once
   * $settings['reverse_proxy'] trusts it.
   */
  private function adminOrigin(): string {
    $configured = Connect::origin(trim((string) Settings::get('runlight_admin_origin', '')));
    if ($configured !== '') {
      return $configured;
    }
    return (string) $this->requestStack->getCurrentRequest()?->getSchemeAndHttpHost();
  }

  /**
   * Whether the admin around the frame is dark.
   *
   * @return string
   *   "dark" or "light" by Gin's own setting when Gin is the admin theme, ""
   *   to follow the browser, else "light", as Claro is.
   */
  private function theme(): string {
    if ((string) $this->config('system.theme')->get('admin') !== 'gin') {
      return 'light';
    }
    $dark = (string) $this->config('gin.settings')->get('enable_darkmode');
    return $dark === '1' ? 'dark' : ($dark === 'auto' ? '' : 'light');
  }

  /**
   * Asks the Runlight for a ticket that opens the dashboard once.
   *
   * Framed by this admin. Each ticket works for a few minutes and only once,
   * so one is asked for on every visit to the page and never kept.
   *
   * @param string $address
   *   The Runlight's address.
   * @param string $key
   *   The dashboard key.
   *
   * @return array{url: string, site: string}|string
   *   The page to frame and its site, or why there is none.
   */
  private function ticket(string $address, string $key): array|string {
    try {
      $response = $this->httpClient->request('POST', $address . '/api/embed', [
        'timeout' => 5,
        'http_errors' => FALSE,
        'allow_redirects' => FALSE,
        'headers' => ['Authorization' => 'Bearer ' . $key],
        'json' => ['origin' => $this->adminOrigin()],
      ]);
    }
    catch (\Throwable $e) {
      return (string) $this->t('Could not reach your Runlight: @message', ['@message' => $e->getMessage()]);
    }
    $body = json_decode((string) $response->getBody(), TRUE);
    $code = $response->getStatusCode();
    if ($code !== 201 || !is_array($body) || !is_string($body['ticket'] ?? NULL)) {
      if ($code === 401) {
        return (string) $this->t('Your Runlight does not know this dashboard key. Connect again in the settings, or make a new key in Runlight under Settings, Install.');
      }
      $reason = is_array($body) && is_string($body['error'] ?? NULL) ? $body['error'] : (string) $this->t('It answered @code.', ['@code' => $code]);
      return (string) $this->t('Your Runlight would not open the dashboard here: @reason', ['@reason' => $reason]);
    }
    $theme = $this->theme();
    return [
      'url' => $address . '/embed?ticket=' . rawurlencode($body['ticket']) . ($theme !== '' ? '&theme=' . $theme : ''),
      'site' => is_string($body['site'] ?? NULL) ? $body['site'] : '',
    ];
  }

}
