<?php

declare(strict_types=1);

namespace Runlight\Server;

use Runlight\Mmdb;

/**
 * What DbIp does with the files in its folder, beyond listing them: the folder itself, unpacking a download,
 * opening a database, and putting files in place or away. DbIpDisk does it with PHP's own file functions, and
 * an app with a filesystem layer of its own, such as a CMS's, passes one that goes through that.
 */
interface DbIpFiles
{
    /** Makes the folder when it is not there, and says whether it is there now. */
    public function folder(string $dir): bool;

    /**
     * Unpacks the gzipped file `$from` to `$to` and gives the SHA-1 of the unpacked bytes, as lowercase hex.
     * Throws when it cannot, and also when the gzip stream stops before its end, when bytes follow its end, or
     * when it unpacks to more than `$max` bytes, so nothing but one whole stream of a believable size is kept.
     */
    public function gunzip(string $from, string $to, int $max): string;

    /** The database in a file. Throws when it cannot be read or is not one. */
    public function open(string $file): Mmdb;

    /** Moves `$from` to `$to`, replacing what is there. Throws when it cannot. */
    public function move(string $from, string $to): void;

    /** Deletes a file, when it is there. */
    public function delete(string $file): void;
}
