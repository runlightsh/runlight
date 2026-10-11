<?php

declare(strict_types=1);

namespace Drupal\runlight\StackMiddleware;

use Drupal\runlight\Agents;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\HttpKernelInterface;

/**
 * Reports a page served to an AI agent.
 *
 * Agents run no JavaScript, so the script never sees them. This is middleware
 * ahead of the page cache because most pages an agent fetches are cached
 * ones, and a cache hit never reaches the kernel's events: Drupal does not
 * even run terminate() for it. The report is sent from a shutdown function,
 * which PHP runs once the response is out (under PHP-FPM, Symfony closes the
 * connection first), so the page is never slowed down. Only known agents'
 * requests are reported, and only for them are Runlight's services made.
 * When Runlight runs in this Drupal, it records them itself.
 */
final class AgentObserver implements HttpKernelInterface {

  /**
   * The cache item that says a Runlight elsewhere did not answer just now.
   */
  public const DOWN = 'runlight:down';

  /**
   * How long reports pause after one fails, in seconds.
   */
  private const PAUSE = 60;

  /**
   * Builds the middleware.
   *
   * @param \Symfony\Component\HttpKernel\HttpKernelInterface $app
   *   The kernel this wraps.
   * @param \Closure $setup
   *   Returns runlight.setup.
   * @param \Closure $httpClient
   *   Returns http_client.
   * @param \Closure $logger
   *   Returns Runlight's logger channel.
   * @param \Closure $local
   *   Returns runlight.local.
   * @param \Closure $cache
   *   Returns cache.default.
   */
  public function __construct(
    private readonly HttpKernelInterface $app,
    private readonly \Closure $setup,
    private readonly \Closure $httpClient,
    private readonly \Closure $logger,
    private readonly \Closure $local,
    private readonly \Closure $cache,
  ) {}

  /**
   * {@inheritdoc}
   */
  public function handle(Request $request, int $type = self::MAIN_REQUEST, bool $catch = TRUE): Response {
    $response = $this->app->handle($request, $type, $catch);
    if ($type === self::MAIN_REQUEST && $request->isMethod('GET')) {
      $agent = (string) $request->headers->get('User-Agent', '');
      if (Agents::isAgent($agent)) {
        $url = $request->getUri();
        register_shutdown_function(fn () => $this->report($request, $url, $agent));
      }
    }
    return $response;
  }

  /**
   * Reports or records one fetch.
   */
  private function report(Request $request, string $url, string $agent): void {
    /** @var \Drupal\runlight\Setup $setup */
    $setup = ($this->setup)();
    $mode = $setup->mode();
    if ($mode === 'local') {
      $this->record($request, $url, $agent);
      return;
    }
    $address = $setup->get('address');
    $key = $setup->get('observe_key');
    if ($mode !== 'remote' || $address === '' || $key === '') {
      return;
    }
    /** @var \Drupal\Core\Cache\CacheBackendInterface $cache */
    $cache = ($this->cache)();
    // A Runlight that did not answer is left alone for a minute, so a down
    // server never ties up a worker for each agent's fetch.
    if ($cache->get(self::DOWN) !== FALSE) {
      return;
    }
    try {
      ($this->httpClient)()->request('POST', $address . '/api/observe', [
        'connect_timeout' => 1,
        'timeout' => 3,
        'headers' => ['Authorization' => 'Bearer ' . $key],
        'json' => ['url' => $url, 'userAgent' => $agent],
      ]);
    }
    catch (\Throwable $e) {
      $cache->set(self::DOWN, TRUE, time() + self::PAUSE);
      // Analytics must never break the page it watches; note it and move on.
      ($this->logger)()->notice('Could not report an AI agent fetch: @message', ['@message' => $e->getMessage()]);
    }
  }

  /**
   * Records the fetch in Runlight here, unless it was one of Runlight's pages.
   */
  private function record(Request $request, string $url, string $agent): void {
    try {
      /** @var \Drupal\runlight\Local $local */
      $local = ($this->local)();
      $local->request($request);
      $path = (string) parse_url($url, PHP_URL_PATH);
      $base = $local->base();
      if (!$local->active() || $path === $base || str_starts_with($path, $base . '/')) {
        return;
      }
      $local->observe($url, $agent);
    }
    catch (\Throwable $e) {
      ($this->logger)()->notice('Could not record an AI agent fetch: @message', ['@message' => $e->getMessage()]);
    }
  }

}
