<?php

declare(strict_types=1);

namespace Runlight\Tests\Server;

use PHPUnit\Framework\TestCase;
use Runlight\Http\BodyTooLong;
use Runlight\Http\Response;
use Runlight\Mmdb;
use Runlight\Server\DbIp;
use Runlight\Server\DbIpDisk;
use Runlight\Tests\Support\FakeFetcher;

/**
 * What a download from DB-IP must pass before it is used, as packages/server/test/geo.test.ts checks the Node
 * server's: the checksum DB-IP publishes, and the file itself as a DB-IP database of the kind asked for.
 * Nothing here reaches the network: the page comes from a fake Fetcher and the files from a fake download.
 */
final class DbIpTest extends TestCase
{
    private const PAGE = 'https://db-ip.com/db/download/ip-to-city-lite';
    /** Date.UTC(2026, 9, 3, 3). */
    private const OCTOBER = 1_790_996_400_000;
    private const MIN = 60_000;

    private string $root = '';

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/runlight-dbip-' . bin2hex(random_bytes(6));
        mkdir($this->root);
    }

    protected function tearDown(): void
    {
        foreach (glob("{$this->root}/*/*") ?: [] as $file) {
            unlink($file);
        }
        foreach (glob("{$this->root}/*") ?: [] as $dir) {
            rmdir($dir);
        }
        rmdir($this->root);
    }

    private static function file(string $release): string
    {
        return "https://download.db-ip.com/free/dbip-city-lite-$release.mmdb.gz";
    }

    /** MMDB's data format, enough of it to write a database: maps, strings, arrays, and unsigned integers. */
    private static function encode(mixed $value): string
    {
        $control = static function (int $type, int $size): string {
            if ($type >= 8) {
                return chr($size) . chr($type - 7);
            }
            return $size < 29 ? chr(($type << 5) | $size) : chr(($type << 5) | 29) . chr($size - 29);
        };
        if (is_string($value)) {
            return $control(2, strlen($value)) . $value;
        }
        if (is_int($value)) {
            $bytes = $value < 0x10000 ? 2 : ($value < 0x100000000 ? 4 : 8);
            return $control($bytes === 2 ? 5 : ($bytes === 4 ? 6 : 9), $bytes) . substr(pack('J', $value), 8 - $bytes);
        }
        if (array_is_list($value)) {
            return $control(11, count($value)) . implode('', array_map(self::encode(...), $value));
        }
        $out = $control(7, count($value));
        foreach ($value as $k => $v) {
            $out .= self::encode((string) $k) . self::encode($v);
        }
        return $out;
    }

    private const RECORD = ['country' => ['iso_code' => 'US', 'names' => ['en' => 'United States']], 'city' => ['names' => ['en' => 'Mountain View']]];

    /**
     * A whole MMDB file of one megabyte or so, in which every address has the same record. `$meta` overrides
     * the metadata, and `$record` the record (null leaves every address without one).
     *
     * @param array<string, mixed> $meta
     */
    public static function mmdb(array $meta = [], ?array $record = self::RECORD, int $pad = 1024 * 1024): string
    {
        // One node whose two records both point at the first thing in the data section, or at "no data".
        $pointer = chr($record === null ? 1 : 1 + 16);
        $node = "\0\0$pointer\0\0$pointer";
        $metadata = self::encode($meta + [
            'binary_format_major_version' => 2,
            'binary_format_minor_version' => 0,
            'build_epoch' => 1_790_820_000, // Date.UTC(2026, 9, 1, 2) / 1000
            'database_type' => 'DBIP-City-Lite',
            'description' => ['en' => 'A test database'],
            'ip_version' => 6,
            'languages' => ['en'],
            'node_count' => 1,
            'record_size' => 24,
        ]);
        return $node . str_repeat("\0", 16) . self::encode($record ?? ['none' => 'x']) . str_repeat("\0", $pad) . "\xab\xcd\xefMaxMind.com" . $metadata;
    }

    /** DB-IP's download page as it reads, with the CSV file's card before the MMDB file's. */
    private static function page(string $mode, string $release, string $sum): string
    {
        return "<div class=\"card\"><dl class=\"card-body\"><dt>Format</dt><dd>CSV</dd><dt>MD5SUM</dt>\n"
            . "<dd class=\"small\">93c945395f0bc2ceefea7dd55750417a</dd><dt>SHA1SUM</dt><dd class=\"small\">e2061015c43ec91c94a12191a6a613279eb94c0c</dd></dl>\n"
            . "<a href='https://download.db-ip.com/free/dbip-$mode-lite-$release.csv.gz' class='btn'>Download CSV</a></div>\n"
            . "<div class=\"card\"><dl class=\"card-body\"><dt>Format</dt><dd>MMDB</dd><dt>MD5SUM</dt><dd class=\"small\">5974b336a7409ec854f67eacd52c2061</dd>\n"
            . "<dt>SHA1SUM</dt>\n\t\t\t\t\t<dd class=\"small\">$sum</dd></dl>\n"
            . "<a href='https://download.db-ip.com/free/dbip-$mode-lite-$release.mmdb.gz' class='btn'>Download MMDB</a></div>";
    }

    /**
     * A DbIp whose page and downloads are answered from `$answers`, by URL, each a Response or a function giving
     * one; anything else is a 404. Every URL asked for and every line logged is kept. The download follows the
     * contract an app's own must: true for a 200, false for a 404, and a throw for anything else.
     *
     * @param array<string, Response|\Closure(): Response> $answers
     */
    private function geoWith(array $answers): object
    {
        $t = new \stdClass();
        $t->dir = $this->root . '/' . bin2hex(random_bytes(4));
        $t->asked = [];
        $t->lines = [];
        $t->answers = $answers;
        $answer = static function (string $url) use ($t): Response {
            $t->asked[] = $url;
            $found = $t->answers[$url] ?? new Response('nope', 404);
            return $found instanceof \Closure ? $found() : $found;
        };
        $pages = new FakeFetcher(function (string $url, array $init) use ($answer): Response {
            $this->assertSame('manual', $init['redirect'] ?? null, 'no redirect is ever followed');
            $this->assertSame(DbIp::MOST_PAGE_BYTES, $init['maxBytes'] ?? null);
            $found = $answer($url);
            if (strlen($found->text()) > $init['maxBytes']) {
                throw new BodyTooLong("Body over {$init['maxBytes']} bytes");
            }
            return $found;
        });
        $download = static function (string $url, string $file) use ($answer): bool {
            $found = $answer($url);
            if ($found->status === 404) {
                return false;
            }
            if ($found->status !== 200) {
                throw new \RuntimeException("it answered {$found->status}");
            }
            if ((int) ($found->headers->get('content-length') ?? 0) > DbIp::MOST_PACKED_BYTES) {
                throw new \RuntimeException('the download is more than 256 MB');
            }
            return file_put_contents($file, $found->text()) !== false;
        };
        $t->geo = new DbIp($t->dir, 'city', $download, static function (string $line) use ($t): void {
            $t->lines[] = $line;
        }, null, $pages);
        return $t;
    }

    /**
     * Answers for one release: the page with `$sum` (the file's own by default), and the file, gzipped.
     *
     * @return array<string, Response>
     */
    private static function release(string $name, string $file, ?string $sum = null): array
    {
        return [self::PAGE => new Response(self::page('city', $name, $sum ?? sha1($file))), self::file($name) => new Response((string) gzencode($file))];
    }

    /** @return list<string> the databases and anything left of a download, without the note of when to try again */
    private static function onDisk(object $t): array
    {
        return array_map('basename', glob("{$t->dir}/dbip-*") ?: []);
    }

    private static function loaded(object $t): ?string
    {
        $newest = $t->geo->newest();
        return $newest === null ? null : substr(basename($newest), -12, 7);
    }

    public function testADownloadWhoseChecksumMatchesDbIpsPageIsPutToUse(): void
    {
        $file = self::mmdb();
        $t = $this->geoWith(self::release('2026-10', $file));
        $t->geo->refresh(self::OCTOBER);
        $this->assertSame([self::PAGE, self::file('2026-10')], $t->asked);
        $this->assertSame('2026-10', self::loaded($t));
        $this->assertSame(['country' => 'US', 'region' => '', 'city' => 'Mountain View'], ($t->geo->lookup())('8.8.8.8'));
        $this->assertSame(['dbip-city-lite-2026-10.mmdb'], self::onDisk($t));
        $this->assertSame(sha1($file), sha1_file("{$t->dir}/dbip-city-lite-2026-10.mmdb"));
        $this->assertSame(['Runlight: location data from DB-IP (2026-10) is ready.'], $t->lines);
    }

    public function testEarlyInAMonthThePageStillOffersLastMonthsReleaseAndThatIsTheOneFetched(): void
    {
        $t = $this->geoWith(self::release('2026-09', self::mmdb(['build_epoch' => 1_788_228_000]))); // 2026-09-01
        $t->geo->refresh(self::OCTOBER);
        $this->assertSame([self::PAGE, self::file('2026-09')], $t->asked);
        $this->assertSame('2026-09', self::loaded($t));
        $t->geo->refresh(self::OCTOBER + 5 * self::MIN);
        $this->assertSame([self::PAGE, self::file('2026-09'), self::PAGE], $t->asked, 'the page is read again, and the file is not fetched twice');
    }

    public function testADownloadThatDoesNotMatchThePublishedChecksumIsNeverUsedAndTheDatabaseInUseStays(): void
    {
        $old = self::mmdb(['build_epoch' => 1_788_228_000]);
        $t = $this->geoWith(self::release('2026-09', $old));
        $t->geo->refresh(1_788_400_000_000); // early September
        $this->assertSame('2026-09', self::loaded($t));

        $swapped = self::mmdb([], ['country' => ['iso_code' => 'ZZ']]);
        $published = str_repeat('a', 40);
        $t->answers = self::release('2026-10', $swapped, $published);
        $t->lines = [];
        $t->geo->refresh(self::OCTOBER);
        $this->assertSame('2026-09', self::loaded($t));
        $this->assertSame('US', ($t->geo->lookup())('8.8.8.8')['country']);
        $this->assertSame(['dbip-city-lite-2026-09.mmdb'], self::onDisk($t));
        $this->assertSame(['Runlight: location data was not updated from ' . self::file('2026-10') . ': its SHA-1 is ' . sha1($swapped) . ", and DB-IP publishes $published"], $t->lines);

        // Bytes after the end of the gzip stream never end up in a file on disk.
        $good = self::mmdb();
        $t->answers = [self::PAGE => new Response(self::page('city', '2026-10', sha1($good))), self::file('2026-10') => new Response(gzencode($good) . 'more')];
        $t->lines = [];
        $t->geo->refresh(self::OCTOBER + 5 * self::MIN);
        $this->assertSame(['dbip-city-lite-2026-09.mmdb'], self::onDisk($t));
        $this->assertCount(1, $t->lines);
        $this->assertStringContainsString('after the end of the gzip stream', $t->lines[0]);
    }

    public function testWhenNoChecksumCanBeReadAtAllTheNewestReleaseIsTakenOnItsStructureAloneWithAWarning(): void
    {
        $file = self::mmdb();
        $url = self::PAGE;
        $pages = [
            'it answered 503' => new Response('down', 503),
            'it answered 302' => new Response('', 302, ['location' => 'https://elsewhere.example/']),
            "found no checksum for the city database at $url" => new Response(str_replace(sha1($file), 'none', self::page('city', '2026-10', sha1($file)))),
            "found no checksum for the city database at $url " => new Response(self::page('country', '2026-10', sha1($file))),
            'it is more than 1024 KB' => new Response(str_repeat('x', DbIp::MOST_PAGE_BYTES + 1)),
        ];
        foreach ($pages as $reason => $page) {
            $reason = trim($reason);
            $why = str_starts_with($reason, 'found') ? $reason : "could not read DB-IP's checksums at $url: $reason";
            $t = $this->geoWith([self::PAGE => $page, self::file('2026-10') => new Response((string) gzencode($file))]);
            $t->geo->refresh(self::OCTOBER);
            $this->assertSame([self::PAGE, self::file('2026-10')], $t->asked, $reason);
            $this->assertSame('2026-10', self::loaded($t), $reason);
            $this->assertSame([
                "Runlight: warning: location data from DB-IP (2026-10) could not be checked against DB-IP's published checksum ($why). It was accepted as a DB-IP database of the right kind, without that check.",
                'Runlight: location data from DB-IP (2026-10) is ready.',
            ], $t->lines);
        }

        // This month's file is not out yet: last month's is taken, and a 404 on the way is no failure to speak of.
        $t = $this->geoWith([self::file('2026-09') => new Response((string) gzencode(self::mmdb(['build_epoch' => 1_788_228_000])))]);
        $t->geo->refresh(self::OCTOBER);
        $this->assertSame([self::PAGE, self::file('2026-10'), self::file('2026-09')], $t->asked);
        $this->assertSame('2026-09', self::loaded($t));
        $this->assertCount(2, $t->lines);
        $this->assertStringStartsWith('Runlight: warning: location data from DB-IP (2026-09) could not be checked', $t->lines[0]);
        $this->assertSame('Runlight: location data from DB-IP (2026-09) is ready.', $t->lines[1]);

        // The other checks hold in the fallback too.
        $t = $this->geoWith([self::file('2026-10') => new Response((string) gzencode(self::mmdb(['database_type' => 'GeoLite2-City'])))]);
        $t->geo->refresh(self::OCTOBER);
        $this->assertNull(self::loaded($t));
        $this->assertSame([], self::onDisk($t));
        $this->assertSame([], array_filter($t->lines, static fn (string $l): bool => str_contains($l, 'warning')));
        $this->assertSame('Runlight: location data was not updated from ' . self::file('2026-10') . ': it is a "GeoLite2-City" database, not DB-IP\'s city one', $t->lines[0]);
        $this->assertSame("Runlight: location data was not updated: could not read DB-IP's checksums at $url: it answered 404, and no release could be downloaded without them", end($t->lines));
    }

    public function testAPageThatIsReadIsHeldToAReleaseItDoesNotOfferIsNotFetchedAndAMismatchIsNeverAFallback(): void
    {
        $file = self::mmdb();
        $t = $this->geoWith(self::release('2026-05', $file) + [self::file('2026-10') => new Response((string) gzencode($file))]);
        $t->geo->refresh(self::OCTOBER);
        $this->assertSame([self::PAGE], $t->asked);
        $this->assertNull(self::loaded($t));
        $this->assertSame(["Runlight: location data was not updated: DB-IP offers the 2026-05 release, which is neither this month's nor last month's"], $t->lines);

        $published = str_repeat('b', 40);
        $t = $this->geoWith(self::release('2026-10', $file, $published) + [self::file('2026-09') => new Response((string) gzencode($file))]);
        $t->geo->refresh(self::OCTOBER);
        $this->assertSame([self::PAGE, self::file('2026-10')], $t->asked, 'last month\'s good file is not asked for');
        $this->assertNull(self::loaded($t));
        $this->assertSame([], self::onDisk($t));
        $this->assertSame(['Runlight: location data was not updated from ' . self::file('2026-10') . ': its SHA-1 is ' . sha1($file) . ", and DB-IP publishes $published"], $t->lines);
    }

    public function testADownloadThatRedirectsIsNotGzipOrIsTooLargeIsRefused(): void
    {
        $file = self::mmdb();
        $packed = (string) gzencode($file);
        $bad = [
            'it answered 301' => new Response('', 301, ['location' => 'https://elsewhere.example/db.gz']),
            'it is not a gzip file' => new Response('not gzip at all, not even nearly'),
            'the gzip stream stops before its end' => new Response(substr($packed, 0, intdiv(strlen($packed), 2))),
            'the download is more than 256 MB' => new Response($packed, 200, ['content-length' => (string) (300 * 1024 * 1024)]),
        ];
        foreach ($bad as $reason => $answer) {
            $t = $this->geoWith([self::PAGE => new Response(self::page('city', '2026-10', sha1($file))), self::file('2026-10') => $answer]);
            $t->geo->refresh(self::OCTOBER);
            $this->assertSame([], self::onDisk($t), $reason);
            $this->assertNull($t->geo->lookup(), $reason);
            $this->assertSame(['Runlight: location data was not updated from ' . self::file('2026-10') . ": $reason"], $t->lines);
        }

        // The file layer's own unpacking holds to the size it is given, and gives the hash of what it wrote.
        $disk = new DbIpDisk();
        mkdir($dir = "{$this->root}/unpack");
        file_put_contents("$dir/a.gz", $packed);
        $this->assertSame(sha1($file), $disk->gunzip("$dir/a.gz", "$dir/a", DbIp::MOST_BYTES));
        $this->assertSame($file, file_get_contents("$dir/a"));
        try {
            $disk->gunzip("$dir/a.gz", "$dir/b", 1000);
            $this->fail('It unpacked past the cap.');
        } catch (\RuntimeException $error) {
            $this->assertStringContainsString('is more than', $error->getMessage());
        }
    }

    public function testAFileWithTheRightChecksumIsStillReadAsADbIpDatabaseBeforeItIsUsed(): void
    {
        $now = self::OCTOBER;
        $refused = [
            'it unpacks to 201 bytes, too few for a location database' => self::mmdb([], self::RECORD, 0),
            'it is not an MMDB file' => str_repeat("\0", 2 * 1024 * 1024),
            'it is a "GeoLite2-City" database, not DB-IP\'s city one' => self::mmdb(['database_type' => 'GeoLite2-City']),
            'it is a "DBIP-Country-Lite" database, not DB-IP\'s city one' => self::mmdb(['database_type' => 'DBIP-Country-Lite']),
            'its format is version 3, not 2' => self::mmdb(['binary_format_major_version' => 3]),
            'it covers IP version 4, not 6' => self::mmdb(['ip_version' => 4]),
            'it does not open as an MMDB file: Unsupported record size 20' => self::mmdb(['record_size' => 20]),
            'its search tree does not fit in the file' => self::mmdb(['node_count' => 5_000_000]),
            'it was built on 2026-05-01' => self::mmdb(['build_epoch' => 1_777_600_800]),
            'it was built on 2026-12-01' => self::mmdb(['build_epoch' => 1_796_090_400]),
            'it has no country for 8.8.8.8' => self::mmdb([], null),
            'it has no country for 8.8.8.8 ' => self::mmdb([], ['city' => ['names' => ['en' => 'Nowhere']]]),
        ];
        foreach ($refused as $reason => $bytes) {
            $t = $this->geoWith(self::release('2026-10', $bytes));
            $t->geo->refresh($now);
            $line = $t->lines[0] ?? '';
            if (str_starts_with($reason, 'it unpacks to')) {
                $this->assertMatchesRegularExpression('/: it unpacks to \d+ bytes, too few for a location database$/', $line);
            } else {
                $this->assertSame('Runlight: location data was not updated from ' . self::file('2026-10') . ': ' . trim($reason), $line);
            }
            $this->assertSame([], self::onDisk($t), $reason);
        }

        // Not before the one in use.
        $db = new Mmdb(self::mmdb());
        DbIp::checkDatabase($db, 'city', $now);
        try {
            DbIp::checkDatabase($db, 'city', $now, ($db->metadata['build_epoch'] + 1) * 1000);
            $this->fail('An older database was taken.');
        } catch (\RuntimeException $error) {
            $this->assertSame('it is older than the database in use', $error->getMessage());
        }

        // End to end: the checksum matches, and the file is still the other kind's.
        $other = self::mmdb(['database_type' => 'DBIP-Country-Lite']);
        $t = $this->geoWith(self::release('2026-10', $other));
        $t->geo->refresh($now);
        $this->assertNull($t->geo->lookup());
        $this->assertSame([], self::onDisk($t));
    }

    public function testTheChecksumReadFromDbIpsPageIsTheMmdbFilesNotTheCsvFiles(): void
    {
        $sum = '09EEA8433FE3EED71984FD6AAC9D8AB3D9CA51F0';
        $this->assertSame(['release' => '2026-11', 'sha1' => strtolower($sum)], DbIp::publishedChecksum(self::page('country', '2026-11', $sum), 'country'));
        $this->assertNull(DbIp::publishedChecksum(self::page('country', '2026-11', $sum), 'city'));
        $this->assertNull(DbIp::publishedChecksum(self::page('country', '2026-11', 'not a checksum'), 'country'));
        $this->assertNull(DbIp::publishedChecksum('<html><body>Something else entirely</body></html>', 'country'));
    }

    public function testAFailedDownloadLeavesLookupsEmptyAndTheFolderCleanAndIsTriedAgainLater(): void
    {
        $t = $this->geoWith([]);
        $t->geo->refresh(self::OCTOBER);
        $this->assertSame([self::PAGE, self::file('2026-10'), self::file('2026-09')], $t->asked);
        $this->assertNull($t->geo->lookup());
        $this->assertSame([], self::onDisk($t));
        $this->assertSame("Runlight: location data was not updated: could not read DB-IP's checksums at " . self::PAGE . ': it answered 404, and no release could be downloaded without them', end($t->lines));

        $t->answers = self::release('2026-10', self::mmdb());
        $t->geo->refresh(self::OCTOBER + 5 * self::MIN);
        $this->assertSame('2026-10', self::loaded($t));
    }

    public function testAFileThatKeepsBeingMissingOrBadIsAskedForLessAndLessOftenUpToEverySixHours(): void
    {
        $t = $this->geoWith([]);
        $attempts = [];
        // Asked every five minutes, as cron does, for two days.
        for ($minute = 0; $minute <= 2 * 24 * 60; $minute += 5) {
            $before = count($t->asked);
            $t->geo->refresh(self::OCTOBER + $minute * self::MIN);
            if (count($t->asked) > $before) {
                $this->assertSame(3, count($t->asked) - $before, 'three requests an attempt');
                $attempts[] = $minute;
            }
        }
        $this->assertSame([0, 5, 15, 35, 75, 155, 315, 635], array_slice($attempts, 0, 8));
        $this->assertSame([360, 360, 360], [$attempts[8] - $attempts[7], $attempts[9] - $attempts[8], $attempts[10] - $attempts[9]]);
    }
}
