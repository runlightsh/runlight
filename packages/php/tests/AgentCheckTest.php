<?php

declare(strict_types=1);

namespace Runlight\Tests;

use PHPUnit\Framework\TestCase;
use Runlight\AgentCheck;
use Runlight\Data\Agents;
use Runlight\Http\Response;
use Runlight\Json;
use Runlight\Tests\Support\FakeFetcher;

/** Address checks for AI agents, as agentcheck.test.ts tests them. */
final class AgentCheckTest extends TestCase
{
    /** An address as [version, hex of its bytes], to compare with the TS test's numbers. */
    private static function address(string $text): ?array
    {
        $a = AgentCheck::parseAddress($text);
        return $a === null ? null : [$a['v'], bin2hex($a['bytes'])];
    }

    private static function agent(string $name): array
    {
        foreach (Agents::AI_AGENTS as $agent) {
            if ($agent['name'] === $name) {
                return $agent;
            }
        }
        throw new \LogicException("No agent $name");
    }

    public function testAddressesIpv4Ipv6Ipv4WrittenAsIpv6BracketsAndZonesAndJunk(): void
    {
        self::assertSame([4, '14abce11'], self::address('20.171.206.17'));
        self::assertSame([4, '14abce11'], self::address(' ::ffff:20.171.206.17 '));
        self::assertSame([4, '14abce11'], self::address('::ffff:14ab:ce11'));
        self::assertSame([6, '26001f28036580000000000000000001'], self::address('[2600:1f28:365:8000::1]'));
        self::assertSame([6, 'fe800000000000000000000000000001'], self::address('fe80::1%eth0'));
        self::assertSame([6, str_repeat('0', 32)], self::address('::'));
        foreach (['', 'unknown', '256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4x', '1::2::3', '12345::', ':1::', '1:2:3:4:5:6:7:8:9', '::ffff:1.2.3.256', '-', "1.2.3.4\n5", '1.2.3.4/32'] as $junk) {
            self::assertNull(self::address($junk), $junk);
        }
        // Surrounding space is trimmed as JavaScript's trim does, so a trailing newline still leaves the address.
        self::assertSame([4, '01020304'], self::address("1.2.3.4\n"));
    }

    public function testRangesPrefixesOfAnyLengthBothFamiliesAndHostBitsPastTheLengthIgnored(): void
    {
        $list = ['20.171.206.0/24', '34.162.230.222/32', '10.1.2.3/8', '2600:1f28:365:8000::/56', '0.0.0.0/0'];
        self::assertTrue(AgentCheck::inRanges('20.171.206.255', array_slice($list, 0, 1)));
        self::assertFalse(AgentCheck::inRanges('20.171.207.0', array_slice($list, 0, 1)));
        self::assertTrue(AgentCheck::inRanges('34.162.230.222', array_slice($list, 1, 1)));
        self::assertFalse(AgentCheck::inRanges('34.162.230.223', array_slice($list, 1, 1)));
        self::assertTrue(AgentCheck::inRanges('10.200.0.1', array_slice($list, 2, 1)), '10.1.2.3/8 covers all of 10/8');
        self::assertTrue(AgentCheck::inRanges('2600:1f28:365:80ff:ffff::1', array_slice($list, 3, 1)));
        self::assertFalse(AgentCheck::inRanges('2600:1f28:365:8100::1', array_slice($list, 3, 1)));
        self::assertFalse(AgentCheck::inRanges('20.171.206.1', array_slice($list, 3, 1)), 'an IPv4 address is never in an IPv6 prefix');
        self::assertTrue(AgentCheck::inRanges('203.0.113.9', array_slice($list, 4)), '/0 covers every IPv4 address');
        self::assertFalse(AgentCheck::inRanges('not an address', $list));
        // A length that is not a whole number of bytes.
        self::assertTrue(AgentCheck::inRanges('216.73.219.255', ['216.73.216.0/22']));
        self::assertFalse(AgentCheck::inRanges('216.73.220.0', ['216.73.216.0/22']));
    }

