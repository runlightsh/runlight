<?php

declare(strict_types=1);

namespace Runlight\Server;

use Runlight\Geo;
use Runlight\Http\BodyTooLong;
use Runlight\Http\CurlFetcher;
use Runlight\Http\Fetcher;
use Runlight\Mmdb;
use Runlight\Log;

/**
 * Location for servers with no platform headers (Cloudflare, Vercel, and Netlify send their own, and those always
 * win), from DB-IP's free databases (CC BY 4.0, https://db-ip.com). This is the port of the Geo class in
 * packages/server/src/geo.ts, split as PHP needs it: `runlight cron` downloads each month's release with
 * refresh(), and requests read the newest file on disk with lookup(), a page at a time.
 *
 * A download is used only once it is checked: its SHA-1 against the one DB-IP publishes on its download page,
 * and the file itself as a DB-IP database of the kind asked for, no older than the one in use. That catches a
 * damaged or swapped file, and a download server serving something else. It is not a signature: DB-IP
 * publishes none, so whoever can change DB-IP's own page can change both. A checksum that does not match
 * always refuses the download. Only when none can be read at all (the page is down, or no longer reads as it
 * did) is a download accepted on the other checks alone, with a warning, so a change to that page does not
 * stop location data everywhere.
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
     *     the file and gives true; gives false for a 404 and nothing else; throws, with the reason as its
     *     message, for any other answer but a 200 (a redirect is never followed), a file over MOST_PACKED_BYTES,
     *     or ten minutes gone; curl by default
     * @param (callable(string): void)|null $log PHP's error log, through Log, by default
     * @param Fetcher|null $pages fetches DB-IP's download page, where its checksums are: asked with redirect
     *     "manual", maxBytes, and timeoutMs, and must hand a redirect back unfollowed; curl by default
     * @param DbIpFiles|null $files makes the folder, unpacks, opens, moves, and deletes; PHP's own file
     *     functions by default
     */
    public function __construct(
        private readonly string $dir,
        private readonly string $mode,
        ?callable $download = null,
        ?callable $log = null,
        ?DbIpFiles $files = null,
        private readonly ?Fetcher $pages = null,
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
        // While the month's file is not published yet, or a download keeps failing, each try waits twice as long
        // as the last, from five minutes up to six hours, so neither DB-IP nor the disk is asked for the whole
        // file every few minutes. PHP keeps nothing between runs, so the wait is kept in a file beside the data.
        $waiting = $this->waiting();
        if ($now < $waiting['retryAt']) {
            return;
        }
        try {
            $this->fetch($current, $now);
        } finally {
            if (is_file($this->file($current))) {
                @unlink($this->waitFile());
            } elseif (is_dir($this->dir)) {
                $wait = min($waiting['wait'] > 0 ? $waiting['wait'] * 2 : self::FIRST_WAIT, self::LONGEST_WAIT);
                @file_put_contents($this->waitFile(), (string) json_encode(['wait' => $wait, 'retryAt' => $now + $wait]), LOCK_EX);
            }
        }
    }

    /** How long after a first failed try the next one waits, and the longest any waits. */
    private const FIRST_WAIT = 5 * 60_000;
    private const LONGEST_WAIT = 6 * 3_600_000;

    private function waitFile(): string
    {
        return "{$this->dir}/retry-{$this->mode}.json";
    }

    /** @return array{wait: int, retryAt: int} */
    private function waiting(): array
    {
        $text = @file_get_contents($this->waitFile());
        $saved = is_string($text) ? json_decode($text, true) : null;
        return ['wait' => (int) ($saved['wait'] ?? 0), 'retryAt' => (int) ($saved['retryAt'] ?? 0)];
    }

    /** The most a database may unpack to, several times the city file's size, so a bad download cannot fill the disk. */
    public const MOST_BYTES = 512 * 1024 * 1024;
    /** The most the download itself may weigh, and the least a database unpacks to (the country one is 8 MB). */
    public const MOST_PACKED_BYTES = 256 * 1024 * 1024;
    public const FEWEST_BYTES = 1024 * 1024;
    /** The most of DB-IP's download page that is read; it is about 25 KB. */
    public const MOST_PAGE_BYTES = 1024 * 1024;
    private const DAY = 86_400_000;
    /** A release is built at the start of its month and stands in until the next appears, so one is two months old at most. */
    private const OLDEST_BUILD = 100 * self::DAY;
    /** Addresses any location database knows: Google's and Cloudflare's resolvers, over IPv4 and IPv6. */
    private const KNOWN = ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888'];

    /**
     * The release and SHA-1 on DB-IP's download page for the MMDB file of one kind: the last SHA1SUM before the
     * link to that file, and after the link to any other. Null when the page does not read that way.
     *
     * @return array{release: string, sha1: string}|null
     */
    public static function publishedChecksum(string $page, string $mode): ?array
    {
        if (!preg_match('~download\.db-ip\.com/free/dbip-' . preg_quote($mode, '~') . '-lite-(\d{4}-\d{2})\.mmdb\.gz~', $page, $link, PREG_OFFSET_CAPTURE)) {
            return null;
        }
        $before = substr($page, 0, $link[0][1]);
        $other = strrpos($before, 'download.db-ip.com/free/dbip-');
        $card = $other === false ? $before : substr($before, $other);
        if (!preg_match_all('/SHA1SUM[\s\S]{0,200}?\b([0-9a-f]{40})\b/i', $card, $sums) || $sums[1] === []) {
            return null;
        }
        return ['release' => $link[1][0], 'sha1' => strtolower((string) end($sums[1]))];
    }

    /**
     * The release DB-IP's download page offers for this kind of database, and the SHA-1 it gives for the unpacked
     * file. The page is asked for as it is: no redirect is followed, and only a 200 counts.
     *
     * @return array{release: string, sha1: string}
     */
    private function published(): array
    {
        $url = "https://db-ip.com/db/download/ip-to-{$this->mode}-lite";
        try {
            $answer = ($this->pages ?? new CurlFetcher())->fetch($url, [
                'redirect' => 'manual',
                'maxBytes' => self::MOST_PAGE_BYTES,
                'timeoutMs' => 30_000,
                'headers' => ['accept' => 'text/html', 'user-agent' => 'Runlight (+https://runlight.sh)'],
            ]);
            if ($answer->status !== 200) {
                throw new \RuntimeException("it answered {$answer->status}");
            }
            $page = $answer->text();
            if (strlen($page) > self::MOST_PAGE_BYTES) {
                throw new \RuntimeException('it is more than ' . intdiv(self::MOST_PAGE_BYTES, 1024) . ' KB');
            }
        } catch (\Throwable $error) {
            $why = $error instanceof BodyTooLong ? 'it is more than ' . intdiv(self::MOST_PAGE_BYTES, 1024) . ' KB' : $error->getMessage();
            throw new \RuntimeException("could not read DB-IP's checksums at $url: $why");
        }
        $found = self::publishedChecksum($page, $this->mode);
        if ($found === null) {
            throw new \RuntimeException("found no checksum for the {$this->mode} database at $url");
        }
        return $found;
    }

    /** When the database in use was built, in milliseconds, or 0 when there is none that opens. */
    private function inUse(): int
    {
        $file = $this->newest();
        if ($file === null) {
            return 0;
        }
        try {
            return (int) ($this->files->open($file)->metadata['build_epoch'] ?? 0) * 1000;
        } catch (\Throwable) {
            return 0;
        }
    }

    /**
     * Throws unless `$db` is a DB-IP database of the kind asked for that a lookup can be made in: of a
     * believable size, its search tree inside the file, built lately and not before the one in use (`$inUse`, a
     * time, or 0 for none), and answering for addresses everyone knows.
     */
    public static function checkDatabase(Mmdb $db, string $mode, int $now, int $inUse = 0): void
    {
        if ($db->size < self::FEWEST_BYTES) {
            throw new \RuntimeException("it unpacks to {$db->size} bytes, too few for a location database");
        }
        $meta = $db->metadata;
        $major = $meta['binary_format_major_version'] ?? null;
        if ($major !== 2) {
            throw new \RuntimeException('its format is version ' . (is_scalar($major) ? (string) $major : 'unknown') . ', not 2');
        }
        $type = is_string($meta['database_type'] ?? null) ? $meta['database_type'] : '';
        if (strtolower($type) !== "dbip-$mode-lite") {
            throw new \RuntimeException("it is a \"$type\" database, not DB-IP's $mode one");
        }
        if (($meta['ip_version'] ?? null) !== 6) {
            throw new \RuntimeException('it covers IP version ' . (is_scalar($meta['ip_version'] ?? null) ? (string) $meta['ip_version'] : 'unknown') . ', not 6');
        }
        $recordSize = (int) ($meta['record_size'] ?? 0);
        if (!in_array($recordSize, [24, 28, 32], true)) {
            throw new \RuntimeException("its records are $recordSize bits");
        }
        $nodes = (int) ($meta['node_count'] ?? 0);
        if (!($nodes > 0) || $nodes * $recordSize / 4 + 16 > $db->markerAt) {
            throw new \RuntimeException('its search tree does not fit in the file');
        }
        $epoch = $meta['build_epoch'] ?? null;
        $built = is_int($epoch) ? $epoch * 1000 : null;
        if ($built === null || !($built <= $now + 2 * self::DAY) || $built < $now - self::OLDEST_BUILD) {
            throw new \RuntimeException('it was built on ' . ($built === null ? 'no date' : gmdate('Y-m-d', intdiv($built, 1000))));
        }
        if ($built < $inUse) {
            throw new \RuntimeException('it is older than the database in use');
        }
        foreach (self::KNOWN as $ip) {
            try {
                $found = $db->get($ip);
            } catch (\Throwable) {
                $found = null;
            }
            $country = is_array($found) && is_array($found['country'] ?? null) ? ($found['country']['iso_code'] ?? '') : '';
            if (!is_string($country) || !preg_match('/^[A-Z]{2}$/D', $country)) {
                throw new \RuntimeException("it has no country for $ip");
            }
        }
    }

    /** Opens an unpacked download and holds it to checkDatabase(). */
    private function check(string $partial, int $now, int $inUse): void
    {
        // Its size first, where the file can be asked: too small a file is said to be that, whatever else it is.
        $size = @filesize($partial);
        if (is_int($size) && $size < self::FEWEST_BYTES) {
            throw new \RuntimeException("it unpacks to $size bytes, too few for a location database");
        }
        try {
            $db = $this->files->open($partial);
        } catch (\Throwable $error) {
            throw new \RuntimeException(str_contains($error->getMessage(), 'no metadata') ? 'it is not an MMDB file' : "it does not open as an MMDB file: {$error->getMessage()}");
        }
        self::checkDatabase($db, $this->mode, $now, $inUse);
    }

    private function fetch(string $current, int $now): void
    {
        // DB-IP sends its releases gzipped, so without zlib a download could never be used.
        if (!self::canUnpack()) {
            ($this->log)("Runlight: location data from DB-IP needs PHP's zlib extension to unpack. Turn zlib on, or set RUNLIGHT_GEO to off or to the path of an MMDB file.");
            return;
        }
        if (!$this->files->folder($this->dir)) {
            ($this->log)("Runlight: could not make the folder for location data, {$this->dir}");
            return;
        }
        // A new month's file appears a day or so after the month starts; until then, last month's is current.
        $seconds = intdiv($now, 1000);
        $tries = [$current, self::month((int) gmmktime(0, 0, 0, (int) gmdate('n', $seconds) - 1, 15, (int) gmdate('Y', $seconds)) * 1000)];
        // The page says which release there is and what it must hash to, so only that file is asked for. When the
        // page cannot be read, the newest release there is goes unchecked against it, and the log says so.
        $published = null;
        $unchecked = '';
        try {
            $published = $this->published();
        } catch (\Throwable $error) {
            $unchecked = $error->getMessage();
        }
        if ($published !== null && !in_array($published['release'], $tries, true)) {
            ($this->log)("Runlight: location data was not updated: DB-IP offers the {$published['release']} release, which is neither this month's nor last month's");
            return;
        }
        $inUse = $this->inUse();
        foreach ($published !== null ? [$published['release']] : $tries as $name) {
            if (is_file($this->file($name))) {
                return;
            }
            $url = "https://download.db-ip.com/free/dbip-{$this->mode}-lite-{$name}.mmdb.gz";
            $gz = $this->file($name) . '.gz.partial';
            $partial = $this->file($name) . '.partial';
            try {
                // False is a 404: without the page to say which release there is, this month's not being out yet is no failure.
                if (!($this->download)($url, $gz)) {
                    if ($published === null) {
                        continue;
                    }
                    throw new \RuntimeException('it answered 404');
                }
                $packed = @filesize($gz);
                if (is_int($packed) && $packed > self::MOST_PACKED_BYTES) {
                    throw new \RuntimeException('the download is more than ' . intdiv(self::MOST_PACKED_BYTES, 1024 * 1024) . ' MB');
                }
                $got = $this->files->gunzip($gz, $partial, self::MOST_BYTES);
                if ($published !== null && $got !== $published['sha1']) {
                    throw new \RuntimeException("its SHA-1 is $got, and DB-IP publishes {$published['sha1']}");
                }
                $this->check($partial, $now, $inUse);
                $this->files->move($partial, $this->file($name));
                // Older releases go once the new one is in place.
                foreach (glob("{$this->dir}/dbip-{$this->mode}-lite-*") ?: [] as $old) {
                    if ($old !== $this->file($name)) {
                        $this->files->delete($old);
                    }
                }
                if ($published === null) {
                    ($this->log)("Runlight: warning: location data from DB-IP ($name) could not be checked against DB-IP's published checksum ($unchecked). It was accepted as a DB-IP database of the right kind, without that check.");
                }
                ($this->log)("Runlight: location data from DB-IP ($name) is ready.");
                return;
            } catch (\Throwable $error) {
                // Whatever went wrong, the database in use stays in use.
                ($this->log)("Runlight: location data was not updated from $url: {$error->getMessage()}");
            } finally {
                $this->files->delete($gz);
                $this->files->delete($partial);
            }
        }
        if ($published === null) {
            ($this->log)("Runlight: location data was not updated: $unchecked, and no release could be downloaded without them");
        }
    }

    private static function canUnpack(): bool
    {
        return function_exists('inflate_init');
    }
}
