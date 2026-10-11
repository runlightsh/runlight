<?php

declare(strict_types=1);

namespace Drupal\runlight\Form;

use Drupal\Core\Form\ConfigFormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\Url;
use Drupal\runlight\Local;
use Symfony\Component\HttpFoundation\Response;

/**
 * Configuration, System, Runlight: where Runlight runs, and what it counts.
 */
final class SettingsForm extends ConfigFormBase {

  public function getFormId(): string {
    return 'runlight_settings';
  }

  protected function getEditableConfigNames(): array {
    return ['runlight.settings'];
  }

  /** The address as typed, tidied: no trailing slash, and the script's own address works too. */
  public static function tidy(string $value): string {
    $value = trim($value);
    $value = (string) preg_replace('#/s\.js$#', '', $value);
    return rtrim($value, '/');
  }

  public function buildForm(array $form, FormStateInterface $form_state): array {
    $config = $this->config('runlight.settings');
    $address = (string) $config->get('address');
    $mode = Local::mode($config->get('mode'), $address);
    /** @var \Drupal\runlight\Local $local */
    $local = \Drupal::service('runlight.local');
    $missing = $local->missing();
    // The setup screen stays until a choice is made, unless the admin asked for the fields to fill in by hand.
    $unset = !Local::setUp($config);
    $manual = $this->getRequest()->query->get('setup') === 'manual';
    if ($unset && !$manual) {
      return $this->setup($form, $local, $missing);
    }
    if ($manual) {
      $mode = 'remote';
    }
    $form['intro'] = [
      '#markup' => '<p>' . $this->t('Runlight counts visitors without cookies and keeps the numbers in your own database. This module adds its script to every page and records AI agents that read your pages.') . '</p>',
    ];
    if ($unset) {
      $form['back'] = [
        '#markup' => '<p>' . $this->t('<a href=":url">Back to the setup choices</a>', [':url' => Url::fromRoute('runlight.settings')->toString()]) . '</p>',
      ];
    }
    if ($mode === 'local' && $missing === '') {
      $form['status'] = [
        '#type' => 'html_tag',
        '#tag' => 'div',
        '#value' => $this->t('Runlight is counting this site. <a href=":url">See the numbers</a>', [':url' => Url::fromRoute('runlight.dashboard')->toString()]),
        '#attributes' => ['class' => ['messages', 'messages--status']],
      ];
    }
    // Checked once the page has loaded, so a slow or missing Runlight never holds it up.
    elseif ($mode === 'remote' && $address !== '') {
      $form['status'] = [
        '#type' => 'html_tag',
        '#tag' => 'div',
        '#value' => $this->t('Checking that your Runlight answers…'),
        '#attributes' => ['id' => 'runlight-status', 'class' => ['messages', 'messages--info']],
        '#attached' => [
          'library' => ['runlight/settings'],
          'drupalSettings' => [
            'runlight' => [
              'check' => Url::fromRoute('runlight.check')->toString(),
              'dashboard' => $address . '/',
              'open' => (string) $this->t('Open the dashboard'),
              'failed' => (string) $this->t('Could not check your Runlight from here.'),
            ],
          ],
        ],
      ];
    }
    // Enter in any field saves, rather than pressing Connect, the first button in the form.
    $form['save'] = [
      '#type' => 'submit',
      '#value' => $this->t('Save configuration'),
      '#attributes' => ['tabindex' => '-1', 'aria-hidden' => 'true', 'style' => 'position:absolute;left:-9999px'],
    ];
    $form['mode'] = [
      '#type' => 'radios',
      '#title' => $this->t('Where Runlight runs'),
      '#default_value' => $mode,
      '#options' => [
        'local' => $this->t('In this Drupal site'),
        'remote' => $this->t('On a Runlight you run elsewhere'),
      ],
      'local' => [
        '#description' => $missing !== '' ? $missing : $this->t('Runlight runs inside this site and keeps its numbers in this site’s database, with a standalone dashboard at <code>@address</code> as well as the one under Reports. There is nothing else to set up.', ['@address' => $local->address() . '/']),
        // Only while it is not chosen already, so a server that changed can still be moved off it.
        '#disabled' => $missing !== '' && $mode !== 'local',
      ],
      'remote' => [
        '#description' => $this->t('The standalone server, or an app with Runlight in it, for one dashboard across several sites.'),
      ],
    ];
    // Only the fields for where Runlight runs show: its address and keys for another one, locations for this one.
    $remote = ['visible' => [':input[name="mode"]' => ['value' => 'remote']]];
    $form['remote'] = ['#type' => 'container', '#states' => $remote];
    $form['remote']['address'] = [
      '#type' => 'url',
      '#title' => $this->t('Runlight address'),
      '#default_value' => $address,
      '#placeholder' => 'https://example.com/runlight or https://stats.example.com',
      '#description' => $this->t('Enter your Runlight’s address, shown in Runlight under Settings, Install, and press Connect. Runlight asks you to pick this site, then fills in everything below. That Runlight must count this site, or its visits are ignored.'),
    ];
    // Only the address matters to Connect, so only it is checked.
    $form['remote']['connect'] = [
      '#type' => 'submit',
      '#value' => $this->t('Connect'),
      '#submit' => ['::connect'],
      '#limit_validation_errors' => [['address']],
    ];
    $form['remote']['site'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Site id'),
      '#default_value' => $config->get('site'),
      '#description' => $this->t('Optional. Shown in Runlight under Settings, Install. Only needed when that Runlight cannot tell this site by its domain.'),
    ];
    $form['remote']['observe_key'] = [
      '#type' => 'password',
      '#title' => $this->t('Agents key'),
      '#attributes' => ['placeholder' => (string) $config->get('observe_key') !== '' ? $this->t('Saved. Leave blank to keep it for this address.') : ''],
      '#description' => $this->t('Optional. Shown in Runlight under Settings, Install. With it, the module reports AI agents such as ChatGPT and Claude reading your pages, which run no JavaScript, so the script cannot see them. The key can report fetches for this site and nothing else. To keep it out of exported configuration, set it in settings.php instead: <code>$config[\'runlight.settings\'][\'observe_key\'] = getenv(\'RUNLIGHT_OBSERVE_KEY\');</code>'),
    ];
    $form['remote']['dashboard_key'] = [
      '#type' => 'password',
      '#title' => $this->t('Dashboard key'),
      '#attributes' => ['placeholder' => (string) $config->get('dashboard_key') !== '' ? $this->t('Saved. Leave blank to keep it for this address.') : ''],
      '#description' => $this->t('Optional. Made in Runlight under Settings, Install. With it, Reports, Runlight shows this site’s numbers right here, in the same read-only view a share link shows, framed only by this admin. The key cannot read anything itself. To keep it out of exported configuration, set it in settings.php instead: <code>$config[\'runlight.settings\'][\'dashboard_key\'] = getenv(\'RUNLIGHT_DASHBOARD_KEY\');</code>'),
    ];
    $form['locations'] = [
      '#type' => 'checkbox',
      '#title' => $this->t('Show which countries visitors come from'),
      '#default_value' => $config->get('locations'),
      '#description' => $this->t('With DB-IP’s free country data, which the module downloads from db-ip.com once a month at cron and keeps in the files folder. Visitors’ addresses are looked up on this server and never sent anywhere. Sites behind Cloudflare get countries without it.'),
      '#states' => ['visible' => [':input[name="mode"]' => ['value' => 'local']]],
    ];
    $form['skip_admins'] = [
      '#type' => 'checkbox',
      '#title' => $this->t('Leave out the visits of people who can administer Runlight'),
      '#default_value' => $config->get('skip_admins'),
    ];
    $form['outbound'] = [
      '#type' => 'checkbox',
      '#title' => $this->t('Count clicks on links to other sites'),
      '#default_value' => $config->get('outbound'),
    ];
    $form['downloads'] = [
      '#type' => 'checkbox',
      '#title' => $this->t('Count file downloads'),
      '#default_value' => $config->get('downloads'),
    ];
    $form = parent::buildForm($form, $form_state);
    $form['help'] = [
      '#markup' => '<p>' . $this->t('Need help? <a href=":url" target="_blank" rel="noopener">Read the Runlight docs.</a>', [':url' => 'https://runlight.sh/docs/drupal/']) . '</p>',
      '#weight' => 1000,
    ];
    return $form;
  }

