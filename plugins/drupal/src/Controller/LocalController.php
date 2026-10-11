<?php

declare(strict_types=1);

namespace Drupal\runlight\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\PageCache\ResponsePolicy\KillSwitch;
use Drupal\Core\Url;
use Drupal\runlight\Local;
use Runlight\Bridge\HttpFoundation;
use Runlight\Http\BodyTooLarge;
use Runlight\Http\Request as RunlightRequest;
use Runlight\Server\FrontController;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Runlight in this Drupal: its dashboard, API, and script under /runlight,
 * and short links under /go, which Drupal answers itself when no link has
 * the name. Runlight sets its own caching headers, and Drupal's page cache
 * never keeps what it answers.
 */
final class LocalController extends ControllerBase {

  public function __construct(
    private readonly Local $local,
    private readonly KillSwitch $killSwitch,
  ) {}

  public static function create(ContainerInterface $container): static {
    return new static($container->get('runlight.local'), $container->get('page_cache_kill_switch'));
  }

  /** Everything under /runlight. */
  public function serve(Request $request): Response {
    if (!$this->local->active()) {
      throw new NotFoundHttpException();
    }
    $this->killSwitch->trigger();
    if (rtrim($request->getPathInfo(), '/') === '/runlight/login') {
      return $this->signIn($request);
    }
    return $this->answer($request);
  }

  /** A short link, or Drupal's own 404 when no link has the name. */
  public function link(Request $request): Response {
    if (!$this->local->active() || !$request->isMethod('GET')) {
      throw new NotFoundHttpException();
    }
    $this->killSwitch->trigger();
    $response = $this->answer($request);
    if ($response->getStatusCode() === 404) {
      throw new NotFoundHttpException();
    }
    return $response;
  }

  /**
   * Runlight's answer to the request. The URL is the one the browser asked
   * for, escapes and all, and the address is the connection's, since
   * Runlight reads a proxy's headers itself.
   */
  private function answer(Request $request): Response {
    try {
      $ours = HttpFoundation::request($request);
    }
    catch (BodyTooLarge) {
      return HttpFoundation::response(RunlightRequest::tooLarge());
    }
    return HttpFoundation::response(FrontController::answer($this->local->runlight(), $this->local->routes(), $ours));
  }

  /**
   * Runlight sends people who are signed out here, naming the page to come
   * back to, which is always one of its own.
   */
  private function signIn(Request $request): RedirectResponse {
    $base = $this->local->base();
    $next = (string) $request->query->get('next', '');
    $back = $next === $base || str_starts_with($next, $base . '/') ? $next : $base . '/';
    $to = Url::fromRoute('user.login', [], ['query' => ['destination' => $back]])->toString(TRUE)->getGeneratedUrl();
    return new RedirectResponse($to, 302, ['Cache-Control' => 'no-store']);
  }

}
