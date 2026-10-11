<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Component\FileSecurity\FileSecurity;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Database\Connection;
use Drupal\Core\File\FileSystemInterface;
use Drupal\Core\Site\Settings;
use Drupal\Core\State\StateInterface;
use Psr\Log\LoggerInterface;
use Runlight\Db\PdoDb;
use Runlight\Store\Sql;
use Runlight\Store\SqlStore;
use Runlight\Store\Stores;

/**
 * Where Runlight keeps its numbers when it runs in this Drupal.
 *
 * In Drupal's own database when that is Postgres, or MySQL 8.0.20 or MariaDB
 * 11.4 or later, in tables named after Drupal's table prefix and rl_, such as
 * rl_events, or d_rl_events with a prefix of d_. Otherwise in a SQLite file
 * in the private files folder, which the web never serves. The choice is made
 * the first time Runlight opens its store and kept in state, so the numbers
 * never split across two places.
 *
 * Runlight's tables are made only where no table already starts as theirs
 * would, unless those are all Runlight's own and marked as this site's, so a
 * standalone Runlight or another app sharing the database is never touched,
 * and uninstalling drops Runlight's tables by name, and only this site's.
 */
final class Storage {

  /**
   * The state entry holding the choice, and for SQLite the file's name.
   */
  public const STATE = 'runlight.storage';

  /**
   * The folder for Runlight's files, when the site has a private one.
   */
  private const FOLDER = 'private://runlight';

  /**
   * The folder for location data when the site has no private one.
   */
  private const TEMPORARY = 'temporary://runlight';

  /**
   * The row in Runlight's meta table that names the site whose tables they are.
   */
  private const OWNER = 'drupal';

  /**
   * Runlight's statement timeout on Drupal's database, in milliseconds.
   *
   * As Runlight's own stores set one.
   */
  private const TIMEOUT = 120000;

  /**
   * The choice, worked out or read once a request.
   *
   * @var array{kind: string, file: string}|null
   */
  private ?array $kept = NULL;

  /**
   * Whether Drupal's database could hold Runlight's tables but for others'.
   */
  private bool $clash = FALSE;

  public function __construct(
    private readonly StateInterface $state,
    private readonly Connection $database,
    private readonly FileSystemInterface $fileSystem,
    private readonly ConfigFactoryInterface $configFactory,
    private readonly LoggerInterface $logger,
  ) {}

  /**
   * Where Runlight keeps its numbers.
   *
   * @return string
   *   "mysql", "postgres", "sqlite", or an empty string when this server can
   *   do none of them.
   */
  public function kind(): string {
    return $this->kept()['kind'];
  }

  /**
   * The choice as kept, or as it would be made now.
   *
   * @return array{kind: string, file: string}
   *   The kind, and for SQLite the file's name.
   */
  private function kept(): array {
    if ($this->kept !== NULL) {
      return $this->kept;
    }
    $saved = $this->state->get(self::STATE);
    if (is_array($saved) && in_array($saved['kind'] ?? '', ['mysql', 'postgres', 'sqlite'], TRUE) && is_string($saved['file'] ?? NULL)) {
      // A SQLite file needs the private folder it was made in, which
      // settings.php may no longer name.
      $kind = $saved['kind'] === 'sqlite' && $this->folder() === '' ? '' : $saved['kind'];
      return $this->kept = ['kind' => $kind, 'file' => $saved['file']];
    }
    $kind = $this->databaseFits();
    if ($kind !== '' && !$this->free()) {
      $kind = '';
      $this->clash = TRUE;
    }
    if ($kind === '' && extension_loaded('pdo_sqlite') && $this->folder() !== '') {
      $kind = 'sqlite';
    }
    return $this->kept = ['kind' => $kind, 'file' => 'runlight-' . bin2hex(random_bytes(16)) . '.db'];
  }

  /**
   * Whether tables of another's stop Runlight's going in Drupal's database.
   *
   * @return bool
   *   TRUE when Drupal's database would do, but tables starting as
   *   Runlight's would are already there and are not this site's Runlight's.
   */
  public function clash(): bool {
    $this->kept();
    return $this->clash;
  }

  /**
   * What Runlight's table names start with in Drupal's database.
   *
   * @return string
   *   Drupal's own table prefix, then rl_.
   */
  public function prefix(): string {
    return $this->database->getPrefix() . Sql::PREFIX;
  }

  /**
   * Runlight's tables, by the names Drupal's schema API takes.
   *
   * Those are without Drupal's prefix, which it adds itself.
   *
   * @return list<string>
   *   The names, the only ones Runlight ever makes or drops.
   */
  private static function tables(): array {
    return array_map(static fn (string $table): string => Sql::PREFIX . $table, Sql::TABLES);
  }

