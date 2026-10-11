<?php
/**
 * The visitor's address, worked out by the plugin itself, so Runlight never
 * takes a header a visitor could have written as the address it counts and
 * limits by. The connection's address is the visitor's, unless it is this
 * machine or a private network, where a proxy on the same host or network
 * sits in front: then it is the nearest public address that proxy and any
 * before it recorded in X-Forwarded-For. Cloudflare's header is believed only
 * from Cloudflare's own addresses. The runlight_client_ip filter has the last
 * word, for hosts that know better.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Visitor {
	/**
	 * Cloudflare's addresses, from https://www.cloudflare.com/ips-v4 and
	 * https://www.cloudflare.com/ips-v6 (as of October 2026). Cloudflare
	 * rarely changes them; a host that needs others can use the filter.
	 */
	private const CLOUDFLARE = array(
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
	);

	/**
	 * The visitor's address for a request, or an empty string when there is
	 * none to tell.
	 *
	 * @param array<string,mixed> $server The request's $_SERVER, unslashed.
	 */
	public static function address( array $server ): string {
		$hop     = self::ip( $server['REMOTE_ADDR'] ?? '' );
		$chain   = isset( $server['HTTP_X_FORWARDED_FOR'] ) ? explode( ',', (string) $server['HTTP_X_FORWARDED_FOR'] ) : array();
		$address = $hop;
		// Each proxy adds the address it was reached from on the right, so from the right, past this machine's and the private network's.
		while ( '' !== $address && self::internal( $address ) && array() !== $chain ) {
			$next = self::ip( (string) array_pop( $chain ) );
			if ( '' === $next ) {
				break;
			}
			$address = $next;
		}
		if ( '' !== $address && self::cloudflare( $address ) ) {
			$visitor = self::ip( $server['HTTP_CF_CONNECTING_IP'] ?? '' );
			if ( '' !== $visitor ) {
				$address = $visitor;
			}
		}
		/**
		 * Filters the address Runlight counts a visitor by and limits requests by.
		 * It is hashed with a key that changes daily and never stored.
		 *
		 * @param string $address The address the plugin worked out.
		 * @param array  $server  The request's server variables.
		 */
		$filtered = apply_filters( 'runlight_client_ip', $address, $server );
		$filtered = is_string( $filtered ) ? self::ip( $filtered ) : '';
		return '' !== $filtered ? $filtered : $address;
	}

	/**
	 * An address as text, without the port or brackets a header may give it, or
	 * an empty string when it is not one.
	 *
	 * @param mixed $value A header's or variable's value.
	 */
	private static function ip( $value ): string {
		$value = trim( is_string( $value ) ? $value : '' );
		if ( preg_match( '/^\[([^\]]+)\](?::\d+)?$/', $value, $bracketed ) ) {
			$value = $bracketed[1];
		} elseif ( preg_match( '/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/', $value, $with_port ) ) {
			$value = $with_port[1];
		}
		// An IPv4 address written as IPv6, as some servers give it, is the IPv4 address.
		if ( preg_match( '/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i', $value, $mapped ) ) {
			$value = $mapped[1];
		}
		return false !== filter_var( $value, FILTER_VALIDATE_IP ) ? $value : '';
	}

	/**
	 * Whether an address is this machine's or a private network's, where a
	 * proxy in front of WordPress connects from.
	 *
	 * @param string $address An address.
	 */
	private static function internal( string $address ): bool {
		// 100.64.0.0/10, the shared range some hosts' own proxies use, counts too.
		return false === filter_var( $address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE )
			|| ( preg_match( '/^100\.(\d+)\./', $address, $shared ) && (int) $shared[1] >= 64 && (int) $shared[1] <= 127 );
	}

	/**
	 * Whether an address is one of Cloudflare's.
	 *
	 * @param string $address An address.
	 */
	private static function cloudflare( string $address ): bool {
		$bytes = inet_pton( $address );
		if ( false === $bytes ) {
			return false;
		}
		foreach ( self::CLOUDFLARE as $range ) {
			list( $base, $bits ) = explode( '/', $range );
			$network             = inet_pton( $base );
			if ( false === $network || strlen( $network ) !== strlen( $bytes ) ) {
				continue;
			}
			$bits  = (int) $bits;
			$whole = intdiv( $bits, 8 );
			if ( substr( $bytes, 0, $whole ) !== substr( $network, 0, $whole ) ) {
				continue;
			}
			$rest = $bits % 8;
			if ( 0 === $rest || ( ( ord( $bytes[ $whole ] ) ^ ord( $network[ $whole ] ) ) & ( 0xff << ( 8 - $rest ) ) & 0xff ) === 0 ) {
				return true;
			}
		}
		return false;
	}
}
