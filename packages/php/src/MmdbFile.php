<?php

declare(strict_types=1);

namespace Runlight;

/**
 * An MMDB file read a page at a time as lookups need it, for Mmdb, so a 130 MB city database costs each
 * request a few hundred kilobytes of reads rather than the whole file.
 */
final class MmdbFile
{
    private const PAGE = 4096;
    /** Pages kept from a file at once; a lookup reads a few dozen. */
    private const PAGES_KEPT = 256;

    public readonly int $size;
    /** @var array<int, string> pages read from the file, by number */
    private array $pages = [];

    /** @param resource $handle an open file */
    public function __construct(private readonly mixed $handle)
    {
        $this->size = (int) fstat($handle)['size'];
    }

    public static function open(string $file): self
    {
        $handle = is_file($file) ? @fopen($file, 'rb') : false;
        if ($handle === false) {
            throw new \RuntimeException("Could not read $file");
        }
        return new self($handle);
    }

    /** `$length` bytes from `$at`, fewer at the end of the file. */
    public function read(int $at, int $length): string
    {
        $out = '';
        $end = min($at + $length, $this->size);
        while ($at < $end) {
            $number = intdiv($at, self::PAGE);
            if (!isset($this->pages[$number])) {
                if (count($this->pages) >= self::PAGES_KEPT) {
                    $this->pages = [];
                }
                fseek($this->handle, $number * self::PAGE);
                $this->pages[$number] = (string) fread($this->handle, self::PAGE);
            }
            $offset = $at - $number * self::PAGE;
            $piece = substr($this->pages[$number], $offset, $end - $at);
            if ($piece === '') {
                break;
            }
            $out .= $piece;
            $at += strlen($piece);
        }
        return $out;
    }
}
