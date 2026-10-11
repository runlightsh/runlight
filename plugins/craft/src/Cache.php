<?php

declare(strict_types=1);

namespace Runlight\Craft;

use yii\caching\CacheInterface;

/**
 * The small values Runlight shares between requests, in Craft's cache: tracker counts per visitor address,
 * hashed with a key that changes daily and kept for two minutes, that key, the site's icon for the
 * dashboard, and a note that a warning was logged today. Nothing goes in a file of Runlight's own.
 *
 * Craft's file cache, its default, keeps an expired entry until it happens to collect it, so the rate
 * limit's values take two entries of fixed names, whatever the address and minute: one holding the current
 * minute's counts, at most a few hundred of them, and one holding the day's key, each replaced when its
 * minute or day is over, and both cleared by the hourly upkeep once they are.
 */
final class Cache implements \Runlight\Cache
{
    /** What the rate limit's keys start with: then the minute and the hashed address, or "key:" and the day. */
    private const RATE = 'runlight:rl:';

    /** The entry holding the current minute's counts. */
    public const COUNTS = 'runlight-rate';

    /** The entry holding the day's key for the counts. */
    public const DAY_KEY = 'runlight-rate-key';

    /** The most addresses counted in one minute; past that, each request counts on its own. */
    private const MOST = 500;

    /** @param (\Closure(): int)|null $now the time in seconds, for tests */
    public function __construct(private readonly CacheInterface $cache, private readonly ?\Closure $now = null)
    {
    }

    /** The entry an ordinary value is kept in. */
    private static function name(string $key): string
    {
        return 'runlight-' . hash('sha256', $key);
    }

    private static function dayKey(string $key): bool
    {
        return str_starts_with($key, self::RATE . 'key:');
    }

    /** An entry, kept with when it runs out, since Craft's cache may hand back one that has. */
    private function read(string $name): mixed
    {
        $kept = $this->cache->get($name);
        return is_array($kept) && isset($kept['until']) && $kept['until'] >= $this->time() ? $kept['value'] ?? null : null;
    }

    private function keep(string $name, mixed $value, int $seconds): void
    {
        $seconds = max(1, $seconds);
        $this->cache->set($name, ['value' => $value, 'until' => $this->time() + $seconds], $seconds);
    }

    private function time(): int
    {
        return $this->now !== null ? ($this->now)() : time();
    }

    public function get(string $key): ?string
    {
        if (self::dayKey($key)) {
            $kept = $this->read(self::DAY_KEY);
            return is_array($kept) && ($kept['key'] ?? null) === $key && is_string($kept['value'] ?? null) ? $kept['value'] : null;
        }
        $value = $this->read(self::name($key));
        return is_string($value) ? $value : null;
    }

    public function set(string $key, string $value, int $seconds): void
    {
        if (self::dayKey($key)) {
            $this->keep(self::DAY_KEY, ['key' => $key, 'value' => $value], $seconds);
            return;
        }
        $this->keep(self::name($key), $value, $seconds);
    }

    public function add(string $key, string $value, int $seconds): bool
    {
        if ($this->get($key) !== null) {
            return false;
        }
        $this->set($key, $value, $seconds);
        return true;
    }

    /**
     * Adds one to a count. The counts for one minute share an entry, and count nearly, as two requests at
     * the same moment may count once between them, which a limit of 120 a minute can bear. A new minute
     * starts it afresh, and past MOST addresses a new one is not counted here.
     */
    public function increment(string $key, int $seconds): ?int
    {
        $split = strrpos($key, ':');
        if ($split === false) {
            return null;
        }
        $window = substr($key, 0, $split);
        $id = substr($key, $split + 1);
        $kept = $this->read(self::COUNTS);
        $counts = is_array($kept) && ($kept['window'] ?? null) === $window && is_array($kept['counts'] ?? null) ? $kept['counts'] : [];
        if (!isset($counts[$id]) && count($counts) >= self::MOST) {
            return null;
        }
        $counts[$id] = (int) ($counts[$id] ?? 0) + 1;
        $this->keep(self::COUNTS, ['window' => $window, 'counts' => $counts], $seconds);
        return $counts[$id];
    }

    /**
     * Deletes the rate limit's entries once their minute or day is over, which the hourly upkeep does, so
     * no hashed address outlives its day wherever the cache keeps an expired entry.
     */
    public function sweep(): void
    {
        if ($this->read(self::COUNTS) === null) {
            $this->cache->delete(self::COUNTS);
        }
        $day = $this->read(self::DAY_KEY);
        if (!is_array($day) || ($day['key'] ?? null) !== self::RATE . 'key:' . intdiv($this->time(), 86400)) {
            $this->cache->delete(self::DAY_KEY);
        }
    }

    /** Deletes the rate limit's entries, for uninstalling. */
    public function clear(): void
    {
        $this->cache->delete(self::COUNTS);
        $this->cache->delete(self::DAY_KEY);
    }
}
