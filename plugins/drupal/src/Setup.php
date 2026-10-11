<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Core\Cache\CacheTagsInvalidatorInterface;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\State\StateInterface;

/**
 * Where Runlight runs, and the address and keys for a Runlight elsewhere.
 *
 * They belong to one environment, so they are kept in state, which is never
 * exported with the site's configuration: a key never reaches a repository,
 * and importing configuration never points one environment at another's
 * Runlight. A value set in settings.php, such as
 * $config['runlight.settings']['dashboard_key'], wins over both. Values saved
 * in configuration by an earlier version of the module still count until the
 * settings are next saved, which moves them here.
 */
final class Setup {

  /**
   * The state entry holding these settings.
   */
  public const STATE = 'runlight.setup';

  /**
   * The settings kept here, by their names in runlight.settings.
   */
  public const FIELDS = ['mode', 'address', 'site', 'observe_key', 'dashboard_key'];

  /**
   * The cache tag on pages with the script, which a change here clears.
   */
  public const TAG = 'config:runlight.settings';

  public function __construct(
    private readonly ConfigFactoryInterface $configFactory,
    private readonly StateInterface $state,
    private readonly CacheTagsInvalidatorInterface $invalidator,
  ) {}

  /**
   * One setting, as it applies.
   *
   * @param string $name
   *   One of FIELDS.
   *
   * @return string
   *   The value from settings.php, else the one kept here, else the one an
   *   earlier version saved in configuration.
   */
  public function get(string $name): string {
    $config = $this->configFactory->get('runlight.settings');
    if ($config->hasOverrides($name)) {
      return trim((string) $config->get($name));
    }
    $kept = $this->state->get(self::STATE);
    if (is_array($kept) && array_key_exists($name, $kept)) {
      return (string) $kept[$name];
    }
    return trim((string) $config->get($name));
  }

  /**
   * Every setting kept here, as they apply.
   *
   * @return array<string, string>
   *   The settings by name.
   */
  public function all(): array {
    $all = [];
    foreach (self::FIELDS as $name) {
      $all[$name] = $this->get($name);
    }
    return $all;
  }

  /**
   * Where Runlight runs: "local", "remote", or "" until the admin chooses.
   */
  public function mode(): string {
    return self::modeOf($this->get('mode'), $this->get('address'));
  }

  /**
   * Whether Runlight is set up; until then the settings show the setup screen.
   */
  public function isSetUp(): bool {
    return self::setUp($this->all());
  }

  /**
   * Keeps settings, and takes any an earlier version kept out of the config.
   *
   * @param array<string, string> $values
   *   Settings by name, each one of FIELDS.
   */
  public function save(array $values): void {
    $kept = $this->state->get(self::STATE);
    $kept = is_array($kept) ? $kept : [];
    // An earlier version's values come along the first time, so none is lost.
    $config = $this->configFactory->getEditable('runlight.settings');
    foreach (self::FIELDS as $name) {
      if (!array_key_exists($name, $kept)) {
        $kept[$name] = trim((string) $config->get($name));
      }
      if (array_key_exists($name, $values)) {
        $kept[$name] = (string) $values[$name];
      }
    }
    $this->state->set(self::STATE, $kept);
    $stale = FALSE;
    foreach (self::FIELDS as $name) {
      if ((string) $config->get($name) !== '') {
        $config->set($name, '');
        $stale = TRUE;
      }
    }
    if ($stale) {
      $config->save();
    }
    // Pages with the script were cached for the settings as they were.
    $this->invalidator->invalidateTags([self::TAG]);
  }

  /**
   * Forgets every setting kept here, for uninstalling.
   */
  public function delete(): void {
    $this->state->delete(self::STATE);
  }

  /**
   * Where Runlight runs, from the saved choice and address.
   *
   * @param string|null $saved
   *   The choice saved, if any.
   * @param string|null $address
   *   The address saved, if any.
   *
   * @return string
   *   "local", "remote", or an empty string until the admin chooses, so
   *   nothing is counted before then. An address saved before there was a
   *   choice means another Runlight.
   */
  public static function modeOf(?string $saved, ?string $address): string {
    if (in_array($saved, ['local', 'remote'], TRUE)) {
      return $saved;
    }
    return (string) $address !== '' ? 'remote' : '';
  }

  /**
   * Whether settings say Runlight is set up.
   *
   * @param array<string, string> $values
   *   The settings by name.
   *
   * @return bool
   *   Running here, or another Runlight chosen with at least its address or a
   *   key saved.
   */
  public static function setUp(array $values): bool {
    $mode = self::modeOf($values['mode'] ?? '', $values['address'] ?? '');
    if ($mode === 'local') {
      return TRUE;
    }
    return $mode === 'remote' && (($values['address'] ?? '') !== '' || ($values['observe_key'] ?? '') !== '' || ($values['dashboard_key'] ?? '') !== '');
  }

  /**
   * The keys to keep when the settings form is saved.
   *
   * A key left blank stays, so it never has to be shown again, but only for
   * the same address: pointed somewhere else, the module must never send that
   * Runlight's key there.
   *
   * @param array<string, string> $saved
   *   The settings as they were.
   * @param string $address
   *   The address entered.
   * @param string $observe
   *   The agents key entered, or an empty string.
   * @param string $dashboard
   *   The dashboard key entered, or an empty string.
   *
   * @return array{observe_key: string, dashboard_key: string}
   *   The keys to save.
   */
  public static function keys(array $saved, string $address, string $observe, string $dashboard): array {
    $same = $address === ($saved['address'] ?? '');
    return [
      'observe_key' => $observe !== '' ? $observe : ($same ? ($saved['observe_key'] ?? '') : ''),
      'dashboard_key' => $dashboard !== '' ? $dashboard : ($same ? ($saved['dashboard_key'] ?? '') : ''),
    ];
  }

}