  /**
   * The tables already in Drupal's database that start as Runlight's would.
   *
   * @return list<string>
   *   Their names, without Drupal's prefix, in lower case.
   */
  private function found(): array {
    $found = [];
    foreach ($this->database->schema()->findTables(Sql::PREFIX . '%') as $table) {
      if (stripos((string) $table, Sql::PREFIX) === 0) {
        $found[] = strtolower((string) $table);
      }
    }
    return $found;
  }

  /**
   * The id that marks Runlight's tables as this site's.
   */
  private function owner(): string {
    return (string) $this->configFactory->get('system.site')->get('uuid');
  }

  /**
   * Whether Runlight's tables in Drupal's database are this site's own.
   *
   * @param list<string> $found
   *   The tables found that start as Runlight's would.
   */
  private function ours(array $found): bool {
    if (!in_array(Sql::PREFIX . 'meta', $found, TRUE) || array_diff($found, self::tables()) !== []) {
      return FALSE;
    }
    try {
      $owner = $this->database->select(Sql::PREFIX . 'meta', 'm')
        ->fields('m', ['value'])
        ->condition('key', self::OWNER)
        ->execute()
        ->fetchField();
    }
    catch (\Throwable) {
      return FALSE;
    }
    return is_string($owner) && $owner !== '' && hash_equals($owner, $this->owner());
  }

  /**
   * Whether Runlight's tables can go in Drupal's database.
   *
   * They can when no table there starts as theirs would, or every one that
   * does is Runlight's own and marked as this site's, left by an earlier
   * install. Otherwise the numbers go in a SQLite file.
   */
  private function free(): bool {
    $found = $this->found();
    return $found === [] || $this->ours($found);
  }

