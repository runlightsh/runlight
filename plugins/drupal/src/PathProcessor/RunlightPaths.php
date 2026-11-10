<?php

declare(strict_types=1);

namespace Drupal\runlight\PathProcessor;

use Drupal\Core\PathProcessor\InboundPathProcessorInterface;
use Symfony\Component\HttpFoundation\Request;

/**
 * Sends every path under /runlight to the one route that answers them.
 *
 * Drupal's routes cannot take a parameter with slashes in it, and Runlight's
 * paths have several, such as /runlight/api/stats. Runlight reads the path
 * from the request itself, as the browser sent it. While Runlight does not
 * run here, the paths are left alone, so an alias under /runlight works.
 */
final class RunlightPaths implements InboundPathProcessorInterface {

  /**
   * Builds the processor.
   *
   * @param \Closure $setup
   *   Returns runlight.setup, made only for a path under /runlight.
   */
  public function __construct(private readonly \Closure $setup) {}

  /**
   * {@inheritdoc}
   */
  public function processInbound($path, Request $request): string {
    if (!str_starts_with($path, '/runlight/') || ($this->setup)()->mode() !== 'local') {
      return $path;
    }
    // The one route's own path is /runlight, so a module that sends each
    // request to its route's canonical address, such as Redirect with "Enforce
    // clean and canonical URLs", would send /runlight/s.js there. This keeps
    // it on the path the browser asked for.
    $request->attributes->set('_disable_route_normalizer', TRUE);
    return '/runlight';
  }

}
