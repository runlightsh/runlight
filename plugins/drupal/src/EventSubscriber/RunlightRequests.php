<?php

declare(strict_types=1);

namespace Drupal\runlight\EventSubscriber;

use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\runlight\PathProcessor\RunlightPaths;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpKernel\Event\RequestEvent;
use Symfony\Component\HttpKernel\KernelEvents;

/**
 * Keeps Runlight's paths where the browser asked for them.
 *
 * Every path under /runlight is answered by one route, whose own path is
 * /runlight, or /en/runlight on a site with language prefixes. A module that
 * sends each request to its route's canonical address, such as Redirect with
 * "Enforce clean and canonical URLs", would send /runlight/s.js, the
 * dashboard, and every visit there. This tells it to leave them be, on every
 * request: the path processor is not asked again once Drupal has kept a
 * path's route, so it cannot.
 */
final class RunlightRequests implements EventSubscriberInterface {

  /**
   * Builds the subscriber.
   *
   * @param \Closure $setup
   *   Returns runlight.setup, made only for one of Runlight's paths.
   * @param \Drupal\Core\Config\ConfigFactoryInterface $configFactory
   *   Drupal's configuration, for the language prefixes.
   */
  public function __construct(
    private readonly \Closure $setup,
    private readonly ConfigFactoryInterface $configFactory,
  ) {}

  /**
   * Marks a request for Runlight as not to be redirected to its route.
   */
  public function onRequest(RequestEvent $event): void {
    $request = $event->getRequest();
    if (!$event->isMainRequest() || $request->attributes->get('_disable_route_normalizer')) {
      return;
    }
    $ours = RunlightPaths::ours($request->getPathInfo(), fn (): array => RunlightPaths::prefixes($this->configFactory->get('language.negotiation')->get('url')));
    if ($ours !== NULL && ($this->setup)()->mode() === 'local') {
      $request->attributes->set('_disable_route_normalizer', TRUE);
    }
  }

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    // Ahead of Redirect's normalizer, which runs at 30.
    return [KernelEvents::REQUEST => ['onRequest', 100]];
  }

}
