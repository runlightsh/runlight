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
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Runlight in this Drupal: its dashboard, API, and script under /runlight.
 *
 * And short links under /go, which Drupal answers itself when no link has the
 * name. Runlight sets its own caching headers, and Drupal's page cache never
 * keeps what it answers.
 */
final class LocalController extends ControllerBase {

  public function __construct(
    private readonly Local $local,
    private readonly KillSwitch $killSwitch,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): static {
    return new static($container->get('runlight.local'), $container->get('page_cache_kill_switch'));
  }

  /**
   * Everything under /runlight.
   */
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

  /**
   * A short link, or Drupal's own 404 when no link has the name.
   */
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
   * Runlight's answer to the request.
   */
  private function answer(Request $request): Response {
    try {
      $ours = Local::visitorRequest($request);
    }
    catch (BodyTooLarge) {
      return HttpFoundation::response(RunlightRequest::tooLarge());
    }
    return HttpFoundation::response(FrontController::answer($this->local->runlight(), $this->local->routes(), $ours));
  }

  /**
   * Where Runlight sends people who are signed out.
   *
   * It names the page to come back to, which is always one of its own.
   * Someone signed in who may not use it is told so, rather than sent round
   * to the login page, which turns them away.
   */
  private function signIn(Request $request): RedirectResponse {
    $base = $this->local->base();
    $next = (string) $request->query->get('next', '');
    $back = $next === $base || str_starts_with($next, $base . '/') ? $next : $base . '/';
    if ($this->currentUser()->isAuthenticated()) {
      if (!$this->currentUser()->hasPermission('administer runlight') && !$this->currentUser()->hasPermission('view runlight')) {
        throw new AccessDeniedHttpException('Your account cannot open Runlight. An admin can allow it with the View Runlight permission.');
      }
      return new RedirectResponse($back, 302, ['Cache-Control' => 'no-store']);
    }
    $to = Url::fromRoute('user.login', [], ['query' => ['destination' => $back]])->toString(TRUE)->getGeneratedUrl();
    return new RedirectResponse($to, 302, ['Cache-Control' => 'no-store']);
  }

}
