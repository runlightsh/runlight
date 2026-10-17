<?php

declare(strict_types=1);

namespace Runlight\Tests\Store;

use PHPUnit\Framework\TestCase;
use Runlight\Db\Connect;
use Runlight\Db\MysqlText;
use Runlight\Db\PdoDb;
use Runlight\WordPress\WpdbDb;

/** MySQL sessions in NO_BACKSLASH_ESCAPES mode: Runlight's own connections drop it, and the WordPress plugin's $wpdb driver, on WordPress's connection, writes for it. */
final class MysqlModeTest extends TestCase
{
    protected function tearDown(): void
    {
        Databases::cleanup();
    }

    public function testMysqlTextLeavesABackslashAloneWhenTheSessionReadsOneAsItself(): void
    {
        $this->assertSame("SELECT 'a\\\\b'", MysqlText::of("SELECT 'a\\b'"));
        $this->assertSame("SELECT 'a\\b'", MysqlText::of("SELECT 'a\\b'", null, null, false));
    }

    public function testBackslashesAndQuotesRoundTripWhetherOrNotTheSessionIsInNoBackslashEscapesMode(): void
    {
        if (!WordPress::mysqlAvailable() || !Databases::mysqlUrls()) {
            $this->markTestSkipped('RUNLIGHT_TEST_MYSQL is not set');
        }
        $url = Databases::mysqlDatabase(array_values(Databases::mysqlUrls())[0], 'rl_test_' . bin2hex(random_bytes(5)));
        $value = 'it\'s a \\ "back\\slash" \\\' end\\';
        foreach ([false, true] as $plain) {
            $wpdb = WordPress::connection($url);
            if ($plain) {
                $wpdb->query("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')");
                $this->assertStringContainsString('NO_BACKSLASH_ESCAPES', (string) $wpdb->get_var('SELECT @@SESSION.sql_mode'));
            }
            $db = new WpdbDb($wpdb);
            $label = $plain ? 'NO_BACKSLASH_ESCAPES' : 'the default mode';
            $this->assertSame('a\\b', $db->all("SELECT 'a\\b' AS v")[0]['v'], "text in a statement, $label");
            $db->run('CREATE TABLE IF NOT EXISTS t (id INT PRIMARY KEY, v VARCHAR(100))');
            $db->run('DELETE FROM t');
            $db->run('INSERT INTO t (id, v) VALUES (?, ?)', [1, $value]);
            $this->assertSame($value, $db->all('SELECT v FROM t WHERE id = ?', [1])[0]['v'], "a value, $label");
            $this->assertSame(1, count($db->all('SELECT id FROM t WHERE v = ?', [$value])), "found by it, $label");
            $this->assertSame(1, count($db->all("SELECT id FROM t WHERE v LIKE ? ESCAPE '\\'", ['%back\\\\slash%'])), "LIKE with an escape, $label");
        }
    }

    public function testEveryMysqlConnectionRunlightUsesDropsNoBackslashEscapes(): void
    {
        if (!Databases::mysqlUrls()) {
            $this->markTestSkipped('RUNLIGHT_TEST_MYSQL is not set');
        }
        $url = array_values(Databases::mysqlUrls())[0];
        $mode = static fn (PdoDb $db): string => (string) $db->all('SELECT @@SESSION.sql_mode AS m')[0]['m'];
        $this->assertStringNotContainsString('NO_BACKSLASH_ESCAPES', $mode(Connect::mysql($url)));
        // An app's own connection, handed over already in that mode, and one opened in it by a function.
        $parts = parse_url($url);
        $dsn = sprintf('mysql:host=%s;port=%d;charset=utf8mb4', $parts['host'], $parts['port'] ?? 3306);
        $open = static function () use ($dsn, $parts): \PDO {
            $pdo = new \PDO($dsn, rawurldecode((string) $parts['user']), rawurldecode((string) ($parts['pass'] ?? '')));
            $pdo->exec("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')");
            return $pdo;
        };
        $this->assertStringContainsString('NO_BACKSLASH_ESCAPES', (string) $open()->query('SELECT @@SESSION.sql_mode')->fetchColumn(), 'the connection starts in the mode');
        $this->assertStringNotContainsString('NO_BACKSLASH_ESCAPES', $mode(new PdoDb($open(), 'mysql', false)));
        $this->assertStringNotContainsString('NO_BACKSLASH_ESCAPES', $mode(new PdoDb($open(...), 'mysql')));
        $this->assertStringContainsString('STRICT_TRANS_TABLES', $mode(new PdoDb($open(...), 'mysql')), 'and the rest of the mode stays');
    }
}
