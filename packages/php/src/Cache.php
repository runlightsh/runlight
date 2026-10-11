<?php

declare(strict_types=1);

namespace Runlight;

/**
 * Somewhere for the small values PHP shares between requests: rate counts and the day's key they are hashed
 * with, cached site icons, and the once-a-day proxy warning. Without one, Runlight keeps them in APCu when it is
 * loaded, or else in files (see Scratch). An app with a cache of its own, such as a CMS's, passes one as the
 * `cache` option, and then Runlight uses only that. Values are byte strings, and each one expires after the
 * seconds it is kept for.
 */
interface Cache
{
    /** The value at `$key`, or null when there is none. */
    public function get(string $key): ?string;

    /** Keeps `$value` at `$key` for `$seconds`. */
    public function set(string $key, string $value, int $seconds): void;

    /** Keeps `$value` at `$key` for `$seconds` only when nothing is there yet, and says whether it did. */
    public function add(string $key, string $value, int $seconds): bool;

    /** Adds one to the count at `$key`, which starts at nothing and lasts `$seconds`: the new count, or null when it cannot count. */
    public function increment(string $key, int $seconds): ?int;
}
