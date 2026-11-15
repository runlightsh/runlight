<?php

declare(strict_types=1);

namespace Runlight\Server;

use Runlight\Mmdb;

/** DbIp's files on this server's disk, through PHP's own file functions and curl. The default. */
final class DbIpDisk implements DbIpFiles
{
    public function folder(string $dir): bool
    {
        return is_dir($dir) || @mkdir($dir, 0755, true) || is_dir($dir);
    }

    public function gunzip(string $from, string $to, int $max): string
    {
        $in = @fopen($from, 'rb');
        $out = @fopen($to, 'wb');
        $inflate = inflate_init(ZLIB_ENCODING_GZIP);
        if ($in === false || $out === false || $inflate === false) {
            throw new \RuntimeException("could not unpack $from");
        }
        $hash = hash_init('sha1');
        $fed = 0;
        $written = 0;
        try {
            while (!feof($in)) {
                $chunk = fread($in, 1 << 16);
                if ($chunk === false) {
                    throw new \RuntimeException("could not read $from");
                }
                if ($chunk === '') {
                    continue;
                }
                // Past the end of the stream there is nothing that belongs to it.
                if (inflate_get_status($inflate) === ZLIB_STREAM_END) {
                    throw new \RuntimeException('there is more in it after the end of the gzip stream');
                }
                $fed += strlen($chunk);
                $piece = @inflate_add($inflate, $chunk, ZLIB_SYNC_FLUSH);
                if ($piece === false) {
                    throw new \RuntimeException('it is not a gzip file');
                }
                $written += strlen($piece);
                if ($written > $max) {
                    throw new \RuntimeException('the location data is more than ' . intdiv($max, 1024 * 1024) . ' MB');
                }
                hash_update($hash, $piece);
                if ($piece !== '' && fwrite($out, $piece) !== strlen($piece)) {
                    throw new \RuntimeException("could not write $to");
                }
                if (inflate_get_status($inflate) === ZLIB_STREAM_END && inflate_get_read_len($inflate) < $fed) {
                    throw new \RuntimeException('there is more in it after the end of the gzip stream');
                }
            }
            if (inflate_get_status($inflate) !== ZLIB_STREAM_END) {
                throw new \RuntimeException('the gzip stream stops before its end');
            }
        } finally {
            fclose($in);
            fclose($out);
        }
        return hash_final($hash);
    }

    public function open(string $file): Mmdb
    {
        return Mmdb::open($file);
    }

    public function move(string $from, string $to): void
    {
        if (!@rename($from, $to)) {
            throw new \RuntimeException("could not move $from");
        }
    }

    public function delete(string $file): void
    {
        @unlink($file);
    }

    /**
     * Downloads a file straight to disk, since a city database is too big to hold in memory. This is the one
     * download that does not go through a Fetcher, which keeps whole answers in memory. It goes nowhere but
     * where it was sent: https, with no redirect followed. True for a 200 written whole, false for a 404, and
     * anything else throws with the reason: another status, a file over DbIp::MOST_PACKED_BYTES by the length
     * it declares or the bytes that come, or ten minutes gone.
     */
    public static function download(string $url, string $file): bool
    {
        if (!str_starts_with($url, 'https://')) {
            throw new \RuntimeException('it is not an https address');
        }
        $most = DbIp::MOST_PACKED_BYTES;
        $tooBig = 'the download is more than ' . intdiv($most, 1024 * 1024) . ' MB';
        $out = fopen($file, 'wb');
        if ($out === false) {
            throw new \RuntimeException("could not write $file");
        }
        try {
            if (!function_exists('curl_init')) {
                $in = @fopen($url, 'rb', false, stream_context_create(['http' => ['timeout' => 600, 'ignore_errors' => true, 'follow_location' => 0]]));
                if ($in === false) {
                    throw new \RuntimeException('no answer');
                }
                try {
                    $status = 0;
                    $length = 0;
                    foreach (stream_get_meta_data($in)['wrapper_data'] ?? [] as $line) {
                        if (preg_match('#^HTTP/\S+\s+(\d+)#', (string) $line, $m)) {
                            $status = (int) $m[1];
                        } elseif (preg_match('/^content-length:\s*(\d+)/i', (string) $line, $m)) {
                            $length = (int) $m[1];
                        }
                    }
                    if ($status === 404) {
                        return false;
                    }
                    if ($status !== 200) {
                        throw new \RuntimeException("it answered $status");
                    }
                    if ($length > $most || stream_copy_to_stream($in, $out, $most + 1) > $most) {
                        throw new \RuntimeException($tooBig);
                    }
                    return true;
                } finally {
                    fclose($in);
                }
            }
            $seen = 0;
            $status = 0;
            $declared = false;
            $handle = curl_init($url);
            curl_setopt_array($handle, [
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_TIMEOUT => 600,
                CURLOPT_CONNECTTIMEOUT => 15,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$status, &$declared): int {
                    if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
                        $status = (int) $m[1];
                    }
                    // A length past the cap stops the download before any of it comes.
                    $declared = $declared || ($status === 200 && preg_match('/^content-length:\s*(\d+)/i', $line, $m) && (int) $m[1] > DbIp::MOST_PACKED_BYTES);
                    return $declared ? 0 : strlen($line);
                },
                CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$seen, &$status, $out, $most): int {
                    // Only a 200's body is the file; any other answer's is left unread.
                    if ($status !== 200) {
                        return 0;
                    }
                    $seen += strlen($chunk);
                    return $seen > $most ? 0 : (int) fwrite($out, $chunk);
                },
            ]);
            $ok = curl_exec($handle);
            $error = curl_error($handle);
            $timedOut = curl_errno($handle) === CURLE_OPERATION_TIMEDOUT;
            if ($status === 404) {
                return false;
            }
            if ($status !== 0 && $status !== 200) {
                throw new \RuntimeException("it answered $status");
            }
            if ($ok === false) {
                throw new \RuntimeException($status === 200 && !$timedOut ? ($seen > $most || $declared ? $tooBig : ($error !== '' ? $error : 'the download stopped')) : ($error !== '' ? $error : 'no answer'));
            }
            return true;
        } finally {
            fclose($out);
        }
    }
}
