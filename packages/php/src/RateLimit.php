<?php

declare(strict_types=1);

namespace Runlight;

/**
 * Counts tracker requests per address in fixed one-minute windows. Addresses
 * are hashed with a key made each day, so the count never holds an IP, each
 * window's counts are dropped when it ends, and yesterday's key goes with them,
 * so no leftover hash can be matched to an address by trying them all.
 *
 * PHP forgets everything between requests, so the counts live where requests
 * can share them: in the app's Cache when it passes one, else APCu when it is
 * loaded, or else one small file per window in the server's data folder or the
 * system's temporary folder (see Scratch).
 * Several servers behind a load balancer each count on their own, as the
 * TypeScript SDK's processes do.
 */
final class RateLimit
{
    /** @var array<string, int> counts kept in this process, used when no Cache, APCu, or temporary folder works */
    private array $counts = [];
    private int $window = 0;
    /** @var array<string, string> today's key by its file, read once per process */
    private static array $keys = [];
    private ?string $ownKey = null;
    /** The folder the counts are kept in, null when there is none to use, and false until looked for. */
    private string|false|null $folder = false;

    /**
     * @param callable(): int $now milliseconds
     * @param bool $shared whether to share counts with other requests through the Cache, APCu, or the temporary
     *   folder; a Runlight on a clock given in code (tests, replays) counts on its own, since the same minutes
     *   come again
     * @param Cache|null $cache the app's own place for shared values, used in place of APCu and files
     */
    public function __construct(private readonly int $perMinute, private $now, private readonly ?string $dir = null, private readonly bool $shared = true, private readonly ?Cache $cache = null)
    {
    }

    /** True while this address is under its limit for the current minute. */
    public function allow(string $ip): bool
    {
        // No address cannot be told apart, so it is not limited.
        if ($ip === '') {
            return true;
        }
        $ms = ($this->now)();
        $window = intdiv($ms, 60_000);
        $id = substr(hash('sha256', $this->key(intdiv($ms, 86_400_000)) . $ip), 0, 16);
        if ($this->shared && $this->cache !== null) {
            $count = $this->cache->increment("runlight:rl:$window:$id", 120);
            if ($count !== null) {
                return $count <= $this->perMinute;
            }
        } elseif ($this->shared && self::apcu()) {
            $name = "runlight:rl:$window:$id";
            apcu_add($name, 0, 120);
            $count = apcu_inc($name);
            if ($count !== false) {
                return $count <= $this->perMinute;
            }
        }
        $count = $this->shared && $this->cache === null ? $this->countInFile($window, $id) : null;
        if ($count !== null) {
            return $count <= $this->perMinute;
        }
        if ($window !== $this->window) {
            $this->window = $window;
            $this->counts = [];
        }
        $this->counts[$id] = ($this->counts[$id] ?? 0) + 1;
        return $this->counts[$id] <= $this->perMinute;
    }

    /**
     * Deletes the windows that have ended and every key but today's. Each counted request does this, and the
     * scheduled check does too, so the files go even once the requests stop. What a Cache keeps expires itself.
     */
    public function sweep(): void
    {
        if (!$this->shared || $this->cache !== null) {
            return;
        }
        $ms = ($this->now)();
        $window = intdiv($ms, 60_000);
        $today = 'key-' . intdiv($ms, 86_400_000);
        $dir = $this->folder();
        if ($dir === null) {
            return;
        }
        foreach (glob($dir . '/*') ?: [] as $old) {
            $name = basename($old);
            // A bare "key" is one an earlier version kept for good.
            $stale = preg_match('/^[0-9]+\z/', $name) ? (int) $name < $window - 1 : ($name === 'key' || (str_starts_with($name, 'key-') && $name !== $today));
            if ($stale) {
                Scratch::delete($old);
            }
        }
    }

    private function folder(): ?string
    {
        if ($this->folder === false) {
            $this->folder = Scratch::dir('runlight-rate', $this->dir);
        }
        return $this->folder;
    }

    private static function apcu(): bool
    {
        return function_exists('apcu_enabled') && apcu_enabled();
    }

    private function countInFile(int $window, string $id): ?int
    {
        $dir = $this->folder();
        if ($dir === null) {
            return null;
        }
        $count = Scratch::count("$dir/$window", $id);
        if ($count === null) {
            return null;
        }
        $this->sweep();
        return $count;
    }

    /**
     * Today's key, shared by every request on the server, so the hashes cannot be turned back into addresses
     * without it. A limiter that counts on its own keeps a key of its own in memory.
     */
    private function key(int $day): string
    {
        if (!$this->shared) {
            return $this->ownKey ??= random_bytes(16);
        }
        if ($this->cache !== null) {
            $name = "runlight:rl:key:$day";
            $stored = $this->cache->get($name);
            if ($stored === null || strlen($stored) !== 16) {
                $this->cache->add($name, random_bytes(16), 2 * 86_400);
                $stored = $this->cache->get($name);
            }
            // A cache that keeps nothing leaves a key of this process's own.
            return $stored !== null && strlen($stored) === 16 ? $stored : ($this->ownKey ??= random_bytes(16));
        }
        $dir = $this->folder();
        $file = ($dir ?? '') . "/key-$day";
        if (isset(self::$keys[$file])) {
            return self::$keys[$file];
        }
        if (self::apcu()) {
            $name = "runlight:rl:key:$day";
            $stored = apcu_fetch($name);
            if (!is_string($stored)) {
                apcu_add($name, random_bytes(16), 2 * 86_400);
                $stored = apcu_fetch($name);
            }
            if (is_string($stored)) {
                return self::$keys[$file] = $stored;
            }
        }
        $made = random_bytes(16);
        if ($dir === null) {
            return self::$keys[$file] = $made;
        }
        return self::$keys[$file] = Scratch::keep($file, $made) ?? $made;
    }
}
