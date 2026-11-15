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
    // Drupal keeps what this returns for the next request to the same path
    // and does not ask again, so nothing that must hold on every request can
    // be done here. EventSubscriber\RunlightRequests keeps Redirect's route
    // normalizer off these paths; this line is for a site whose container
    // has not been rebuilt since the update that added it.
    $request->attributes->set('_disable_route_normalizer', TRUE);
    return '/runlight';
  }

  /**
   * One of Runlight's paths without its language prefix, if it has one.
   *
   * With more than one language and "Path prefix" detection, a link Drupal
   * builds for a route starts with the language, such as /fr/runlight, and
   * another module may send a visitor there. Runlight answers those as it
   * answers /runlight.
   *
   * @param string $path
   *   The request's path, after the folder Drupal lives in, as it was sent.
   * @param \Closure $prefixes
   *   Returns the language prefixes, asked for only when the path has what
   *   may be one.
   *
   * @return string|null
   *   The path Runlight knows it by, or NULL when it is not Runlight's.
   */
  public static function ours(string $path, \Closure $prefixes): ?string {
    $own = 'runlight(?:/.*)?|go/[^/]+/?';
    if (preg_match('#^/(?:' . $own . ')$#sD', $path)) {
      return $path;
    }
    if (preg_match('#^/([^/]+)(/(?:' . $own . '))$#sD', $path, $found) && in_array($found[1], $prefixes(), TRUE)) {
      return $found[2];
    }
    return NULL;
  }

  /**
   * The path prefixes the site's languages go by, when it tells them so.
   *
   * @param mixed $url
   *   The "url" part of language.negotiation, which is not there without the
   *   Language module.
   *
   * @return string[]
   *   The prefixes, without the one that is empty.
   */
  public static function prefixes(mixed $url): array {
    if (!is_array($url) || ($url['source'] ?? '') !== 'path_prefix' || !is_array($url['prefixes'] ?? NULL)) {
      return [];
    }
    return array_values(array_filter(array_map('strval', $url['prefixes']), static fn (string $prefix): bool => $prefix !== ''));
  }

}
