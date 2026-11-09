<?php

declare(strict_types=1);

namespace Runlight;

use Runlight\Http\Fetcher;

/**
 * Checks a request that names an AI agent against the addresses that agent's company publishes. Every
 * list is in the same shape, {"prefixes": [{"ipv4Prefix": "a.b.c.d/n"} or {"ipv6Prefix": "x::/n"}]}.
 *
 * The answer is "verified" when the address is in the list, "mismatch" when the company publishes a list
 * and the address is not in it, and "" when there is nothing to check against: no list for that agent,
 * or no usable address. The address is only compared, never kept.
 *
 * Addresses are held as their bytes (4 for IPv4, 16 for IPv6), so IPv6 needs no big numbers.
 *
 * @phpstan-type Address array{v: 4|6, bytes: string}
 */
final class AgentCheck
{
    /** A list of more prefixes than this, or a reply bigger than MAX_LIST_BYTES, is not a list we read. */
    public const MAX_PREFIXES = 20_000;
    public const MAX_LIST_BYTES = 4_000_000;

    /** @var array{fetchedAt: string, lists: array<string, list<string>>}|null */
    private static ?array $bundled = null;

    /**
     * The lists that came with this version, from assets/agent-ranges.json, which scripts/php-assets.mts
     * writes from the TypeScript SDK's snapshot.
     *
     * @return array{fetchedAt: string, lists: array<string, list<string>>}
     */
    public static function bundled(): array
    {
        if (self::$bundled === null) {
            $text = @file_get_contents(__DIR__ . '/../assets/agent-ranges.json');
            if ($text === false) {
                throw new \RuntimeException('Runlight: assets/agent-ranges.json is missing; run npm run php-assets.');
            }
            $data = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
            self::$bundled = ['fetchedAt' => (string) $data['fetchedAt'], 'lists' => $data['lists']];
        }
        return self::$bundled;
    }

    /** An IPv4 address as 4 bytes, or null. */
    private static function ipv4(string $text): ?string
    {
        $parts = explode('.', $text);
        if (count($parts) !== 4) {
            return null;
        }
        $bytes = '';
        foreach ($parts as $part) {
            if (!preg_match('/^\d{1,3}$/D', $part)) {
                return null;
            }
            $byte = (int) $part;
            if ($byte > 255) {
                return null;
            }
            $bytes .= chr($byte);
        }
        return $bytes;
    }

    /** An IPv6 address as 16 bytes, or null. */
    private static function ipv6(string $text): ?string
    {
        if (!preg_match('/^[0-9a-f:.]+$/iD', $text) || count(explode('::', $text)) > 2) {
            return null;
        }
        // A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
        $groups = $text;
        $colon = strrpos($text, ':');
        if (str_contains($text, '.')) {
            $tail = self::ipv4(substr($text, $colon === false ? 0 : $colon + 1));
            if ($tail === null || $colon === false) {
                return null;
            }
            $groups = substr($text, 0, $colon + 1) . bin2hex(substr($tail, 0, 2)) . ':' . bin2hex(substr($tail, 2, 2));
        }
        $halves = explode('::', $groups);
        $head = $halves[0];
        $rest = $halves[1] ?? null;
        $left = $head !== '' ? explode(':', $head) : [];
        $right = $rest === null ? [] : ($rest !== '' ? explode(':', $rest) : []);
        $missing = 8 - count($left) - count($right);
        if ($rest === null ? $missing !== 0 : $missing < 1) {
            return null;
        }
        $all = [...$left, ...array_fill(0, $rest === null ? 0 : $missing, '0'), ...$right];
        $bytes = '';
        foreach ($all as $group) {
            if (!preg_match('/^[0-9a-f]{1,4}$/iD', $group)) {
                return null;
            }
            $bytes .= pack('n', hexdec($group));
        }
        return $bytes;
    }

    /**
     * An address as the check reads it: surrounding space, [brackets], and an IPv6 zone ("%eth0") are
     * ignored, and an IPv4 address written as IPv6 (::ffff:1.2.3.4) is read as IPv4. Null when it is not one.
     *
     * @return Address|null
     */
    public static function parseAddress(string $text): ?array
    {
        $s = Js::trim($text);
        if (str_starts_with($s, '[') && str_ends_with($s, ']')) {
            $s = substr($s, 1, -1);
        }
        $zone = strpos($s, '%');
        if ($zone !== false) {
            $s = substr($s, 0, $zone);
        }
        if ($s === '') {
            return null;
        }
        if (!str_contains($s, ':')) {
            $bytes = self::ipv4($s);
            return $bytes === null ? null : ['v' => 4, 'bytes' => $bytes];
        }
        $bytes = self::ipv6($s);
        if ($bytes === null) {
            return null;
        }
        if (substr($bytes, 0, 12) === str_repeat("\0", 10) . "\xff\xff") {
            return ['v' => 4, 'bytes' => substr($bytes, 12)];
        }
        return ['v' => 6, 'bytes' => $bytes];
    }

