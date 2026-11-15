<?php

declare(strict_types=1);

namespace Runlight\Accounts;

use Runlight\Hash;
use Runlight\Json;
use Runlight\Store\SqlStore;

/**
 * Counts wrong second-factor codes under a key and locks it for longer each time the tries run out: five
 * tries, then fifteen minutes, then thirty, then an hour, doubling up to a day. A right code clears the
 * key, and so does a week with no lock and no try. A lock always ends, at most a day later, so nobody is
 * shut out for good.
 *
 * TypeScript keeps the counts in its process. PHP forgets everything between requests, so here they live in
 * the database's settings, as "lockout:<name>:<id>" holding {count, until, locks, forget}, changed one at a
 * time under the database's lock. A key is an account's id, never an address, and is hashed with a key of
 * the install's own, so a count may last the week its forgetting takes.
 */
final class Lockout
{
    private const KEY = 'lockout-key';

    public function __construct(
        private readonly SqlStore $store,
        private readonly string $name,
        private readonly int $limit = 5,
        private readonly int $windowMs = 15 * 60_000,
        private readonly int $longestMs = 86_400_000,
        private readonly int $forgetMs = 7 * 86_400_000,
    ) {
    }

    private function id(string $key): string
    {
        // The settings table first, for an install whose first requests are all sign-ins.
        $this->store->migrate();
        $salt = $this->store->settingOrAdd(self::KEY, static fn (): string => Hash::randomId(16));
        return "lockout:$this->name:" . substr(Crypto::base64url(Crypto::hmac('SHA-256', $salt, $key)), 0, 22);
    }

    /**
     * Counts a try before the code is checked, so a burst cannot get past the limit. False, counting
     * nothing, while the key is locked. The try that uses up the last one starts the lock.
     */
    public function take(string $key, int $now): bool
    {
        $id = $this->id($key);
        return $this->store->db->exclusive(function () use ($id, $now): bool {
            $saved = $this->store->setting($id);
            $entry = $saved === null ? null : Json::tryDecode($saved, true);
            if (!is_array($entry) || (int) ($entry['forget'] ?? 0) <= $now) {
                $entry = null;
            }
            if ($entry !== null && (int) $entry['count'] >= $this->limit && (int) $entry['until'] > $now) {
                return false;
            }
            if ($entry === null) {
                $entry = ['count' => 0, 'until' => $now + $this->windowMs, 'locks' => 0, 'forget' => 0];
            } elseif ((int) $entry['until'] <= $now) {
                $entry['count'] = 0;
                $entry['until'] = $now + $this->windowMs;
            }
            $entry['count'] = (int) $entry['count'] + 1;
            if ($entry['count'] >= $this->limit) {
                $locks = (int) $entry['locks'];
                // Past a day's worth of doubling the lock is a day, however many times it has locked.
                $entry['until'] = $now + ($locks >= 20 ? $this->longestMs : min($this->windowMs * 2 ** $locks, $this->longestMs));
                $entry['locks'] = $locks + 1;
            }
            $entry['forget'] = (int) $entry['until'] + $this->forgetMs;
            $this->store->setSetting($id, Json::encode(['count' => $entry['count'], 'until' => (int) $entry['until'], 'locks' => (int) $entry['locks'], 'forget' => $entry['forget']]));
            return true;
        });
    }

    /** Forgets a key, for a code that turned out right. */
    public function clear(string $key): void
    {
        $this->store->setSetting($this->id($key), null);
    }

    /** Deletes every count long forgotten. The scheduled check runs it, and requests do now and then. */
    public static function sweep(SqlStore $store, int $now): void
    {
        foreach ($store->settingsStartingWith('lockout:') as ['key' => $key, 'value' => $value]) {
            $entry = Json::tryDecode($value, true);
            if (!is_array($entry) || (int) ($entry['forget'] ?? 0) <= $now) {
                $store->setSetting($key, null);
            }
        }
    }
}
