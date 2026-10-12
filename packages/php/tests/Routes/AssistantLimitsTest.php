<?php

declare(strict_types=1);

namespace Runlight\Tests\Routes;

use PHPUnit\Framework\TestCase;
use Runlight\Http\Request;
use Runlight\Runlight;
use Runlight\Store\Stores;
use Runlight\Tests\Conformance\Player;

/** A viewer's daily number of assistant questions holds for questions sent one after another, or at once from several processes. */
final class AssistantLimitsTest extends TestCase
{
    private const NOW = 1_791_806_400_000;

    /** @var array<string, mixed> */
    private array $env = [];
    private string $dir = '';

    protected function setUp(): void
    {
        $this->env = Player::clearEnv();
        $this->dir = sys_get_temp_dir() . '/runlight-asks-' . bin2hex(random_bytes(6));
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        Player::restoreEnv($this->env);
        foreach (glob($this->dir . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->dir);
    }

    private function made(): Runlight
    {
        return new Runlight(['store' => Stores::sqlite("{$this->dir}/runlight.db"), 'now' => fn (): int => self::NOW, 'sites' => [['id' => 'a', 'name' => 'A', 'hostnames' => ['a.example.com']]]]);
    }

    private static function ask(Runlight $rl, string $who): int
    {
        $routes = $rl->routes(['authorize' => static fn (Request $r): string|false => $r->headers->get('x-who') !== null ? 'read' : false, 'accountOf' => static fn (Request $r): ?string => $r->headers->get('x-who')]);
        $body = json_encode(['site' => 'a', 'messages' => [['role' => 'user', 'content' => 'hi']]]);
        return $routes->handle(new Request('https://x.com/runlight/api/assistant/chat', 'POST', ['x-who' => $who, 'content-type' => 'application/json'], $body))->status;
    }

    public function testQuestionsCountOnceEachAgainstAViewersDailyNumber(): void
    {
        $first = $this->made();
        $first->init();
        // The model is never reached; a question that gets past the limits fails fast instead.
        $first->saveAssistantSettings(['provider' => 'custom', 'model' => 'm', 'baseUrl' => 'http://127.0.0.1:9/v1', 'key' => 'k']);
        $first->store->setSetting('assistant-viewer-daily', '1');
        $count = static fn (string $who): ?string => $first->store->setting("assistant-asked:2026-10-12:$who");
        $passed = static fn (array $statuses): int => count(array_filter($statuses, static fn (int $s): bool => $s !== 429));

        $this->assertSame(1, $passed(array_map(fn () => self::ask($first, 'viewer-1'), range(1, 10))));
        $this->assertSame('1', $count('viewer-1'));

        // Ten handlers on one database, each knowing nothing of the others: the database lets one through.
        $this->assertSame(1, $passed(array_map(fn () => self::ask($this->made(), 'viewer-2'), range(1, 10))));
        $this->assertSame('1', $count('viewer-2'));

        // Two viewers each have their own row, and neither write loses the other's.
        $this->assertSame(2, $passed([self::ask($this->made(), 'viewer-3'), self::ask($this->made(), 'viewer-4')]));
        $this->assertSame('1', $count('viewer-3'));
        $this->assertSame('1', $count('viewer-4'));

        // A limit of none refuses at once without writing, and the old single row for the day is cleared.
        $first->store->setSetting('assistant-viewer-daily', '0');
        $this->assertSame(429, self::ask($first, 'viewer-5'));
        $this->assertNull($count('viewer-5'));
        $first->store->setSetting('assistant-asked:2026-10-11', '{"viewer-1":1}');
        $first->store->setSetting('assistant-viewer-daily', '2');
        $this->assertNotSame(429, self::ask($first, 'viewer-6'));
        $this->assertNull($first->store->setting('assistant-asked:2026-10-11'), 'a first question of the day clears earlier days');
    }

    public function testProcessesAskingAtOnceEachTakeTheDatabasesCountOnce(): void
    {
        $first = $this->made();
        $first->init();
        $first->saveAssistantSettings(['provider' => 'custom', 'model' => 'm', 'baseUrl' => 'http://127.0.0.1:9/v1', 'key' => 'k']);
        $first->store->setSetting('assistant-viewer-daily', '1');
        $autoload = dirname(__DIR__, 2) . '/vendor/autoload.php';
        $code = 'require ' . var_export($autoload, true) . ';'
            . '$rl = new \Runlight\Runlight(["store" => \Runlight\Store\Stores::sqlite(' . var_export("{$this->dir}/runlight.db", true) . '), "now" => fn () => ' . self::NOW . ', "sites" => [["id" => "a", "name" => "A", "hostnames" => ["a.example.com"]]]]);'
            . '$routes = $rl->routes(["authorize" => fn ($r) => "read", "accountOf" => fn ($r) => "viewer-p"]);'
            . '$body = json_encode(["site" => "a", "messages" => [["role" => "user", "content" => "hi"]]]);'
            . 'echo $routes->handle(new \Runlight\Http\Request("https://x.com/runlight/api/assistant/chat", "POST", ["content-type" => "application/json"], $body))->status;';
        $running = [];
        for ($i = 0; $i < 6; $i++) {
            $process = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $this->assertIsResource($process);
            $running[] = [$process, $pipes];
        }
        $statuses = [];
        foreach ($running as [$process, $pipes]) {
            $statuses[] = (int) stream_get_contents($pipes[1]);
            stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);
        }
        $this->assertSame(1, count(array_filter($statuses, static fn (int $s): bool => $s !== 429)), implode(' ', $statuses));
        $this->assertSame('1', $first->store->setting('assistant-asked:2026-10-12:viewer-p'));
    }
}