    public function testPublishedListsTheShapeEveryCompanyUsesAndAnythingElseRefusedWhole(): void
    {
        $read = static fn (string $json): ?array => AgentCheck::readRangeList(Json::decode($json));
        self::assertSame(['20.171.206.0/24', '2600:1f28::/56'], $read('{"creationTime": "x", "prefixes": [{"ipv4Prefix": "20.171.206.0/24"}, {"ipv6Prefix": " 2600:1f28::/56 "}]}'));
        foreach (['null', '[]', '"x"', '{}', '{"prefixes": []}', '{"prefixes": "1.2.3.0/24"}', '{"prefixes": [{"ipv4Prefix": "1.2.3.0"}]}', '{"prefixes": [{"ipv4Prefix": "1.2.3.0/33"}]}', '{"prefixes": [{"ipv4Prefix": "2600::/56"}]}', '{"prefixes": [{"ipv6Prefix": "1.2.3.0/24"}]}', '{"prefixes": [{"ipv4Prefix": "1.2.3.0/24"}, {"other": "x"}]}', '{"prefixes": [{"ipv4Prefix": "1.2.3.0/24"}, []]}', '{"prefixes": {"0": {"ipv4Prefix": "1.2.3.0/24"}}}'] as $bad) {
            self::assertNull($read($bad), $bad);
        }
        self::assertNull(AgentCheck::readRangeList(['prefixes' => array_fill(0, 20_001, ['ipv4Prefix' => '1.2.3.0/24'])]));
        self::assertCount(20_000, AgentCheck::readRangeList(['prefixes' => array_fill(0, 20_000, ['ipv4Prefix' => '1.2.3.0/24'])]));
    }

    public function testAnAgentChecksOutDoesNotOrHasNothingToCheckAgainst(): void
    {
        $gptbot = self::agent('GPTBot');
        $meta = self::agent('meta-externalagent');
        $lists = AgentCheck::bundled()['lists'];
        self::assertSame('verified', AgentCheck::checkAgent($gptbot, '20.171.206.17', $lists));
        self::assertSame('mismatch', AgentCheck::checkAgent($gptbot, '198.51.100.23', $lists));
        self::assertSame('', AgentCheck::checkAgent($gptbot, '', $lists), 'no address');
        self::assertSame('', AgentCheck::checkAgent($gptbot, 'garbage', $lists));
        self::assertSame('', AgentCheck::checkAgent($meta, '157.240.0.1', $lists), 'Meta publishes no list');
        self::assertSame('', AgentCheck::checkAgent($gptbot, '20.171.206.17', []), 'a list that is missing is nothing to check against');
        self::assertSame('verified', AgentCheck::checkAgent(self::agent('ClaudeBot'), '216.73.216.10', $lists));
        self::assertSame('verified', AgentCheck::checkAgent(self::agent('CCBot'), '2600:1f28:365:8000::5', $lists));
    }

    public function testEveryAgentWithAListHasItBundledAndEveryBundledListIsReadWhole(): void
    {
        $lists = AgentCheck::bundled()['lists'];
        $without = [];
        foreach (Agents::AI_AGENTS as $agent) {
            if (isset($agent['ranges'])) {
                self::assertNotEmpty($lists[$agent['ranges']] ?? [], "{$agent['name']}: {$agent['ranges']}");
            } else {
                $without[] = $agent['company'];
            }
        }
        self::assertSame(['Meta', 'Amazon', 'ByteDance', 'Cohere', 'You.com', 'Diffbot', 'Timpi'], array_values(array_unique($without)));
        foreach ($lists as $url => $list) {
            $again = AgentCheck::readRangeList(['prefixes' => array_map(static fn (string $p): array => str_contains($p, ':') ? ['ipv6Prefix' => $p] : ['ipv4Prefix' => $p], $list)]);
            self::assertSame($list, $again, $url);
        }
    }

    public function testADownloadIsReadWholeOrNotAtAll(): void
    {
        $fetcher = new FakeFetcher(static fn (string $url): Response => match ($url) {
            'https://good.example/' => Response::json(['prefixes' => [['ipv4Prefix' => '192.0.2.0/24']]]),
            'https://missing.example/' => new Response('', 404),
            'https://huge.example/' => new Response('{}', 200, ['content-length' => '4000001']),
            default => new Response('not json'),
        });
        self::assertSame(['192.0.2.0/24'], AgentCheck::downloadRangeList($fetcher, 'https://good.example/'));
        self::assertNull(AgentCheck::downloadRangeList($fetcher, 'https://missing.example/'));
        self::assertNull(AgentCheck::downloadRangeList($fetcher, 'https://huge.example/'));
        self::assertNull(AgentCheck::downloadRangeList($fetcher, 'https://junk.example/'));
        self::assertSame(['accept' => 'application/json', 'user-agent' => 'Runlight (+https://runlight.sh)'], $fetcher->requests[0]['headers']);
        self::assertSame(['follow', 15_000, 4_000_000], [$fetcher->inits[0]['redirect'], $fetcher->inits[0]['timeoutMs'], $fetcher->inits[0]['maxBytes']]);
    }
}
