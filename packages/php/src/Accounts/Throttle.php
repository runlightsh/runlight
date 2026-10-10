<?php

declare(strict_types=1);

namespace Runlight\Accounts;

use Runlight\Hash;
use Runlight\Json;
use Runlight\Store\SqlStore;

/**
 * Counts failed sign-ins under a key and refuses more than a few in a while.
 * Keys are hashed with a key made for the day, so the counts never hold an
 * address or an email as it was given.
 *
 * TypeScript keeps the counts in its process. PHP forgets everything between
 * requests, so here they live in the database's settings, as
 * "throttle:<name>:<id>" holding {count, until}, and the hashing key as
 * "throttle-key:<UTC day>". Every process of an install then shares the same
 * counts, and changes them one at a time under the database's lock.
 *
 * Some ids come from an address, so none may last past a day: each UTC day
 * has its own key, keys older than yesterday are deleted, and counts that ran
 * out go when read, when a new count starts, and in the scheduled check. A
 * window that crosses midnight starts again under the new day's key.
 */
final class Throttle
{
    private const KEY = 'throttle-key:';
    /** The one key kept before keys were made each day. */
    private const OLD_KEY = 'throttle-key';

    /** @var \Closure(): int */
    private \Closure $clock;

    /** @param (callable(): int)|null $clock milliseconds since the epoch, for forgive() and clear(), which are given no time */
    public function __construct(
        private readonly SqlStore $store,
        private readonly string $name,
        private readonly int $limit = 10,
        private readonly int $windowMs = 15 * 60_000,
        ?callable $clock = null,
    ) {
        $this->clock = $clock !== null ? \Closure::fromCallable($clock) : static fn (): int => (int) floor(microtime(true) * 1000);
    }

    private static function day(int $now): string
    {
        return gmdate('Y-m-d', intdiv($now, 1000) - ($now < 0 && $now % 1000 !== 0 ? 1 : 0));
    }

    private function salt(int $now): string
    {
        // The settings table first, for an install whose first requests are all sign-ins.
        $this->store->migrate();
        $key = self::KEY . self::day($now);
        $saved = $this->store->setting($key);
        if ($saved !== null && $saved !== '') {
            return $saved;
        }
        // Made in turn, so two processes starting at once settle on one key.
        return $this->turn(function () use ($key, $now): string {
            $saved = $this->store->setting($key);
            if ($saved !== null && $saved !== '') {
                return $saved;
            }
            $made = Hash::randomId(16);
            $this->store->setSetting($key, $made);
            self::sweep($this->store, $now);
            return $made;
        });
    }

    /**
     * Deletes the counts of every throttle that have run out, the hashing keys older than yesterday, and the
     * one key kept before there was one a day, so nothing an id was made from outlasts a day. The scheduled
     * check runs it, and so does the first count of each day.
     */
    public static function sweep(SqlStore $store, int $now): void
    {
        $keep = [self::KEY . self::day($now), self::KEY . self::day($now - 86_400_000)];
        foreach ($store->settingsStartingWith(self::KEY) as ['key' => $key]) {
            if (!in_array($key, $keep, true)) {
                $store->setSetting($key, null);
            }
        }
        if ($store->setting(self::OLD_KEY) !== null) {
            $store->setSetting(self::OLD_KEY, null);
        }
        foreach ($store->settingsStartingWith('throttle:') as ['key' => $key, 'value' => $value]) {
            $entry = Json::tryDecode($value, true);
            if (!is_array($entry) || (int) ($entry['until'] ?? 0) <= $now) {
                $store->setSetting($key, null);
            }
        }
    }

    /**
     * Runs `$fn` holding the database's lock, so a count read and written back by one process cannot interleave
     * with another's, and a burst spread over many PHP workers is counted try by try.
     *
     * @template T
     * @param callable(): T $fn
     * @return T
     */
    private function turn(callable $fn): mixed
    {
        return $this->store->db->exclusive(static fn () => $fn());
    }

    private function id(string $key, int $now): string
    {
        return substr(Crypto::base64url(Crypto::hmac('SHA-256', $this->salt($now), $key)), 0, 22);
    }

