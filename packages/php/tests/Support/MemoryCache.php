<?php

declare(strict_types=1);

namespace Runlight\Tests\Support;

use Runlight\Cache;

/** A Cache in memory, as an app's own would be, that ignores expiry and records what is kept. */
final class MemoryCache implements Cache
{
    /** @var array<string, string> */
    public array $values = [];

    public function get(string $key): ?string
    {
        return $this->values[$key] ?? null;
    }

    public function set(string $key, string $value, int $seconds): void
    {
        $this->values[$key] = $value;
    }

    public function add(string $key, string $value, int $seconds): bool
    {
        if (isset($this->values[$key])) {
            return false;
        }
        $this->values[$key] = $value;
        return true;
    }

    public function increment(string $key, int $seconds): ?int
    {
        $this->values[$key] = (string) ((int) ($this->values[$key] ?? 0) + 1);
        return (int) $this->values[$key];
    }
}
