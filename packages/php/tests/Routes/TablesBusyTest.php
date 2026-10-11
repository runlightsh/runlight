<?php

declare(strict_types=1);

namespace Runlight\Tests\Routes;

use PHPUnit\Framework\TestCase;
use Runlight\Db\Connect;
use Runlight\Db\Db;
use Runlight\Db\TablesBusy;
use Runlight\Runlight;
use Runlight\Store\SqlStore;
use Runlight\Tests\Conformance\Player;
use Runlight\Tests\Core\Harness;

/**
 * While another process creates or upgrades the tables, as tables.test.ts plays it: a tracker hit waits a moment
 * at most and is dropped, and any other request waits longer and then says why it could not be answered.
 */
final class TablesBusyTest extends TestCase
{
    /** @var array<string, mixed> */
    private array $env = [];

    protected function setUp(): void
    {
        $this->env = Player::clearEnv();
    }

    protected function tearDown(): void
    {
        Player::restoreEnv($this->env);
    }

    public function testATrackerHitIsDroppedAfterAShortWaitAndOtherRequestsAnswer503(): void
    {
        // A Db whose lock for creating tables another process holds past the wait, while `busy` is set.
        $db = new class (Connect::sqlite(':memory:')) implements Db {
            public bool $busy = true;
            /** @var list<float> how long each exclusive() was allowed to wait */
            public array $waits = [];

            public function __construct(private readonly Db $inner)
            {
            }

            public function dialect(): string
            {
                return $this->inner->dialect();
            }

            public function all(string $sql, array $params = []): array
            {
                return $this->inner->all($sql, $params);
            }

            public function run(string $sql, array $params = []): void
            {
                $this->inner->run($sql, $params);
            }

            public function transaction(callable $fn): mixed
            {
                return $this->inner->transaction(fn () => $fn($this));
            }

            public function exclusive(callable $fn): mixed
            {
                $this->waits[] = TablesBusy::wait();
                if ($this->busy) {
                    throw new TablesBusy(TablesBusy::wait());
                }
                return $this->inner->exclusive(fn () => $fn($this));
            }

            public function close(): void
            {
                $this->inner->close();
            }
        };
        $routes = (new Runlight(['store' => new SqlStore($db), 'site' => ['hostnames' => ['example.com']], 'now' => static fn (): int => Harness::START]))->routes(['token' => 'secret']);

        $hit = $routes->handle(Harness::hit('https://example.com/runlight/e', ['k' => 'pageview', 'u' => 'https://example.com/']));
        $this->assertSame(202, $hit->status, 'the hit is answered as any dropped hit is');
        $this->assertSame([10.0], $db->waits, 'a tracker hit waits ten seconds at most');

        // The other process gives up the wait: the request that waited answers 503, saying why.
        $answer = $routes->handle(Make::owner('/runlight/api/stats?period=today'));
        $this->assertSame(503, $answer->status);
        $this->assertSame('30', $answer->headers->get('retry-after'));
        $this->assertSame('no-store', $answer->headers->get('cache-control'));
        $this->assertSame(['error' => 'Runlight is creating or upgrading its tables. Try again in a minute.', 'code' => 'tables_busy'], Make::body($answer));
        $this->assertSame(30.0, $db->waits[1], 'any other request waits the full thirty seconds');

        // Once the tables are there, everything goes on, and the hit that came while they were busy was dropped.
        $db->busy = false;
        $stats = $routes->handle(Make::owner('/runlight/api/stats?period=today'));
        $this->assertSame(200, $stats->status);
        $this->assertSame(0, Make::body($stats)['stats']['visitors']);
        $this->assertSame(202, $routes->handle(Harness::hit('https://example.com/runlight/e', ['k' => 'pageview', 'u' => 'https://example.com/']))->status);
        $this->assertSame(1, Make::body($routes->handle(Make::owner('/runlight/api/stats?period=today')))['stats']['visitors']);
    }
}
