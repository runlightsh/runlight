<?php

declare(strict_types=1);

namespace Runlight;

/**
 * Folders for the small files PHP shares between requests: rate counts and their key, cached icons, and the
 * slots password checks take turns in. They go in the folder a server names for its own data, else in the
 * system's temporary folder, which other users of the machine can write to as well. So a folder is used only
 * when it is a real folder (not a link), belongs to this process's user, and is open to that user alone;
 * otherwise the caller gets null and does without.
 */
final class Scratch
{
    private static int|false|null $uid = null;

    /**
     * The folder `$name` inside `$base` (default the system's temporary folder), made 0700 if it is not there,
     * or null when it cannot be used safely. In the shared temporary folder the name carries the user's id, so
     * another user cannot take it first.
     */
    public static function dir(string $name, ?string $base = null): ?string
    {
        $uid = self::uid();
        if ($base === null || $base === '') {
            $base = sys_get_temp_dir();
            if ($uid !== false) {
                $name .= "-$uid";
            }
        }
        $dir = rtrim($base, '/\\') . '/' . $name;
        if (!is_link($dir) && !is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
        clearstatcache(true, $dir);
        if (is_link($dir) || !is_dir($dir)) {
            return null;
        }
        if ($uid !== false && @fileowner($dir) !== $uid) {
            return null;
        }
        if (DIRECTORY_SEPARATOR === '/' && ((int) @fileperms($dir) & 0o077) !== 0 && !@chmod($dir, 0700)) {
            return null;
        }
        return $dir;
    }

    /** Makes a file in one of these folders readable and writable by its owner alone. */
    public static function protect(string $file): void
    {
        if (DIRECTORY_SEPARATOR === '/') {
            @chmod($file, 0600);
        }
    }

    /**
     * The id of the user this process runs as, or false where that cannot be known. Without the posix
     * extension it is the owner of a file this process makes, since getmyuid() names the script's owner,
     * who is often not the user PHP runs as.
     */
    private static function uid(): int|false
    {
        if (self::$uid !== null) {
            return self::$uid;
        }
        if (function_exists('posix_geteuid')) {
            return self::$uid = posix_geteuid();
        }
        $probe = @tempnam(sys_get_temp_dir(), 'rl');
        if ($probe === false) {
            return self::$uid = false;
        }
        $owner = @fileowner($probe);
        @unlink($probe);
        return self::$uid = $owner;
    }
}
