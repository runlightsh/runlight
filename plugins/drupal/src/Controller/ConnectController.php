<?php

declare(strict_types=1);

namespace Drupal\runlight\Controller;

use Drupal\Core\Controller\ControllerBase;
use Drupal\runlight\Connect;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * Where the Runlight sends the admin back to after Connect.
 *
 * It finishes connecting and goes on to the dashboard, or back to the
 * settings page with what went wrong. The state kept for the admin who
 * started it does a CSRF token's work here.
 */
final class ConnectController extends ControllerBase {

  public function __construct(private readonly Connect $connect) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): static {
    return new static($container->get('runlight.connect'));
  }

  /**
   * Finishes connecting.
   */
  public function finish(Request $request): RedirectResponse {
    [$ok, $message] = $this->connect->finish($request->query->all());
    // Connected, the admin sees the numbers; otherwise, the settings again
    // with why not.
    $ok ? $this->messenger()->addStatus($message) : $this->messenger()->addError($message);
    return $this->redirect($ok ? 'runlight.dashboard' : 'runlight.settings');
  }

}
