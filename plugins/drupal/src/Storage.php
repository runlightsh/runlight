<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Component\FileSecurity\FileSecurity;
use Drupal\Core\Database\Connection;
use Drupal\Core\Database\Database;
use Drupal\Core\File\FileSystemInterface;
use Drupal\Core\Site\Settings;
use Drupal\Core\State\StateInterface;
use Runlight\Db\PdoDb;
use Runlight\Store\SqlStore;
use Runlight\Store\Stores;

/**
 * Where Runlight keeps its numbers when it runs in this Drupal: in Drupal's
 * own database, in tables prefixed rl_, when that is Postgres, or MySQL 8.4 or
 * MariaDB 11.4 or later, or else in a SQLite file in the private files folder,
 * or the public one under a name no one can guess. The choice is made the
 * first time Runlight runs and kept in state, so the numbers never split
 * across two places.
 */
final class Storage {

  /** The state entry holding the choice, and for SQLite the file's name. */
  public const STATE = 'runlight.storage';

  /** Runlight's statement timeout on Drupal's database, in milliseconds, as its own stores set one. */
  private const TIMEOUT = 120000;

  /** @var array{kind: string, file: string, folder: string}|null */
  private ?array $kept = NULL;

  public function __construct(
    private readonly StateInterface $state,
    private readonly Connection $database,
    private readonly FileSystemInterface $fileSystem,
  ) {}

  /**
   * Where Runlight keeps its numbers: "mysql", "postgres", "sqlite", or an
   * empty string when this server can do none of them.
   */
  public function kind(): string {
    return $this->kept()['kind'];
  }

  /** @return array{kind: string, file: string, folder: string} */
  private function kept(): array {
    if ($this->kept !== NULL) {
      return $this->kept;
    }
    $saved = $this->state->get(self::STATE);
    if (is_array($saved) && in_array($saved['kind'] ?? '', ['mysql', 'postgres', 'sqlite'], TRUE) && is_string($saved['file'] ?? NULL) && is_string($saved['folder'] ?? NULL)) {
      return $this->kept = ['kind' => $saved['kind'], 'file' => $saved['file'], 'folder' => $saved['folder']];
    }
    $kind = $this->databaseFits();
    if ($kind === '' && extension_loaded('pdo_sqlite')) {
      $kind = 'sqlite';
    }
    $this->kept = [
      'kind' => $kind,
      'file' => 'runlight-' . bin2hex(random_bytes(16)) . '.db',
      // The private folder when the site has one, so the file is out of the web's reach altogether.
      'folder' => (string) Settings::get('file_private_path', '') !== '' ? 'private://runlight' : 'public://runlight',
    ];
    if ($kind !== '') {
      $this->state->set(self::STATE, $this->kept);
    }
    return $this->kept;
  }

  /**
   * Whether Drupal's own database can hold Runlight's tables, and which kind
   * it is: Postgres, or MySQL 8.4 or MariaDB 11.4 or later, whose tables
   * compare text by code point with a collation older servers lack, reached
   * through PDO.
   */
  private function databaseFits(): string {
    $info = Database::getConnectionInfo()['default'] ?? [];
    $driver = (string) ($info['driver'] ?? '');
    // A table prefix of rl_ would put Drupal's tables among Runlight's, which uninstalling drops.
    $prefix = $info['prefix'] ?? '';
    if (is_string($prefix) && stripos($prefix, 'rl_') === 0) {
      return '';
    }
    if ($driver === 'pgsql') {
      return extension_loaded('pdo_pgsql') ? 'postgres' : '';
    }
    if ($driver !== 'mysql' || !extension_loaded('pdo_mysql')) {
      return '';
    }
    try {
      $version = (string) $this->database->query('SELECT VERSION()')->fetchField();
    }
    catch (\Throwable) {
      return '';
    }
    if (!preg_match('/^(\d+\.\d+)/', $version, $number)) {
      return '';
    }
    return version_compare($number[1], stripos($version, 'mariadb') !== FALSE ? '11.4' : '8.4', '>=') ? 'mysql' : '';
  }

  /**
   * The folder for Runlight's files: a SQLite file, location data, and what
   * it shares between requests. Made the first time, with a .htaccess that
   * keeps Apache from serving any of it.
   */
  public function folder(): string {
    $uri = $this->kept()['folder'];
    $this->fileSystem->prepareDirectory($uri, FileSystemInterface::CREATE_DIRECTORY | FileSystemInterface::MODIFY_PERMISSIONS);
    $path = (string) $this->fileSystem->realpath($uri);
    if ($path !== '' && !is_file($path . '/.htaccess')) {
      // The file's name is the protection on servers that read no .htaccess.
      FileSecurity::writeHtaccess($path, TRUE);
    }
    return $path;
  }

