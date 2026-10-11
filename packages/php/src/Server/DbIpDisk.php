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

    public function gunzip(string $from, string $to): void
    {
        $in = gzopen($from, 'rb');
        $out = fopen($to, 'wb');
        if ($in === false || $out === false) {
            throw new \RuntimeException("could not unpack $from");
        }
        try {
            while (!gzeof($in)) {
                $chunk = gzread($in, 1 << 20);
                if ($chunk === false) {
                    throw new \RuntimeException("could not unpack $from");
                }
                fwrite($out, $chunk);
            }
        } finally {
            gzclose($in);
            fclose($out);
        }
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
     * download that does not go through a Fetcher, which keeps whole answers in memory.
     */
    public static function download(string $url, string $file): bool
    {
        $out = fopen($file, 'wb');
        if ($out === false) {
            throw new \RuntimeException("could not write $file");
        }
        try {
            if (!function_exists('curl_init')) {
                $in = @fopen($url, 'rb', false, stream_context_create(['http' => ['timeout' => 600, 'ignore_errors' => false]]));
                if ($in === false) {
                    return false;
                }
                stream_copy_to_stream($in, $out);
                fclose($in);
                return true;
            }
            $handle = curl_init($url);
            curl_setopt_array($handle, [
                CURLOPT_FILE => $out,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_FAILONERROR => true,
                CURLOPT_TIMEOUT => 600,
                CURLOPT_CONNECTTIMEOUT => 15,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            ]);
            $ok = curl_exec($handle);
            $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
            $error = curl_error($handle);
            if ($ok === false && $status === 0) {
                throw new \RuntimeException($error !== '' ? $error : 'no answer');
            }
            return $ok !== false && $status === 200;
        } finally {
            fclose($out);
        }
    }
}