  /**
   * Which kind of database Drupal's own is, if it can hold Runlight's tables.
   *
   * @return string
   *   "postgres", or "mysql" for MySQL 8.0.20 or MariaDB 11.4 or later, whose
   *   tables compare text by code point with a collation older servers lack,
   *   or an empty string for any other.
   */
  private function databaseFits(): string {
    try {
      // Runlight opens a PDO connection of its own the way Drupal opens its.
      if (!$this->database->getClientConnection() instanceof \PDO || !preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,31}$/D', $this->prefix())) {
        return '';
      }
      $type = $this->database->databaseType();
      if ($type === 'pgsql') {
        return 'postgres';
      }
      if ($type !== 'mysql') {
        return '';
      }
      $version = (string) $this->database->query('SELECT VERSION()')->fetchField();
    }
    catch (\Throwable) {
      return '';
    }
    if (!preg_match('/^(\d+\.\d+(?:\.\d+)?)/', $version, $number)) {
      return '';
    }
    return version_compare($number[1], stripos($version, 'mariadb') !== FALSE ? '11.4' : '8.0.20', '>=') ? 'mysql' : '';
  }

  /**
   * The folder for a SQLite file and location data.
   *
   * Made the first time, with a .htaccess that keeps Apache from serving any
   * of it.
   *
   * @return string
   *   Its path, under the private files folder, or an empty string when the
   *   site has none, or it is not on this server's disk.
   */
  public function folder(): string {
    return (string) Settings::get('file_private_path', '') !== '' ? $this->prepare(self::FOLDER) : '';
  }

  /**
   * The folder for location data from DB-IP.
   *
   * @return string
   *   Its path, in Runlight's folder, or else in Drupal's temporary folder,
   *   which is outside the web root, or an empty string for neither.
   */
  public function geoFolder(): string {
    $folder = $this->folder();
    if ($folder !== '') {
      return $folder . '/geo';
    }
    $temporary = $this->prepare(self::TEMPORARY);
    return $temporary !== '' ? $temporary . '/geo' : '';
  }

  /**
   * Makes a folder, if need be, with a .htaccess that keeps Apache out.
   */
  private function prepare(string $uri): string {
    $this->fileSystem->prepareDirectory($uri, FileSystemInterface::CREATE_DIRECTORY | FileSystemInterface::MODIFY_PERMISSIONS);
    $path = (string) $this->fileSystem->realpath($uri);
    if ($path !== '' && !is_file($path . '/.htaccess')) {
      FileSecurity::writeHtaccess($path, TRUE);
    }
    return $path;
  }

  /**
   * The store Runlight runs on.
   *
   * The first time, the choice is kept, and in Drupal's database the tables
   * are made and marked as this site's.
   */
  public function store(): SqlStore {
    $kept = $this->kept();
    $new = !is_array($this->state->get(self::STATE));
    if ($kept['kind'] === '') {
      throw new \RuntimeException('Runlight has nowhere to keep its numbers on this server.');
    }
    if ($kept['kind'] === 'sqlite') {
      $store = Stores::sqlite($this->folder() . '/' . $kept['file']);
    }
    else {
      $dialect = $kept['kind'];
      $store = new SqlStore(new PdoDb(fn (): \PDO => $this->connect(), $dialect, TRUE, $dialect === 'mysql' ? self::TIMEOUT : 0), $this->prefix());
      if ($new) {
        $store->migrate(TRUE);
        $mark = Sql::upsert($dialect, 'rl_meta', ['"key"', 'value'], ['"key"'], ['value']);
        $store->db->run($mark, [self::OWNER, $this->owner()]);
      }
    }
    if ($new) {
      $this->state->set(self::STATE, $kept);
    }
    return $store;
  }

  /**
   * A connection to Drupal's database for Runlight's own tables.
   *
   * Opened by Drupal's own driver from Drupal's connection options, so TLS
   * settings under 'pdo' and the 'init_commands' apply as they do to Drupal's
   * connection, but never the same connection, so neither changes the other's
   * session or transactions. Values come back as their own types, as from
   * Runlight's own stores, and statements stop after Runlight's timeout.
   */
  public function connect(): \PDO {
    $options = $this->database->getConnectionOptions();
    $mysql = $this->database->databaseType() === 'mysql';
    $ours = [\PDO::ATTR_STRINGIFY_FETCHES => FALSE];
    if ($mysql) {
      // The client flag mysql2 sets, which Runlight's statements are written
      // for, under its name from PHP 8.4 when there is one.
      $ignoreSpace = defined('Pdo\Mysql::ATTR_IGNORE_SPACE') ? constant('Pdo\Mysql::ATTR_IGNORE_SPACE') : \PDO::MYSQL_ATTR_IGNORE_SPACE;
      $ours[$ignoreSpace] = TRUE;
    }
    $options['pdo'] = $ours + (array) ($options['pdo'] ?? []) + [\PDO::ATTR_TIMEOUT => 10];
    $class = get_class($this->database);
    $pdo = $class::open($options);
    if (!$pdo instanceof \PDO) {
      throw new \RuntimeException('Drupal’s database driver did not open a PDO connection.');
    }
    if ($mysql) {
      $mariadb = (bool) preg_match('/mariadb/i', (string) $pdo->query('SELECT VERSION()')->fetchColumn());
      $pdo->exec($mariadb ? 'SET SESSION max_statement_time = ' . (self::TIMEOUT / 1000) : 'SET SESSION max_execution_time = ' . self::TIMEOUT);
      return $pdo;
    }
    // What Drupal's Postgres connection sets up once it is open.
    $pdo->exec("SET NAMES 'UTF8'");
    if (!empty($options['init_commands'])) {
      $pdo->exec(implode('; ', (array) $options['init_commands']));
    }
    $schema = (string) ($options['schema'] ?? '');
    if ($schema !== '' && $schema !== 'public') {
      $pdo->exec('SET search_path TO "' . preg_replace('/[^A-Za-z0-9_]+/', '', $schema) . '"');
    }
    $pdo->exec('SET statement_timeout = ' . self::TIMEOUT);
    return $pdo;
  }

  /**
   * Removes Runlight's numbers, for uninstalling.
   *
   * Its tables go, each by name and only when they are all Runlight's and
   * marked as this site's, or else its SQLite file, with everything else in
   * its folder.
   */
  public function remove(): void {
    $kept = $this->state->get(self::STATE);
    if (is_array($kept) && in_array($kept['kind'] ?? '', ['mysql', 'postgres'], TRUE)) {
      try {
        $found = $this->found();
        if ($this->ours($found)) {
          foreach (array_intersect(self::tables(), $found) as $table) {
            $this->database->schema()->dropTable($table);
          }
        }
        elseif ($found !== []) {
          $this->logger->warning('Runlight left the tables starting @prefix in place, since they are not all its own for this site.', ['@prefix' => $this->prefix()]);
        }
      }
      catch (\Throwable $e) {
        $this->logger->warning('Runlight could not drop its tables: @message', ['@message' => $e->getMessage()]);
      }
    }
    foreach ([self::FOLDER, self::TEMPORARY] as $uri) {
      // A private folder may be gone from settings.php since.
      if (str_starts_with($uri, 'private://') && (string) Settings::get('file_private_path', '') === '') {
        continue;
      }
      try {
        $path = $this->fileSystem->realpath($uri);
        if (is_string($path) && $path !== '' && is_dir($path)) {
          $this->fileSystem->deleteRecursive($uri);
        }
      }
      catch (\Throwable $e) {
        $this->logger->warning('Runlight could not delete @folder: @message', [
          '@folder' => $uri,
          '@message' => $e->getMessage(),
        ]);
      }
    }
    $this->state->delete(self::STATE);
    $this->kept = NULL;
  }

}
