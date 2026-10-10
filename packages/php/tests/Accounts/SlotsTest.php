<?php

declare(strict_types=1);

namespace Runlight\Tests\Accounts;

use PHPUnit\Framework\TestCase;
use Runlight\Accounts\Slots;

final class SlotsTest extends TestCase
{
    private string $base;

    protected function setUp(): void
    {
        $this->base = sys_get_temp_dir() . '/runlight-slots-test-' . bin2hex(random_bytes(5));
        mkdir($this->base);
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob("$this->base/runlight-slots/*") ?: []);
        @rmdir("$this->base/runlight-slots");
        rmdir($this->base);
    }

    public function testWorkWaitsForAPlaceAndGivesUpWhenNoneComesFree(): void
    {
        $slots = new Slots($this->base, 2, 100);
        $this->assertSame([true, 'ran'], $slots->run(static fn (): string => 'ran'));
        // Another process holding both places, as two slow checks would.
        $held = [];
        foreach ([0, 1] as $i) {
            $held[$i] = fopen("$this->base/runlight-slots/$i", 'c');
            $this->assertTrue(flock($held[$i], LOCK_EX | LOCK_NB));
        }
        $ran = false;
        $started = microtime(true);
        $this->assertSame([false, null], $slots->run(static function () use (&$ran): void {
            $ran = true;
        }));
        $this->assertFalse($ran);
        $this->assertGreaterThanOrEqual(0.1, microtime(true) - $started, 'it waited before giving up');
        flock($held[1], LOCK_UN);
        fclose($held[1]);
        $this->assertSame([true, 2], $slots->run(static fn (): int => 2));
        fclose($held[0]);
    }
}
