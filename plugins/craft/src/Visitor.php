<?php

declare(strict_types=1);

namespace Runlight\Craft;

/**
 * The visitor's address, worked out by the plugin itself while Craft's `trustedHosts` is left at its default,
 * which believes forwarded headers from anyone, so Runlight never takes a header a visitor could have written
 * as the address it counts and limits by. The connection's address is the visitor's, unless it is this
 * machine or a private network, where a proxy on the same host or network sits in front: then it is the
 * nearest public address that proxy and any before it recorded in X-Forwarded-For. Cloudflare's header is
 * believed only from Cloudflare's own addresses. A site that sets `trustedHosts` knows better, and Craft's
 * own answer is used instead.
 */
final class Visitor
{
    /**
     * Cloudflare's addresses, from https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
     * (as of October 2026). Cloudflare rarely changes them; a site that needs others can set `trustedHosts`.
     */
    private const CLOUDFLARE = [
        '173.245.48.0/20',
        '103.21.244.0/22',
        '103.22.200.0/22',
        '103.31.4.0/22',
        '141.101.64.0/18',
        '108.162.192.0/18',
        '190.93.240.0/20',
        '188.114.96.0/20',
        '197.234.240.0/22',
        '198.41.128.0/17',
        '162.158.0.0/15',
        '104.16.0.0/13',
        '104.24.0.0/14',
        '172.64.0.0/13',
        '131.0.72.0/22',
        '2400:cb00::/32',
        '2606:4700::/32',
        '2803:f800::/32',
        '2405:b500::/32',
        '2405:8100::/32',
        '2a06:98c0::/29',
        '2c0f:f248::/32',
    ];

    /**
     * The visitor's address for a Craft request, or an empty string when there is none to tell: Craft's
     * own when the site has set `trustedHosts`, else the plugin's.
     *
     * @param array<string,list<string>> $headers The request's headers, by lower-case name.
     */
    public static function of(\craft\web\Request $request, array $headers): string
    {
        if (!self::trustsAnyone($request->trustedHosts)) {
            return (string) $request->getUserIP();
        }
        return self::address((string) $request->getRemoteIP(), $headers);
    }

    /**
     * Whether `trustedHosts` believes forwarded headers from any address, as Craft's default `['any']` does.
     * Yii names every address 'any', or '*', and takes a range as either a key or a value.
     *
     * @param array<int|string,mixed> $trustedHosts
     */
    public static function trustsAnyone(array $trustedHosts): bool
    {
        foreach ($trustedHosts as $range => $headers) {
            $range = is_array($headers) ? $range : $headers;
            if (in_array($range, ['any', '*'], true)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The visitor's address from the connection's address and the request's headers, or an empty string
     * when there is none to tell.
     *
     * @param array<string,list<string>> $headers The request's headers, by lower-case name.
     */
    public static function address(string $remote, array $headers): string
    {
        return self::resolve($remote, $headers)[0];
    }

    /**
     * Whether the request came through Cloudflare, by the same check that lets its CF-Connecting-IP header name
     * the visitor: the connection is from one of Cloudflare's own addresses. Only then are its location headers real.
     *
     * @param array<string,list<string>> $headers The request's headers, by lower-case name.
     */
    public static function fromCloudflare(string $remote, array $headers): bool
    {
        return self::resolve($remote, $headers)[1];
    }

    /**
     * The visitor's address, and whether Cloudflare's header was believed for it.
     *
     * @param array<string,list<string>> $headers The request's headers, by lower-case name.
     * @return array{string, bool}
     */
    private static function resolve(string $remote, array $headers): array
    {
        $hop = self::ip($remote);
        $forwarded = implode(',', $headers['x-forwarded-for'] ?? []);
        $chain = $forwarded !== '' ? explode(',', $forwarded) : [];
        $address = $hop;
        // Each proxy adds the address it was reached from on the right, so from the right, past this machine's and the private network's.
        while ($address !== '' && self::internal($address) && $chain !== []) {
            $next = self::ip((string) array_pop($chain));
            if ($next === '') {
                break;
            }
            $address = $next;
        }
        $cloudflare = $address !== '' && self::cloudflare($address);
        if ($cloudflare) {
            $visitor = self::ip($headers['cf-connecting-ip'][0] ?? '');
            if ($visitor !== '') {
                $address = $visitor;
            }
        }
        return [$address, $cloudflare];
    }

    /** An address as text, without the port or brackets a header may give it, or an empty string when it is not one. */
    private static function ip(string $value): string
    {
        $value = trim($value);
        if (preg_match('/^\[([^\]]+)\](?::\d+)?$/D', $value, $bracketed)) {
            $value = $bracketed[1];
        } elseif (preg_match('/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/D', $value, $withPort)) {
            $value = $withPort[1];
        }
        // An IPv4 address written as IPv6, as some servers give it, is the IPv4 address.
        if (preg_match('/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iD', $value, $mapped)) {
            $value = $mapped[1];
        }
        return filter_var($value, FILTER_VALIDATE_IP) !== false ? $value : '';
    }

    /** Whether an address is this machine's or a private network's, where a proxy in front of Craft connects from. */
    private static function internal(string $address): bool
    {
        // 100.64.0.0/10, the shared range some hosts' own proxies use, counts too.
        return filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false
            || (preg_match('/^100\.(\d+)\./', $address, $shared) && (int) $shared[1] >= 64 && (int) $shared[1] <= 127);
    }

    /** Whether an address is one of Cloudflare's. */
    private static function cloudflare(string $address): bool
    {
        $bytes = inet_pton($address);
        if ($bytes === false) {
            return false;
        }
        foreach (self::CLOUDFLARE as $range) {
            [$base, $bits] = explode('/', $range);
            $network = inet_pton($base);
            if ($network === false || strlen($network) !== strlen($bytes)) {
                continue;
            }
            $bits = (int) $bits;
            $whole = intdiv($bits, 8);
            if (substr($bytes, 0, $whole) !== substr($network, 0, $whole)) {
                continue;
            }
            $rest = $bits % 8;
            if ($rest === 0 || ((ord($bytes[$whole]) ^ ord($network[$whole])) & (0xff << (8 - $rest)) & 0xff) === 0) {
                return true;
            }
        }
        return false;
    }
}
