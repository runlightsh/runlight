<?php

declare(strict_types=1);

namespace Runlight\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Runlight\Http\SearchParams;
use Runlight\Http\Url;
use Runlight\Json;

/** Replays conformance/url.json: URLs, query strings, and numbers read and written as JavaScript does. */
final class UrlTest extends TestCase
{
    private static function fixture(): array
    {
        return Json::decode((string) file_get_contents(__DIR__ . '/../../../conformance/url.json'), true);
    }

    public static function urls(): iterable
    {
        foreach (self::fixture()['urls'] as $case) {
            yield json_encode($case['input']) => [$case['input'], null, $case['expect']];
        }
        foreach (self::fixture()['relative'] as $case) {
            yield json_encode([$case['input'], $case['base']]) => [$case['input'], $case['base'], $case['expect']];
        }
    }

    #[DataProvider('urls')]
    public function testUrl(string $input, ?string $base, ?array $expect): void
    {
        $url = Url::parse($input, $base);
        if ($expect === null) {
            $this->assertNull($url, "$input should not parse");
            return;
        }
        $this->assertNotNull($url, "$input should parse");
        $this->assertSame($expect, [
            'href' => $url->href(),
            'protocol' => $url->protocol,
            'username' => $url->username,
            'password' => $url->password,
            'hostname' => $url->hostname,
            'port' => $url->port,
            'host' => $url->host(),
            'origin' => $url->origin(),
            'pathname' => $url->pathname,
            'search' => $url->search,
            'hash' => $url->hash,
        ]);
    }

    public function testQueries(): void
    {
        foreach (self::fixture()['queries'] as $case) {
            $params = new SearchParams($case['input']);
            $pairs = [];
            foreach ($params as $name => $value) {
                $pairs[] = [(string) $name, $value];
            }
            $this->assertSame($case['pairs'], $pairs, $case['input']);
            $this->assertSame($case['string'], $params->toString(), $case['input']);
        }
        foreach (self::fixture()['written'] as $case) {
            $params = new SearchParams();
            foreach ($case['pairs'] as [$name, $value]) {
                $params->append($name, $value);
            }
            $this->assertSame($case['string'], $params->toString());
        }
    }

    public function testNumbers(): void
    {
        foreach (self::fixture()['numbers'] as $case) {
            $this->assertSame($case['text'], Json::number(is_string($case['n']) ? (float) $case['n'] : $case['n']), (string) $case['n']);
        }
    }

    public function testFloatDigitsAreVarExportsForEveryDouble(): void
    {
        $edges = [0.0, -0.0, 1.0, -1.0, 0.1, 1 / 3, 1e-7, 1.5e-7, 1e-6, 1e15, 1e16, 1e17, 1e21, 1e25, 1.2e25, 2.0 ** 53, 2.0 ** 53 + 2,
            12345678901234567890.0, 1e100, -1e-100, PHP_FLOAT_MAX, -PHP_FLOAT_MAX, PHP_FLOAT_MIN, PHP_FLOAT_EPSILON, 5e-324, -5e-324, INF, -INF, NAN];
        $values = $edges;
        mt_srand(53);
        for ($i = 0; $i < 200_000; $i++) {
            // Any bit pattern, and short decimals like the stats are made of.
            $values[] = unpack('E', pack('J', (mt_rand() << 32) ^ mt_rand() ^ (mt_rand() << 1)))[1];
            $values[] = mt_rand(-1_000_000, 1_000_000) / 10.0 ** mt_rand(0, 12);
        }
        $differ = [];
        foreach ([-1, 17, 14] as $precision) {
            $before = ini_set('serialize_precision', (string) $precision);
            try {
                foreach ($values as $n) {
                    if (Json::digits($n) !== var_export($n, true)) {
                        $differ[] = "$precision: " . var_export($n, true) . ' as ' . Json::digits($n);
                    }
                }
            } finally {
                ini_set('serialize_precision', (string) $before);
            }
        }
        $this->assertSame([], $differ);
    }

    public function testJsonMatchesJavaScript(): void
    {
        $this->assertSame('{"a":[],"b":{},"c":1,"d":0.5,"e":"/café ' . "\u{1F600}" . '","f":null}', Json::encode(['a' => [], 'b' => Json::object(), 'c' => 1.0, 'd' => 0.5, 'e' => "/caf\u{e9} \u{1F600}", 'f' => NAN]));
        $this->assertSame("\"\u{2028}\\n\\u0001\"", Json::encode("\u{2028}\n\x01"));
    }
}
