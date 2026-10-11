<?php

declare(strict_types=1);

namespace Runlight;

/**
 * Folders for the small files PHP shares between requests: rate counts and their key, cached icons, and the
 * slots password checks take turns in. They go in the folder a server names for its own data, else in the
 * system's temporary folder, which other users of the machine can write to as well. So a folder is used only
 * when it is a real folder (not a link), belongs to this process's user, and is open to that user alone;
 * otherwise the caller gets null and does without.
 *
 * Every file Runlight shares this way is read and written here, so an app that passes a Cache of its own
 * never loads this class.
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
     * Adds one to `$id`'s count in a file of counts, under a lock so requests at once each count: the new count,
     * or null when the file cannot be opened.
     */
    public static function count(string $file, string $id): ?int
    {
        $handle = @fopen($file, 'c+');
        if ($handle === false) {
            return null;
        }
        try {
            self::protect($file);
            flock($handle, LOCK_EX);
            $counts = json_decode((string) stream_get_contents($handle), true);
            $counts = is_array($counts) ? $counts : [];
            $counts[$id] = (int) ($counts[$id] ?? 0) + 1;
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, (string) json_encode($counts));
            fflush($handle);
            flock($handle, LOCK_UN);
        } finally {
            fclose($handle);
        }
        return $counts[$id];
    }

    /**
     * The 16 byte key kept in a file, written as `$made` when the file has none yet, or null when the file
     * cannot be opened.
     */
    public static function keep(string $file, string $made): ?string
    {
        $handle = @fopen($file, 'c+');
        if ($handle === false) {
            return null;
        }
        try {
            // Readable by the owner alone before anything is in it, and written under a lock so two first
            // requests agree.
            self::protect($file);
            flock($handle, LOCK_EX);
            $stored = (string) stream_get_contents($handle);
            if (strlen($stored) !== 16) {
                ftruncate($handle, 0);
                rewind($handle);
                fwrite($handle, $made);
                fflush($handle);
                $stored = $made;
            }
            flock($handle, LOCK_UN);
        } finally {
            fclose($handle);
        }
        return $stored;
    }

    /**
     * True the first time in `$seconds` that this is asked of a marker file, which it then touches, so
     * something happens at most once in that time across requests.
     */
    public static function mark(string $file, int $seconds): bool
    {
        $at = @filemtime($file);
        if ($at !== false && $at > time() - $seconds) {
            return false;
        }
        @touch($file);
        return true;
    }

    public static function delete(string $file): void
    {
        @unlink($file);
    }

    /** Deletes the oldest of the files matching `$pattern` past the newest `$keep`. */
    public static function prune(string $pattern, int $keep): void
    {
        $files = glob($pattern) ?: [];
        if (count($files) > $keep) {
            usort($files, static fn ($a, $b) => (@filemtime($a) ?: 0) <=> (@filemtime($b) ?: 0));
            foreach (array_slice($files, 0, count($files) - $keep) as $old) {
                @unlink($old);
            }
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