  /**
   * The first screen, before anything is counted: run Runlight in this
   * Drupal with one press, or connect to one run elsewhere.
   */
  private function setup(array $form, Local $local, string $missing): array {
    $form['intro'] = [
      '#markup' => '<p>' . $this->t('Runlight counts visitors without cookies, and its numbers stay in your own database. Choose where it runs. Nothing is counted until you do.') . '</p>',
    ];
    $form['here'] = [
      '#type' => 'fieldset',
      '#title' => $this->t('Run Runlight in this Drupal site'),
    ];
    $form['here']['about'] = [
      '#markup' => '<p>' . $this->t('Runlight runs inside this site and keeps its numbers in this site’s database, with a standalone dashboard at <code>@address</code> as well as the one under Reports. There is nothing else to set up.', ['@address' => $local->address() . '/']) . '</p>',
    ];
    if ($missing !== '') {
      $form['here']['missing'] = ['#markup' => '<p>' . $missing . '</p>'];
    }
    else {
      $form['here']['run'] = [
        '#type' => 'submit',
        '#value' => $this->t('Run Runlight in this Drupal site'),
        '#button_type' => 'primary',
        '#submit' => ['::runHere'],
        '#limit_validation_errors' => [],
      ];
    }
    $form['elsewhere'] = [
      '#type' => 'fieldset',
      '#title' => $this->t('Connect to a Runlight you run elsewhere'),
    ];
    $form['elsewhere']['about'] = [
      '#markup' => '<p>' . $this->t('The standalone server, or an app with Runlight in it, for one dashboard across several sites. Enter its address, shown in Runlight under Settings, Install, and press Connect. Runlight asks you to pick this site, then fills in everything.') . '</p>',
    ];
    $form['elsewhere']['address'] = [
      '#type' => 'url',
      '#title' => $this->t('Runlight address'),
      '#placeholder' => 'https://stats.example.com',
    ];
    $form['elsewhere']['connect'] = [
      '#type' => 'submit',
      '#value' => $this->t('Connect'),
      '#submit' => ['::connect'],
      '#limit_validation_errors' => [['address']],
    ];
    $form['elsewhere']['by_hand'] = [
      '#markup' => '<p>' . $this->t('<a href=":url">Enter the settings by hand instead</a>', [':url' => Url::fromRoute('runlight.settings', [], ['query' => ['setup' => 'manual']])->toString()]) . '</p>',
    ];
    $form['docs'] = [
      '#markup' => '<p>' . $this->t('Not sure? <a href=":url" target="_blank" rel="noopener">Read how each one works.</a>', [':url' => 'https://runlight.sh/docs/drupal/']) . '</p>',
    ];
    return $form;
  }

