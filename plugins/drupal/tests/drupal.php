<?php

/**
 * @file
 * Stand-ins for the parts of Drupal the module's classes call, for its tests.
 *
 * The tests are in packages/sdk/test/plugins.test.ts. The Runlight library and
 * the module's classes load from this repository, and everything Drupal keeps,
 * such as state and configuration, lives in memory. Not part of the module.
 */

// phpcs:ignoreFile -- test scaffolding.

declare(strict_types=1);

namespace {
  spl_autoload_register(static function (string $class): void {
    foreach (['Runlight\\' => __DIR__ . '/../../../packages/php/src/', 'Drupal\\runlight\\' => __DIR__ . '/../src/'] as $prefix => $dir) {
      if (str_starts_with($class, $prefix)) {
        $file = $dir . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
          require $file;
        }
      }
    }
  });
  $GLOBALS['drupal_test'] = ['settings' => [], 'back' => 'https://cms.example/admin/config/system/runlight/connected', 'invalidated' => []];
}

namespace Psr\Log {
  interface LoggerInterface {}
}

namespace GuzzleHttp {
  interface ClientInterface {}
}

namespace GuzzleHttp\Exception {
  class TransferException extends \RuntimeException {}
}

namespace Drupal\Component\Datetime {
  interface TimeInterface {}
}

namespace Drupal\Component\FileSecurity {
  final class FileSecurity {
    public static function writeHtaccess(string $path, bool $deny): bool {
      return file_put_contents($path . '/.htaccess', "Require all denied\n") !== FALSE;
    }
  }
}

namespace Drupal\Core\Site {
  final class Settings {
    public static function get(string $name, mixed $default = NULL): mixed {
      return $GLOBALS['drupal_test']['settings'][$name] ?? $default;
    }
  }
}

namespace Drupal\Core\State {
  interface StateInterface {}
}

namespace Drupal\Core\Config {
  interface ConfigFactoryInterface {}
}

namespace Drupal\Core\Cache {
  interface CacheBackendInterface {}
  interface CacheTagsInvalidatorInterface {}
}

namespace Drupal\Core\Database {
  abstract class Connection {}
}

namespace Drupal\Core\File {
  interface FileSystemInterface {
    const CREATE_DIRECTORY = 1;
    const MODIFY_PERMISSIONS = 2;
  }
}

namespace Drupal\Core {
  interface DestructableInterface {}
}

namespace Drupal\Core\Language {
  interface LanguageManagerInterface {}
}

namespace Drupal\Core\Mail {
  interface MailManagerInterface {}
}

namespace Drupal\Core\Session {
  interface AccountInterface {}
}

namespace Drupal\Core\KeyValueStore {
  interface KeyValueExpirableFactoryInterface {}
  interface KeyValueStoreExpirableInterface {}
}

namespace Drupal\Core\StringTranslation {
  final class TranslatableMarkup implements \Stringable {
    public function __construct(private string $text, private array $args = []) {}
    public function __toString(): string {
      return strtr($this->text, array_map('strval', $this->args));
    }
  }
  trait StringTranslationTrait {
    protected function t(string $text, array $args = []): TranslatableMarkup {
      return new TranslatableMarkup($text, $args);
    }
  }
}

namespace Drupal\Core {
  final class Url {
    public static function fromRoute(string $name, array $parameters = [], array $options = []): self {
      return new self();
    }
    public function toString(bool $collect = FALSE): object {
      return new class {
        public function getGeneratedUrl(): string {
          return $GLOBALS['drupal_test']['back'];
        }
      };
    }
  }
}

namespace Drupal\Core\Routing {
  final class TrustedRedirectResponse {
    public function __construct(private string $url) {}
    public function getTargetUrl(): string {
      return $this->url;
    }
    public function getCacheableMetadata(): object {
      return new class {
        public function setCacheMaxAge(int $age): void {}
      };
    }
  }
}

namespace DrupalTest {

