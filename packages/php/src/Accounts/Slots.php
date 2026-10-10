<?php

declare(strict_types=1);

namespace Runlight\Accounts;

use Runlight\Scratch;

/**
 * A few places at once for slow work, shared by every PHP process on the machine. Checking a password takes
 * PHP's scrypt most of a second of CPU, and the address a sign-in is counted under can be made up when a
 * proxy's header is trusted, so a flood of sign-ins could otherwise keep every worker busy hashing. Each
 * place is a file locked with flock(), which the system lets go of when the process ends, however it ends.
 *
 * With no folder to keep the files in (see Scratch), the work runs without waiting.
 */
final class Slots
{
    public function __construct(
        private readonly ?string $dir,
        private readonly int $count = 4,
        private readonly int $waitMs = 3000,
    ) {
    }

    /**
     * Runs `$fn` in one of the places, waiting up to the wait for one to come free.
     *
     * @template T
     * @param callable(): T $fn
     * @return array{0: bool, 1: T|null} whether it ran, and what it gave
     */
    public function run(callable $fn): array
    {
        $dir = Scratch::dir('runlight-slots', $this->dir);
        if ($dir === null) {
            return [true, $fn()];
        }
        $deadline = microtime(true) + $this->waitMs / 1000;
        for (;;) {
            for ($i = 0; $i < $this->count; $i++) {
                $file = "$dir/$i";
                $handle = @fopen($file, 'c');
                if ($handle === false) {
                    return [true, $fn()];
                }
                if (flock($handle, LOCK_EX | LOCK_NB)) {
                    Scratch::protect($file);
                    try {
                        return [true, $fn()];
                    } finally {
                        flock($handle, LOCK_UN);
                        fclose($handle);
                    }
                }
                fclose($handle);
            }
            if (microtime(true) >= $deadline) {
                return [false, null];
            }
            usleep(50_000);
        }
    }
}