    private function prefix(): string
    {
        return "throttle:$this->name:";
    }

    /**
     * A count still running. One that has run out is deleted as it is read.
     *
     * @return array{count: int, until: int}|null
     */
    private function entry(string $id, int $now): ?array
    {
        $saved = $this->store->setting($this->prefix() . $id);
        if ($saved === null) {
            return null;
        }
        $entry = Json::tryDecode($saved, true);
        if (!is_array($entry) || (int) ($entry['until'] ?? 0) <= $now) {
            $this->store->setSetting($this->prefix() . $id, null);
            return null;
        }
        return ['count' => (int) ($entry['count'] ?? 0), 'until' => (int) $entry['until']];
    }

    /** @param array{count: int, until: int} $entry */
    private function save(string $id, array $entry): void
    {
        $this->store->setSetting($this->prefix() . $id, Json::encode($entry));
    }

    public function blocked(string $key, int $now): bool
    {
        return $this->isBlocked($this->id($key, $now), $now);
    }

    private function isBlocked(string $id, int $now): bool
    {
        $entry = $this->entry($id, $now);
        return $entry !== null && $entry['count'] >= $this->limit;
    }

    /**
     * Counts a try before the slow check it guards, so a burst that arrives
     * while earlier tries are still being checked cannot get past the limit.
     * False, counting nothing, when the key is already at its limit. A try
     * that turns out right is taken back with forgive().
     */
    public function take(string $key, int $now): bool
    {
        $id = $this->id($key, $now);
        return $this->turn(function () use ($id, $now): bool {
            if ($this->isBlocked($id, $now)) {
                return false;
            }
            $this->count($id, $now);
            return true;
        });
    }

    /** Takes back one counted try, for one that turned out right. */
    public function forgive(string $key): void
    {
        $now = ($this->clock)();
        $id = $this->id($key, $now);
        $this->turn(function () use ($id, $now): void {
            $entry = $this->entry($id, $now);
            if ($entry !== null && $entry['count'] > 0) {
                $entry['count']--;
                $this->save($id, $entry);
            }
        });
    }

    public function fail(string $key, int $now): void
    {
        $id = $this->id($key, $now);
        $this->turn(fn () => $this->count($id, $now));
    }

    private function count(string $id, int $now): void
    {
        $entry = $this->entry($id, $now);
        if ($entry === null) {
            $this->save($id, ['count' => 1, 'until' => $now + $this->windowMs]);
            $this->prune($now);
            return;
        }
        $entry['count']++;
        $this->save($id, $entry);
    }

    /**
     * Expired entries go first, then the oldest that are not blocked, and blocked ones last, so the counts
     * have a hard ceiling and a flood of made-up names cannot wipe out a real block. Run when a new entry is
     * made, since only then can there be more.
     */
    private function prune(int $now): void
    {
        $entries = [];
        foreach ($this->store->settingsStartingWith($this->prefix()) as ['key' => $key, 'value' => $value]) {
            $entry = Json::tryDecode($value, true);
            $until = is_array($entry) ? (int) ($entry['until'] ?? 0) : 0;
            if ($until <= $now) {
                $this->store->setSetting($key, null);
                continue;
            }
            $entries[] = ['key' => $key, 'until' => $until, 'blocked' => is_array($entry) && (int) ($entry['count'] ?? 0) >= $this->limit];
        }
        $size = count($entries);
        if ($size <= Accounts::MAX_THROTTLED) {
            return;
        }
        // Oldest first: each entry's window started windowMs before its end.
        usort($entries, static fn (array $a, array $b): int => $a['until'] <=> $b['until']);
        foreach ([false, true] as $blocked) {
            foreach ($entries as $entry) {
                if ($size <= Accounts::MAX_THROTTLED) {
                    return;
                }
                if ($entry['blocked'] === $blocked) {
                    $this->store->setSetting($entry['key'], null);
                    $size--;
                }
            }
        }
    }

    public function clear(string $key): void
    {
        $this->store->setSetting($this->prefix() . $this->id($key, ($this->clock)()), null);
    }
}