  public function submitForm(array &$form, FormStateInterface $form_state): void {
    $config = $this->config('runlight.settings');
    $key = trim((string) $form_state->getValue('observe_key'));
    $dashboard = trim((string) $form_state->getValue('dashboard_key'));
    $address = self::tidy((string) $form_state->getValue('address'));
    // Left blank, a saved key stays, so it never has to be shown again, but only for the same
    // address: pointed somewhere else, the module must never send that Runlight's key there.
    $same = $address === (string) $config->get('address');
    $kept = $same ? (string) $config->get('observe_key') : '';
    $keptDashboard = $same ? (string) $config->get('dashboard_key') : '';
    $mode = (string) $form_state->getValue('mode');
    $config
      ->set('mode', in_array($mode, ['local', 'remote'], TRUE) ? $mode : (string) $config->get('mode'))
      ->set('address', $address)
      ->set('site', (string) preg_replace('/[^a-z0-9._-]/i', '', (string) $form_state->getValue('site')))
      ->set('observe_key', $key === '' ? $kept : $key)
      ->set('dashboard_key', $dashboard === '' ? $keptDashboard : $dashboard)
      ->set('skip_admins', (bool) $form_state->getValue('skip_admins'))
      ->set('outbound', (bool) $form_state->getValue('outbound'))
      ->set('downloads', (bool) $form_state->getValue('downloads'))
      ->set('locations', (bool) $form_state->getValue('locations'))
      ->save();
    parent::submitForm($form, $form_state);
  }

  /** The Connect button: off to the Runlight's consent page, or back here with why not. */
  public function connect(array &$form, FormStateInterface $form_state): void {
    $to = \Drupal::service('runlight.connect')->start(self::tidy((string) $form_state->getValue('address')));
    if ($to instanceof Response) {
      $form_state->setResponse($to);
      return;
    }
    $this->messenger()->addError($to);
  }

  /** Runlight in this Drupal, chosen on the setup screen. */
  public function runHere(array &$form, FormStateInterface $form_state): void {
    $this->config('runlight.settings')->set('mode', 'local')->save();
    $this->messenger()->addStatus($this->t('Runlight is counting this site.'));
    $form_state->setRedirect('runlight.dashboard');
  }

}