  /** The store Runlight runs on. */
  public function store(): SqlStore {
    $kept = $this->kept();
    if ($kept['kind'] === 'mysql') {
      return new SqlStore(new PdoDb(\Closure::fromCallable([self::class, 'connect']), 'mysql', TRUE, self::TIMEOUT));
    }
    if ($kept['kind'] === 'postgres') {
      return new SqlStore(new PdoDb(\Closure::fromCallable([self::class, 'connect']), 'postgres'));
    }
    return Stores::sqlite($this->folder() . '/' . $kept['file']);
  }

  /**
   * A connection to Drupal's database for Runlight's own tables, from the
   * same settings Drupal connects with, set up per connection as Runlight's
   * own stores set theirs up.
   */
  public static function connect(): \PDO {
    $info = Database::getConnectionInfo()['default'];
    $user = isset($info['username']) ? (string) $info['username'] : NULL;
    $password = isset($info['password']) ? (string) $info['password'] : NULL;
    if ($info['driver'] === 'pgsql') {
      $dsn = 'pgsql:host=' . ($info['host'] ?? 'localhost') . ';port=' . ((int) ($info['port'] ?? 0) ?: 5432) . ';dbname=' . $info['database'];
      return new \PDO($dsn . ";options='-c statement_timeout=" . self::TIMEOUT . "'", $user, $password, [\PDO::ATTR_TIMEOUT => 10]);
    }
    $dsn = !empty($info['unix_socket'])
      ? 'mysql:unix_socket=' . $info['unix_socket']
      : 'mysql:host=' . ($info['host'] ?? 'localhost') . (!empty($info['port']) ? ';port=' . (int) $info['port'] : '');
    $ignoreSpace = defined('Pdo\Mysql::ATTR_IGNORE_SPACE') ? \Pdo\Mysql::ATTR_IGNORE_SPACE : \PDO::MYSQL_ATTR_IGNORE_SPACE;
    $pdo = new \PDO($dsn . ';dbname=' . $info['database'] . ';charset=utf8mb4', $user, $password, [\PDO::ATTR_TIMEOUT => 10, $ignoreSpace => TRUE]);
    $mariadb = (bool) preg_match('/mariadb/i', (string) $pdo->query('SELECT VERSION() AS v')->fetchColumn());
    $pdo->exec($mariadb ? 'SET SESSION max_statement_time = ' . (self::TIMEOUT / 1000) : 'SET SESSION max_execution_time = ' . self::TIMEOUT);
    return $pdo;
  }

  /**
   * Removes Runlight's numbers, for uninstalling: its tables, or its SQLite
   * file, with everything else in its folder.
   */
  public function remove(): void {
    $kept = $this->state->get(self::STATE);
    if (is_array($kept) && in_array($kept['kind'] ?? '', ['mysql', 'postgres'], TRUE)) {
      try {
        $pdo = self::connect();
        $tables = $kept['kind'] === 'mysql'
          ? $pdo->query("SHOW TABLES LIKE 'rl\\_%'")->fetchAll(\PDO::FETCH_COLUMN)
          : $pdo->query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'rl\\_%'")->fetchAll(\PDO::FETCH_COLUMN);
        $quote = $kept['kind'] === 'mysql' ? '`' : '"';
        foreach ($tables as $table) {
          $pdo->exec('DROP TABLE IF EXISTS ' . $quote . str_replace($quote, $quote . $quote, (string) $table) . $quote . ($kept['kind'] === 'postgres' ? ' CASCADE' : ''));
        }
      }
      catch (\Throwable) {
        // Uninstalling goes on; the tables are only Runlight's, and harm nothing left behind.
      }
    }
    $folder = is_array($kept) && is_string($kept['folder'] ?? NULL) ? $kept['folder'] : NULL;
    foreach ($folder !== NULL ? [$folder] : ['private://runlight', 'public://runlight'] as $uri) {
      // A private folder named in state may be gone from settings.php since.
      if (str_starts_with($uri, 'private://') && (string) Settings::get('file_private_path', '') === '') {
        continue;
      }
      if (is_dir($uri)) {
        $this->fileSystem->deleteRecursive($uri);
      }
    }
    $this->state->delete(self::STATE);
  }

}