    /**
     * A prefix such as 20.171.206.0/24 or 2600:1f28::/56, or null. Bits past the length are ignored.
     *
     * @return array{v: 4|6, bytes: string, bits: int}|null
     */
    private static function parsePrefix(string $text): ?array
    {
        $slash = strpos($text, '/');
        if ($slash === false) {
            return null;
        }
        $bitsText = substr($text, $slash + 1);
        if (!preg_match('/^\d{1,3}$/D', $bitsText)) {
            return null;
        }
        $bits = (int) $bitsText;
        $head = substr($text, 0, $slash);
        if (str_contains($head, ':')) {
            $bytes = self::ipv6($head);
            return $bytes === null || $bits > 128 ? null : ['v' => 6, 'bytes' => $bytes, 'bits' => $bits];
        }
        $bytes = self::ipv4($head);
        return $bytes === null || $bits > 32 ? null : ['v' => 4, 'bytes' => $bytes, 'bits' => $bits];
    }

    /**
     * @param array{v: 4|6, bytes: string, bits: int} $prefix
     * @param Address $address
     */
    private static function covers(array $prefix, array $address): bool
    {
        if ($prefix['v'] !== $address['v']) {
            return false;
        }
        $whole = intdiv($prefix['bits'], 8);
        if (substr($prefix['bytes'], 0, $whole) !== substr($address['bytes'], 0, $whole)) {
            return false;
        }
        $left = $prefix['bits'] % 8;
        if ($left === 0) {
            return true;
        }
        $mask = (0xff << (8 - $left)) & 0xff;
        return (ord($prefix['bytes'][$whole]) & $mask) === (ord($address['bytes'][$whole]) & $mask);
    }

    /**
     * The prefixes in a published list, or null when the reply is not a list in the expected shape (not an
     * object, no prefixes, an entry that is not a prefix, or too many). One bad entry rejects the whole list,
     * so a half broken download never replaces a good copy. Takes JSON decoded either way: objects as
     * stdClass or as string-keyed arrays.
     *
     * @return list<string>|null
     */
    public static function readRangeList(mixed $body): ?array
    {
        $body = self::object($body);
        if ($body === null) {
            return null;
        }
        $prefixes = $body['prefixes'] ?? null;
        if (!is_array($prefixes) || !array_is_list($prefixes) || $prefixes === [] || count($prefixes) > self::MAX_PREFIXES) {
            return null;
        }
        $out = [];
        foreach ($prefixes as $entry) {
            $entry = self::object($entry) ?? (is_array($entry) ? [] : null);
            if ($entry === null) {
                return null;
            }
            $v4 = $entry['ipv4Prefix'] ?? null;
            $v6 = $entry['ipv6Prefix'] ?? null;
            $text = is_string($v4) ? $v4 : (is_string($v6) ? $v6 : null);
            if ($text === null) {
                return null;
            }
            $trimmed = Js::trim($text);
            $prefix = self::parsePrefix($trimmed);
            if ($prefix === null || is_string($v4) !== ($prefix['v'] === 4)) {
                return null;
            }
            $out[] = $trimmed;
        }
        return $out;
    }

    /** @return array<string, mixed>|null a JSON object's members, or null when it is not an object */
    private static function object(mixed $value): ?array
    {
        if ($value instanceof \stdClass) {
            return get_object_vars($value);
        }
        if (is_array($value) && $value !== [] && !array_is_list($value)) {
            return $value;
        }
        return null;
    }

    /**
     * Downloads one published list. Null when it cannot be fetched or read; the caller keeps what it had.
     *
     * @return list<string>|null
     */
    public static function downloadRangeList(Fetcher $fetcher, string $url, int $timeoutMs = 15_000): ?array
    {
        try {
            $response = $fetcher->fetch($url, [
                'headers' => ['accept' => 'application/json', 'user-agent' => 'Runlight (+https://runlight.sh)'],
                'redirect' => 'follow',
                'timeoutMs' => $timeoutMs,
                'maxBytes' => self::MAX_LIST_BYTES,
            ]);
            if (!$response->ok()) {
                return null;
            }
            $length = (float) ($response->headers->get('content-length') ?? 0);
            if ($length > self::MAX_LIST_BYTES) {
                return null;
            }
            $text = $response->text();
            if (strlen($text) > self::MAX_LIST_BYTES) {
                return null;
            }
            return self::readRangeList(json_decode($text, false, 512, JSON_THROW_ON_ERROR));
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * Whether `ip` is inside any of the prefixes. False for an address that cannot be read.
     *
     * @param list<string> $list
     */
    public static function inRanges(string $ip, array $list): bool
    {
        $address = self::parseAddress($ip);
        if ($address === null) {
            return false;
        }
        foreach ($list as $text) {
            $prefix = self::parsePrefix((string) $text);
            if ($prefix !== null && self::covers($prefix, $address)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The check for one request that names `agent`, made from `ip` (see the top of this file).
     *
     * @param array{ranges?: string} $agent an entry of Data\Agents::AI_AGENTS
     * @param array<string, list<string>> $lists
     * @return 'verified'|'mismatch'|''
     */
    public static function checkAgent(array $agent, string $ip, array $lists): string
    {
        $list = isset($agent['ranges']) ? ($lists[$agent['ranges']] ?? null) : null;
        if ($list === null || self::parseAddress($ip) === null) {
            return '';
        }
        return self::inRanges($ip, $list) ? 'verified' : 'mismatch';
    }
}
