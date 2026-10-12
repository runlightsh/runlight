<?php

declare(strict_types=1);

namespace Runlight\Tests\Server;

use PHPUnit\Framework\TestCase;
use Runlight\Server\Config;

/** The secret kept beside the data, made once however many servers start on the folder at once. */
final class SecretTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/runlight-secret-' . bin2hex(random_bytes(6));
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/{,.}*', GLOB_BRACE) ?: [] as $file) {
            if (is_file($file)) {
                unlink($file);
            }
        }
        rmdir($this->dir);
    }

    public function testServersStartingAtOnceOnOneFolderAgreeOnOneSecretKeptReadableOnlyByThisUser(): void
    {
        $autoload = dirname(__DIR__, 2) . '/vendor/autoload.php';
        $code = 'require ' . var_export($autoload, true) . '; echo \Runlight\Server\Config::secretIn(' . var_export($this->dir, true) . ');';
        $running = [];
        for ($i = 0; $i < 6; $i++) {
            $process = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $this->assertIsResource($process);
            $running[] = [$process, $pipes];
        }
        $secrets = [];
        foreach ($running as [$process, $pipes]) {
            $secrets[] = stream_get_contents($pipes[1]);
            stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            $this->assertSame(0, proc_close($process));
        }
        $this->assertCount(1, array_unique($secrets), implode(' ', $secrets));
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $secrets[0]);
        $this->assertSame($secrets[0], Config::secretIn($this->dir));
        $this->assertSame(0600, fileperms("{$this->dir}/secret") & 0777);
        $this->assertSame(['secret'], array_values(array_diff(scandir($this->dir) ?: [], ['.', '..'])), 'no file made on the way is left behind');
    }

    public function testASecretFileReadEmptyOrShortIsWaitedForAndRefusedRatherThanUsed(): void
    {
        file_put_contents("{$this->dir}/secret", "abc\n");
        $started = microtime(true);
        try {
            Config::secretIn($this->dir);
            $this->fail('a short secret was used');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('holds no whole secret', $e->getMessage());
        }
        $this->assertGreaterThanOrEqual(1.0, microtime(true) - $started, 'it waited for a writer to finish first');
        file_put_contents("{$this->dir}/secret", '');
        $this->expectExceptionMessage('holds no whole secret');
        try {
            Config::secretIn($this->dir);
        } finally {
            $own = str_repeat('a', 40);
            file_put_contents("{$this->dir}/secret", "$own\n");
            $this->assertSame($own, Config::secretIn($this->dir), 'one that is whole is kept as it is');
        }
    }
}
