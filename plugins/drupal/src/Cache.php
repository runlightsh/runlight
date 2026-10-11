<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Core\Cache\CacheBackendInterface;
use Runlight\Cache as RunlightCache;

/**
 * The small values Runlight shares between requests, in Drupal's cache.
 *
 * These are tracker counts per visitor address, hashed with a key that
 * changes daily and kept for two minutes, that key, the site's icon for the
 * dashboard, and a note that a warning was logged today. Nothing goes in a
 * file.
 *
 * Drupal's database cache keeps an expired item until cron collects it, so
 * the rate limit's values take two items of fixed names, whatever the address
 * and minute: one holding the current minute's counts, at most a few hundred
 * of them, and one holding the day's key, each replaced when its minute or day
 * is over, and both cleared by the hourly check once they are.
 */
final class Cache implements RunlightCache {

  /**
   * The cache tag on every item, which uninstalling clears.
   */
  public const TAG = 'runlight';

  /**
   * What the rate limit's keys start with.
   *
   * Then the minute and the hashed address, or "key:" and the day.
   */
  private const RATE = 'runlight:rl:';

  /**
   * The item holding the current minute's counts.
   */
  public const COUNTS = 'runlight:rate';

  /**
   * The item holding the day's key for the counts.
   */
  public const DAY_KEY = 'runlight:rate_key';

  /**
   * The most addresses counted in one minute.
   *
   * Past that, each request counts on its own.
   */
  private const MOST = 500;

  public function __construct(
    private readonly CacheBackendInterface $backend,
    private readonly TimeInterface $time,
  ) {}

  /**
   * The item an ordinary value is kept in.
   */
  private static function cid(string $key): string {
    return 'runlight:' . hash('sha256', $key);
  }

  /**
   * Whether a key is the day's key for the rate counts.
   */
  private static function dayKey(string $key): bool {
    return str_starts_with($key, self::RATE . 'key:');
  }

  /**
   * An item's data, or NULL when there is none.
   */
  private function data(string $cid): mixed {
    $item = $this->backend->get($cid);
    return $item === FALSE ? NULL : $item->data;
  }

  /**
   * Keeps an item for a number of seconds.
   */
  private function keep(string $cid, mixed $data, int $seconds): void {
    $this->backend->set($cid, $data, $this->time->getCurrentTime() + max(1, $seconds), [self::TAG]);
  }

  /**
   * {@inheritdoc}
   */
  public function get(string $key): ?string {
    if (self::dayKey($key)) {
      $kept = $this->data(self::DAY_KEY);
      return is_array($kept) && ($kept['key'] ?? NULL) === $key && is_string($kept['value'] ?? NULL) ? $kept['value'] : NULL;
    }
    $value = $this->data(self::cid($key));
    return is_string($value) ? $value : NULL;
  }

  /**
   * {@inheritdoc}
   */
  public function set(string $key, string $value, int $seconds): void {
    if (self::dayKey($key)) {
      $this->keep(self::DAY_KEY, ['key' => $key, 'value' => $value], $seconds);
      return;
    }
    $this->keep(self::cid($key), $value, $seconds);
  }

  /**
   * {@inheritdoc}
   */
  public function add(string $key, string $value, int $seconds): bool {
    if ($this->get($key) !== NULL) {
      return FALSE;
    }
    $this->set($key, $value, $seconds);
    return TRUE;
  }

  /**
   * {@inheritdoc}
   *
   * The counts for one minute share an item, and count nearly, as two
   * requests at the same moment may count once between them, which a limit
   * of 120 a minute can bear. A new minute starts it afresh, and past MOST
   * addresses a new one is not counted here.
   */
  public function increment(string $key, int $seconds): ?int {
    $split = strrpos($key, ':');
    if ($split === FALSE) {
      return NULL;
    }
    $window = substr($key, 0, $split);
    $id = substr($key, $split + 1);
    $kept = $this->data(self::COUNTS);
    $counts = is_array($kept) && ($kept['window'] ?? NULL) === $window && is_array($kept['counts'] ?? NULL) ? $kept['counts'] : [];
    if (!isset($counts[$id]) && count($counts) >= self::MOST) {
      return NULL;
    }
    $counts[$id] = (int) ($counts[$id] ?? 0) + 1;
    $this->keep(self::COUNTS, ['window' => $window, 'counts' => $counts], $seconds);
    return $counts[$id];
  }

  /**
   * Deletes the rate limit's items once their minute or day is over.
   *
   * The hourly check does this, so no hashed address outlives its day, even
   * where nothing else collects expired items.
   */
  public function sweep(): void {
    $day = intdiv($this->time->getCurrentTime(), 86400);
    foreach ([self::COUNTS, self::DAY_KEY] as $cid) {
      $item = $this->backend->get($cid, TRUE);
      if ($item === FALSE) {
        continue;
      }
      $old = $cid === self::DAY_KEY && is_array($item->data) && ($item->data['key'] ?? NULL) !== self::RATE . 'key:' . $day;
      if (!$item->valid || $item->expire < $this->time->getCurrentTime() || $old) {
        $this->backend->delete($cid);
      }
    }
  }

  /**
   * Deletes the rate limit's items, for uninstalling.
   */
  public function clear(): void {
    $this->backend->deleteMultiple([self::COUNTS, self::DAY_KEY]);
  }

}