  use Drupal\Core\Cache\CacheTagsInvalidatorInterface;
  use Drupal\Core\Config\ConfigFactoryInterface;
  use Drupal\Core\Database\Connection;
  use Drupal\Core\File\FileSystemInterface;
  use Drupal\Core\KeyValueStore\KeyValueExpirableFactoryInterface;
  use Drupal\Core\KeyValueStore\KeyValueStoreExpirableInterface;
  use Drupal\Core\Session\AccountInterface;
  use Drupal\Core\State\StateInterface;
  use GuzzleHttp\ClientInterface;
  use Psr\Log\LoggerInterface;

  final class State implements StateInterface {
    public array $values = [];
    public function get(string $key, mixed $default = NULL): mixed {
      return $this->values[$key] ?? $default;
    }
    public function set(string $key, mixed $value): void {
      $this->values[$key] = $value;
    }
    public function delete(string $key): void {
      unset($this->values[$key]);
    }
  }

  /** One configuration object, with values from settings.php over the saved ones. */
  final class Config {
    public function __construct(public array $saved = [], public array $overrides = []) {}
    public function get(string $key): mixed {
      return array_key_exists($key, $this->overrides) ? $this->overrides[$key] : ($this->saved[$key] ?? NULL);
    }
    public function hasOverrides(string $key = ''): bool {
      return array_key_exists($key, $this->overrides);
    }
    public function set(string $key, mixed $value): self {
      $this->saved[$key] = $value;
      return $this;
    }
    public function save(): self {
      return $this;
    }
  }

  final class ConfigFactory implements ConfigFactoryInterface {
    public array $configs = [];
    public function get(string $name): Config {
      return $this->configs[$name] ??= new Config();
    }
    public function getEditable(string $name): object {
      $config = $this->get($name);
      // The editable copy never carries values from settings.php.
      return new class ($config) {
        public function __construct(private Config $config) {}
        public function get(string $key): mixed {
          return $this->config->saved[$key] ?? NULL;
        }
        public function set(string $key, mixed $value): self {
          $this->config->saved[$key] = $value;
          return $this;
        }
        public function save(): self {
          return $this;
        }
      };
    }
  }

  final class Invalidator implements CacheTagsInvalidatorInterface {
    public function invalidateTags(array $tags): void {
      array_push($GLOBALS['drupal_test']['invalidated'], ...$tags);
    }
  }

  final class Logger implements LoggerInterface {
    public array $lines = [];
    public function __call(string $level, array $args): void {
      $this->lines[] = $level . ': ' . strtr((string) $args[0], array_map('strval', $args[1] ?? []));
    }
  }

  /**
   * Drupal's database: its tables by name without Drupal's prefix, and the
   * owner row in Runlight's meta table.
   */
  final class Database extends Connection {
    public array $dropped = [];
    public function __construct(public array $tables, public string $prefix = '', public string $type = 'mysql', public string $version = '8.4.3', public ?string $owner = NULL) {}
    public function getPrefix(): string {
      return $this->prefix;
    }
    public function databaseType(): string {
      return $this->type;
    }
    public function getClientConnection(): object {
      return new \PDO('sqlite::memory:');
    }
    public function query(string $sql): object {
      $version = $this->version;
      return new class ($version) {
        public function __construct(private string $version) {}
        public function fetchField(): string {
          return $this->version;
        }
      };
    }
    public function schema(): object {
      $db = $this;
      return new class ($db) {
        public function __construct(private Database $db) {}
        public function findTables(string $expression): array {
          $pattern = '/^' . str_replace(['%', '_'], ['.*?', '.'], preg_quote($expression, '/')) . '$/i';
          return array_values(preg_grep($pattern, $this->db->tables));
        }
        public function dropTable(string $table): bool {
          $this->db->dropped[] = $table;
          $this->db->tables = array_values(array_diff($this->db->tables, [$table]));
          return TRUE;
        }
      };
    }
    public function select(string $table, string $alias): object {
      $owner = in_array('rl_meta', $this->tables, TRUE) ? $this->owner : NULL;
      return new class ($owner) {
        public function __construct(private ?string $owner) {}
        public function fields(string $alias, array $fields): self {
          return $this;
        }
        public function condition(string $field, mixed $value): self {
          return $this;
        }
        public function execute(): self {
          return $this;
        }
        public function fetchField(): string|false {
          return $this->owner ?? FALSE;
        }
      };
    }
  }

