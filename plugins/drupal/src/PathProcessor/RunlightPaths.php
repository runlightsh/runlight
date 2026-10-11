<?php

declare(strict_types=1);

namespace Drupal\runlight\PathProcessor;

use Drupal\Core\PathProcessor\InboundPathProcessorInterface;
use Symfony\Component\HttpFoundation\Request;

/**
 * Sends every path under /runlight to the one route that answers them.
 * Drupal's routes cannot take a parameter with slashes in it, and Runlight's
 * paths have several, such as /runlight/api/stats. Runlight reads the path
 * from the request itself, as the browser sent it.
 */
final class RunlightPaths implements InboundPathProcessorInterface {

  public function processInbound($path, Request $request): string {
    return str_starts_with($path, '/runlight/') ? '/runlight' : $path;
  }

}
