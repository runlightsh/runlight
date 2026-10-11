<?php

declare(strict_types=1);

namespace Runlight\Server;

use Runlight\Geo;
use Runlight\Log;

/**
 * Location for servers with no platform headers (Cloudflare, Vercel, and Netlify send their own, and those always
 * win), from DB-IP's free databases (CC BY 4.0, https://db-ip.com). This is the port of the Geo class in
 * packages/server/src/geo.ts, split as PHP needs it: `runlight cron` downloads each month's release with
 * refresh(), and requests read the newest file on disk with lookup(), a page at a time.
 */
final class DbIp
{
    /** @var callable(string, string): bool */
    private $download;
    /** @var callable(string): void */
    private $log;
    private readonly DbIpFiles $files;

    /**
     * @param 'city'|'country' $mode
     * @param (callable(string $url, string $file): bool)|null $download writes the gzipped file at the URL to
     *     the file, and says whether it got one; curl by default
     * @param (callable(string): void)|null $log PHP's error log, through Log, by default
     * @param DbIpFiles|null $files makes the folder, unpacks, opens, moves, and deletes; PHP's own file
     *     functions by default
     */
    public function __construct(
        private readonly string $dir,
        private readonly string $mode,
        ?callable $download = null,
        ?callable $log = null,
        ?DbIpFiles $files = null,
    ) {
        $this->download = $download ?? DbIpDisk::download(...);
        $this->files = $files ?? new DbIpDisk();
        $this->log = $log ?? Log::write(...);
    }

    /** "2026-10", the month DB-IP names each release after. */
    public static function month(int $ms): string
    {
        return gmdate('Y-m', intdiv($ms, 1000));
    }

    private function file(string $release): string
    {
        return "{$this->dir}/dbip-{$this->mode}-lite-{$release}.mmdb";
    }

    /** The newest release on disk, or null before the first download. */
    public function newest(): ?string
    {
        $found = glob("{$this->dir}/dbip-{$this->mode}-lite-*.mmdb") ?: [];
        sort($found);
        return $found === [] ? null : end($found);
    }

    /**
     * A lookup answering from the newest release on disk, opened at the first lookup, or null when there is none
     * yet. Lookups that fail answer nothing, as they do before the first download in TypeScript.
     *
     * @return (\Closure(string): ?array)|null
     */
    public function lookup(): ?\Closure
    {
        $file = $this->newest();
        if ($file === null) {
            return null;
        }
        $lookup = null;
        $files = $this->files;
        return static function (string $ip) use ($file, $files, &$lookup): ?array {
            try {
                $lookup ??= Geo::lookupFrom($files->open($file));
            } catch (\Throwable) {
                return null;
            }
            return $lookup($ip);
        };
    }

    /**
     * Fetches this month's release when it is missing. A new month's file appears a day or so after the month
     * starts, so until then last month's is fetched when that is missing too. Older releases go once a new
     * one is ready. Safe to call often: once this month's file is there it reads only the folder.
     */
    public function refresh(int $now): void
    {
        $current = self::month($now);
        if (is_file($this->file($current))) {
            return;
        }
        // DB-IP sends its releases gzipped, so without zlib a download could never be used.
        if (!self::canUnpack()) {
            ($this->log)("Runlight: location data from DB-IP needs PHP's zlib extension to unpack. Turn zlib on, or set RUNLIGHT_GEO to off or to the path of an MMDB file.");
            return;
        }
        if (!$this->files->folder($this->dir)) {
            ($this->log)("Runlight: could not make the folder for location data, {$this->dir}");
            return;
        }
        $seconds = intdiv($now, 1000);
        $previous = self::month((int) gmmktime(0, 0, 0, (int) gmdate('n', $seconds) - 1, 15, (int) gmdate('Y', $seconds)) * 1000);
        foreach ([$current, $previous] as $release) {
            if (is_file($this->file($release))) {
                return;
            }
            $url = "https://download.db-ip.com/free/dbip-{$this->mode}-lite-{$release}.mmdb.gz";
            $gz = $this->file($release) . '.gz.partial';
            $partial = $this->file($release) . '.partial';
            try {
                if (!($this->download)($url, $gz)) {
                    continue;
                }
                if (!self::canUnpack()) {
                    throw new \RuntimeException("could not unpack $gz: PHP's zlib extension is not loaded");
                }
                $this->files->gunzip($gz, $partial);
                // A file that does not open as a database is never kept.
                $this->files->open($partial);
                $this->files->move($partial, $this->file($release));
                foreach (glob("{$this->dir}/dbip-{$this->mode}-lite-*") ?: [] as $old) {
                    if ($old !== $this->file($release)) {
                        $this->files->delete($old);
                    }
                }
                ($this->log)("Runlight: location data from DB-IP ($release) is ready.");
                return;
            } catch (\Throwable $error) {
                ($this->log)("Runlight: could not download location data from $url: {$error->getMessage()}");
            } finally {
                $this->files->delete($gz);
                $this->files->delete($partial);
            }
        }
    }

    private static function canUnpack(): bool
    {
        return function_exists('gzopen');
    }
}
