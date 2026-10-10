<?php

declare(strict_types=1);

namespace Runlight\Tests\Accounts;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Runlight\Store\SqlStore;
use Runlight\Store\Stores;
use Runlight\Tests\Store\Databases;

/** Several PHP processes at once, as PHP-FPM serves them: the database's lock makes them take turns. */
final class TurnsTest extends TestCase
{
    private ?string $dir = null;

    /** @return array<string, array{0: string}> */
    public static function kinds(): array
    {
        return Databases::kinds();
    }

    protected function tearDown(): void
    {
        Databases::cleanup();
        if ($this->dir !== null) {
            foreach (glob("$this->dir/*") ?: [] as $file) {
                @unlink($file);
            }
            @rmdir($this->dir);
        }
    }

    /** @return array{0: SqlStore, 1: list<string>} a store and the arguments that open it in another process */
    private function shared(string $kind): array
    {
        if ($kind === 'sqlite') {
            $this->dir = sys_get_temp_dir() . '/runlight-turns-' . bin2hex(random_bytes(5));
            mkdir($this->dir);
            $file = "$this->dir/runlight.db";
            return [Stores::sqlite($file), ['sqlite', $file]];
        }
        if ($kind === 'postgres') {
            $schema = Databases::pgSchema();
            $url = (string) Databases::pgUrl();
            return [Stores::postgres($url, ['schema' => $schema]), ['postgres', $url, $schema]];
        }
        $url = Databases::mysqlDatabase(Databases::mysqlUrls()[$kind], 'rl_test_' . bin2hex(random_bytes(5)));
        return [Stores::mysql($url), ['mysql', $url]];
    }

    /**
     * @param list<string> $args
     * @return list<string> what each process printed
     */
    private function race(string $what, array $args, int $count = 4): array
    {
        $start = (string) (microtime(true) + 1.5);
        $processes = [];
        $pipes = [];
        for ($i = 0; $i < $count; $i++) {
            $processes[] = proc_open([PHP_BINARY, __DIR__ . '/../Support/turns.php', $what, $start, ...$args], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $p);
            $pipes[] = $p;
        }
        $outputs = [];
        foreach ($processes as $i => $process) {
            $out = (string) stream_get_contents($pipes[$i][1]);
            $err = (string) stream_get_contents($pipes[$i][2]);
            $this->assertSame(0, proc_close($process), "$out $err");
            $outputs[] = trim($out);
        }
        return $outputs;
    }

    #[DataProvider('kinds')]
    public function testAReadThenWriteUnderTheLockIsNeverLost(string $kind): void
    {
        [$store, $args] = $this->shared($kind);
        $store->migrate();
        $this->assertSame(['ok', 'ok', 'ok', 'ok'], $this->race('count', $args));
        $this->assertSame('80', $store->setting('turns'));
        $store->close();
    }

    #[DataProvider('kinds')]
    public function testABurstAcrossProcessesGetsNoMoreTriesThanTheLimit(string $kind): void
    {
        [$store, $args] = $this->shared($kind);
        $store->migrate();
        $this->assertSame(5, array_sum(array_map('intval', $this->race('throttle', $args))));
        $store->close();
    }
}
