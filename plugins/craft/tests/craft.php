<?php

/**
 * Stand-ins for the parts of Craft the plugin's classes call, for its tests (packages/sdk/test/plugins.test.ts).
 * The Runlight library and the plugin's classes load from this repository, and everything Craft keeps, such
 * as its cache and its database's tables, lives in memory. Not part of the plugin.
 */

declare(strict_types=1);

namespace {
    spl_autoload_register(static function (string $class): void {
        foreach (['Runlight\\Craft\\' => __DIR__ . '/../src/', 'Runlight\\' => __DIR__ . '/../../../packages/php/src/'] as $prefix => $dir) {
            if (str_starts_with($class, $prefix)) {
                $file = $dir . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
                if (is_file($file)) {
                    require $file;
                }
                return;
            }
        }
    });

    final class Craft
    {
        public static object $app;
        public static array $logged = [];

        public static function t(string $category, string $message, array $params = []): string
        {
            $out = $message;
            foreach ($params as $name => $value) {
                $out = str_replace('{' . $name . '}', (string) $value, $out);
            }
            return $out;
        }

        public static function warning(string $message, string $category): void
        {
            self::$logged[] = $message;
        }

        public static function info(string $message, string $category): void
        {
        }

        public static function error(string $message, string $category): void
        {
            self::$logged[] = $message;
        }
    }
}

namespace GuzzleHttp {
    interface ClientInterface {}
}

namespace GuzzleHttp\Exception {
    class TransferException extends \RuntimeException {}
}

namespace yii\caching {
    interface CacheInterface {}
}

namespace yii\queue {
    abstract class Queue
    {
        const STATUS_WAITING = 1;
        const STATUS_RESERVED = 2;
    }
}

namespace craft\helpers {
    final class FileHelper
    {
        public static array $removed = [];

        public static function createDirectory(string $path): void
        {
            @mkdir($path, 0775, true);
        }

        public static function removeDirectory(string $path): void
        {
            self::$removed[] = $path;
        }
    }
}

namespace craft\db {
    /** Reads the owner row of Runlight's meta table from the stand-in database. */
    final class Query
    {
        private string $table = '';

        public function select(array $columns): self
        {
            return $this;
        }

        public function from(string $table): self
        {
            $this->table = $table;
            return $this;
        }

        public function where(array $condition): self
        {
            return $this;
        }

        public function scalar(): string|false
        {
            return \Craft::$app->db->owners[$this->table] ?? false;
        }
    }
}

namespace craft\web {
    /** Craft's request: the connection's address, and the trustedHosts setting, at Craft's default unless given. */
    class Request
    {
        public function __construct(private string $url, private array $headers, private string $ip, public array $trustedHosts = ['any'])
        {
        }

        public function getAbsoluteUrl(): string
        {
            return $this->url;
        }

        public function getHeaders(): object
        {
            $headers = $this->headers;
            return new class ($headers) {
                public function __construct(private array $headers)
                {
                }

                public function toArray(): array
                {
                    return array_map(static fn ($v) => [$v], $this->headers);
                }
            };
        }

        public function getMethod(): string
        {
            return 'GET';
        }

        public function getRemoteIP(): ?string
        {
            return $this->ip;
        }

        /** As Craft gives it from trusted hosts: the first address in X-Forwarded-For, else the connection's. */
        public function getUserIP(): ?string
        {
            $forwarded = trim(explode(',', $this->headers['x-forwarded-for'] ?? '')[0]);
            return $forwarded !== '' ? $forwarded : $this->ip;
        }
    }
}

namespace CraftTest {
    use GuzzleHttp\ClientInterface;
    use yii\caching\CacheInterface;

    /** Craft's cache: an expired entry stays until it is deleted, as in Craft's file cache. */
    final class Cache implements CacheInterface
    {
        public array $entries = [];
        public int $now = 1_791_288_000;

        public function get(string $key): mixed
        {
            $entry = $this->entries[$key] ?? null;
            return $entry !== null && ($entry[1] === 0 || $entry[1] >= $this->now) ? $entry[0] : false;
        }

