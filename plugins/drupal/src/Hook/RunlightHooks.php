<?php

declare(strict_types=1);

namespace Drupal\runlight\Hook;

use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Hook\Attribute\Hook;
use Drupal\Core\Routing\AdminContext;
use Drupal\Core\Routing\RouteMatchInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use Drupal\Core\Url;
use Drupal\runlight\Mailer;
use Drupal\runlight\Setup;
use Symfony\Component\HttpFoundation\RequestStack;

/**
 * The module's hooks: help, the script on every page, upkeep, and email.
 *
 * Drupal 11.1 and later call these through their attributes. Drupal 10.3 and
 * 11.0 call the functions in runlight.module, which hand over to these.
 */
final class RunlightHooks {

  use StringTranslationTrait;

  /**
   * Builds the hooks.
   *
   * @param \Drupal\Core\Config\ConfigFactoryInterface $configFactory
   *   The site's configuration, for what Runlight counts.
   * @param \Drupal\runlight\Setup $setup
   *   Where Runlight runs, and its address.
   * @param \Closure $local
   *   Returns runlight.local, made only when Runlight runs in this Drupal.
   * @param \Drupal\Core\Routing\AdminContext $adminContext
   *   Whether a page is in the admin theme, which never counts.
   * @param \Drupal\Core\Session\AccountInterface $currentUser
   *   Who is looking, for Skip admins.
   * @param \Drupal\Core\Routing\RouteMatchInterface $routeMatch
   *   The page's route, for 404 pages.
   * @param \Symfony\Component\HttpFoundation\RequestStack $requestStack
   *   The request, for the exception a 404 page carries.
   */
  public function __construct(
    private readonly ConfigFactoryInterface $configFactory,
    private readonly Setup $setup,
    private readonly \Closure $local,
    private readonly AdminContext $adminContext,
    private readonly AccountInterface $currentUser,
    private readonly RouteMatchInterface $routeMatch,
    private readonly RequestStack $requestStack,
  ) {}

  /**
   * Implements hook_help().
   */
  #[Hook('help')]
  public function help(string $route_name, RouteMatchInterface $route_match): string {
    if ($route_name !== 'help.page.runlight') {
      return '';
    }
    $output = '<h2>' . $this->t('About') . '</h2>';
    $output .= '<p>' . $this->t('Runlight counts visitors without cookies and keeps the numbers in your own database. It runs inside this site, with its dashboard under Reports, or sends to a Runlight you run elsewhere. It also records AI agents such as ChatGPT and Claude that read your pages. See <a href=":docs">the Runlight docs</a>.', [':docs' => 'https://runlight.sh/docs/drupal/']) . '</p>';
    $output .= '<h2>' . $this->t('Uses') . '</h2>';
    $output .= '<dl>';
    $output .= '<dt>' . $this->t('Choosing where Runlight runs') . '</dt>';
    $output .= '<dd>' . $this->t('Choose on the <a href=":url">Runlight settings page</a>. Nothing is counted until you do.', [':url' => Url::fromRoute('runlight.settings')->toString()]) . '</dd>';
    $output .= '<dt>' . $this->t('Seeing the numbers') . '</dt>';
    $output .= '<dd>' . $this->t('Reports, Runlight shows the dashboard to people with the Administer Runlight or View Runlight permission. Only Administer Runlight can change anything there.') . '</dd>';
    $output .= '</dl>';
    return $output;
  }

  /**
   * Implements hook_page_attachments().
   *
   * The script goes in the head of every page but the admin theme's, unless
   * the visit should not count. A 404 page says so, so broken links show up.
   */
  #[Hook('page_attachments')]
  public function pageAttachments(array &$attachments): void {
    $config = $this->configFactory->get('runlight.settings');
    // Setup::TAG is cleared whenever where Runlight runs changes.
    $attachments['#cache']['tags'][] = Setup::TAG;
    $attachments['#cache']['contexts'][] = 'user.permissions';
    $mode = $this->setup->mode();
    // Runlight here takes the script from its own path, which needs no address.
    $local = $mode === 'local' && ($this->local)()->active();
    $address = $local ? ($this->local)()->base() : ($mode === 'remote' ? $this->setup->get('address') : '');
    if ($address === '' || $this->adminContext->isAdminRoute()) {
      return;
    }
    if ($config->get('skip_admins') && $this->currentUser->hasPermission('administer runlight')) {
      return;
    }
    $attributes = ['defer' => TRUE, 'src' => $address . '/s.js'];
    if (!$local && $this->setup->get('site') !== '') {
      $attributes['data-site'] = $this->setup->get('site');
    }
    if (!$config->get('outbound')) {
      $attributes['data-outbound'] = 'false';
    }
    if (!$config->get('downloads')) {
      $attributes['data-downloads'] = 'false';
    }
    $route = $this->routeMatch->getRouteName();
    $exception = $this->requestStack->getCurrentRequest()?->attributes->get('exception');
    if ($route === 'system.404' || ($exception && method_exists($exception, 'getStatusCode') && $exception->getStatusCode() === 404)) {
      $attributes['data-404'] = TRUE;
      $attachments['#cache']['contexts'][] = 'route';
    }
    $attachments['#attached']['html_head'][] = [
      ['#tag' => 'script', '#attributes' => $attributes],
      'runlight',
    ];
  }

  /**
   * Implements hook_cron().
   *
   * Runlight's hourly upkeep, while it runs in this Drupal: the day's salts,
   * reports, retention, daily totals, and with locations on, DB-IP's country
   * data once a month.
   */
  #[Hook('cron')]
  public function cron(): void {
    ($this->local)()->check();
  }

  /**
   * Implements hook_mail().
   *
   * Runlight's email, when it goes through Drupal's mailer: reports and test
   * emails, in HTML with the text beside it.
   */
  #[Hook('mail')]
  public function mail(string $key, array &$message, array $params): void {
    Mailer::build($key, $message, $params);
  }

}
