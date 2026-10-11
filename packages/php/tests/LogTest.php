<?php

declare(strict_types=1);

namespace Runlight\Tests;

use PHPUnit\Framework\TestCase;
use Runlight\Log;

/** Runlight's notes: PHP's error log by default, or wherever an app sends them. */
final class LogTest extends TestCase
{
    protected function tearDown(): void
    {
        Log::to(null);
    }

    public function testNotesGoToTheErrorLogUnlessAnAppSendsThemElsewhere(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'runlight-log');
        $before = ini_set('error_log', $file);
        try {
            Log::write('Runlight: to the error log');
            $lines = [];
            Log::to(static function (string $line) use (&$lines): void {
                $lines[] = $line;
            });
            Log::write('Runlight: to the app');
            Log::to(null);
            Log::write('Runlight: back to the error log');
        } finally {
            ini_set('error_log', (string) $before);
        }
        $logged = (string) file_get_contents($file);
        unlink($file);
        $this->assertSame(['Runlight: to the app'], $lines);
        $this->assertStringContainsString('Runlight: to the error log', $logged);
        $this->assertStringContainsString('Runlight: back to the error log', $logged);
        $this->assertStringNotContainsString('to the app', $logged);
    }
}