        public function set(string $key, mixed $value, int $duration = 0): bool
        {
            $this->entries[$key] = [$value, $duration > 0 ? $this->now + $duration : 0];
            return true;
        }

        public function delete(string $key): bool
        {
            unset($this->entries[$key]);
            return true;
        }
    }

    /** Craft's database: its tables by name, prefix and all, and the owner row in each meta table. */
    final class Db
    {
        public array $dropped = [];
        public array $owners = [];

        public function __construct(public array $tables, public string $tablePrefix = '', public string $driver = 'mysql', public string $version = '8.4.3')
        {
        }

        public function getIsPgsql(): bool
        {
            return $this->driver === 'pgsql';
        }

        public function getIsMysql(): bool
        {
            return $this->driver === 'mysql';
        }

        public function getIsMaria(): bool
        {
            return str_contains(strtolower($this->version), 'mariadb');
        }

        public function getSchema(): object
        {
            $db = $this;
            return new class ($db) {
                public function __construct(private Db $db)
                {
                }

                public function getTableNames(string $schema = '', bool $refresh = false): array
                {
                    return $this->db->tables;
                }

                public function getServerVersion(): string
                {
                    return $this->db->version;
                }
            };
        }

        public function createCommand(): object
        {
            $db = $this;
            return new class ($db) {
                private string $table = '';

                public function __construct(private Db $db)
                {
                }

                public function dropTable(string $table): self
                {
                    $this->table = $table;
                    return $this;
                }

                public function execute(): int
                {
                    $this->db->dropped[] = $this->table;
                    $this->db->tables = array_values(array_diff($this->db->tables, [$this->table]));
                    return 0;
                }
            };
        }
    }

    /** The signed-in user. */
    final class User
    {
        public function __construct(public bool $guest = false, public bool $admin = false, public array $permissions = [])
        {
        }

        public function getIsGuest(): bool
        {
            return $this->guest;
        }

        public function getIsAdmin(): bool
        {
            return $this->admin;
        }

        public function checkPermission(string $permission): bool
        {
            return in_array(strtolower($permission), array_map('strtolower', $this->permissions), true);
        }
    }

    /** Craft::$app, with only what the plugin's classes ask of it. */
    final class App
    {
        public User $user;

        public function __construct(public Db $db, public Cache $cache, public string $storage, public string $uid = 'install-1')
        {
            $this->user = new User();
        }

        public function getDb(): Db
        {
            return $this->db;
        }

        public function getCache(): Cache
        {
            return $this->cache;
        }

        public function getSystemUid(): string
        {
            return $this->uid;
        }

        public function getUser(): User
        {
            return $this->user;
        }

        public function getPath(): object
        {
            $storage = $this->storage;
            return new class ($storage) {
                public function __construct(private string $storage)
                {
                }

                public function getStoragePath(): string
                {
                    return $this->storage;
                }
            };
        }
    }

    /** Craft's Guzzle client, answered by a Runlight in this process, or failing as a network would. */
    final class Client implements ClientInterface
    {
        public ?string $fail = null;

        public function __construct(private ?\Closure $answer = null)
        {
        }

        public function request(string $method, string $url, array $options = []): object
        {
            if ($this->fail !== null) {
                throw new \GuzzleHttp\Exception\TransferException($this->fail);
            }
            $headers = $options['headers'] ?? [];
            $body = '';
            if (isset($options['json'])) {
                $headers['content-type'] = 'application/json';
                $body = json_encode($options['json']);
            } elseif (isset($options['form_params'])) {
                $headers['content-type'] = 'application/x-www-form-urlencoded';
                $body = http_build_query($options['form_params']);
            }
            $answer = ($this->answer)(new \Runlight\Http\Request($url, $method, $headers, $body));
            return new class ($answer) {
                public function __construct(private \Runlight\Http\Response $answer)
                {
                }

                public function getStatusCode(): int
                {
                    return $this->answer->status;
                }

                public function getBody(): string
                {
                    return $this->answer->text();
                }
            };
        }
    }
}