  final class FileSystem implements FileSystemInterface {
    public function __construct(public string $root) {}
    public function prepareDirectory(string &$uri, int $options = 0): bool {
      $path = $this->realpath($uri);
      return $path !== FALSE && (is_dir($path) || mkdir($path, 0700, TRUE));
    }
    public function realpath(string $uri): string|false {
      return preg_match('#^(\w+)://(.*)$#', $uri, $m) ? $this->root . '/' . $m[1] . '/' . $m[2] : FALSE;
    }
    public function deleteRecursive(string $uri): bool {
      return TRUE;
    }
  }

  final class Clock implements \Drupal\Component\Datetime\TimeInterface {
    public function __construct(public int $now) {}
    public function getCurrentTime(): int {
      return $this->now;
    }
  }

  /** Drupal's database cache: an expired item stays until it is deleted. */
  final class CacheBackend implements \Drupal\Core\Cache\CacheBackendInterface {
    public array $items = [];
    public function __construct(private Clock $clock) {}
    public function get(string $cid, bool $allowInvalid = FALSE): object|false {
      $item = $this->items[$cid] ?? NULL;
      if ($item === NULL) {
        return FALSE;
      }
      $item = (object) $item;
      $item->valid = $item->expire >= $this->clock->now;
      return $item->valid || $allowInvalid ? $item : FALSE;
    }
    public function set(string $cid, mixed $data, int $expire = -1, array $tags = []): void {
      $this->items[$cid] = ['data' => $data, 'expire' => $expire, 'tags' => $tags];
    }
    public function delete(string $cid): void {
      unset($this->items[$cid]);
    }
    public function deleteMultiple(array $cids): void {
      foreach ($cids as $cid) {
        unset($this->items[$cid]);
      }
    }
  }

  final class Account implements AccountInterface {
    public function __construct(private int $id = 1) {}
    public function id(): int {
      return $this->id;
    }
  }

  /** The key-value store, with expiry ignored. */
  final class KeyValue implements KeyValueExpirableFactoryInterface {
    public array $collections = [];
    public function get(string $collection): KeyValueStoreExpirableInterface {
      $values = &$this->collections[$collection];
      $values ??= [];
      return new class ($values) implements KeyValueStoreExpirableInterface {
        public function __construct(private array &$values) {}
        public function get(string $key, mixed $default = NULL): mixed {
          return $this->values[$key] ?? $default;
        }
        public function setWithExpire(string $key, mixed $value, int $expire): void {
          $this->values[$key] = $value;
        }
        public function delete(string $key): void {
          unset($this->values[$key]);
        }
      };
    }
  }

  /**
   * Drupal's HTTP client, answered by a Runlight in this process, or failing
   * as a network would.
   */
  final class Client implements ClientInterface {
    public ?string $fail = NULL;
    public function __construct(private ?\Closure $answer = NULL) {}
    public function request(string $method, string $url, array $options = []): object {
      if ($this->fail !== NULL) {
        throw new \GuzzleHttp\Exception\TransferException($this->fail);
      }
      $headers = $options['headers'] ?? [];
      $body = '';
      if (isset($options['json'])) {
        $headers['content-type'] = 'application/json';
        $body = json_encode($options['json']);
      }
      elseif (isset($options['form_params'])) {
        $headers['content-type'] = 'application/x-www-form-urlencoded';
        $body = http_build_query($options['form_params']);
      }
      $answer = ($this->answer)(new \Runlight\Http\Request($url, $method, $headers, $body));
      return new class ($answer) {
        public function __construct(private \Runlight\Http\Response $answer) {}
        public function getStatusCode(): int {
          return $this->answer->status;
        }
        public function getBody(): string {
          return $this->answer->text();
        }
      };
    }
  }

}
