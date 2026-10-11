<?php
/**
 * The small values Runlight shares between requests, kept by WordPress: in
 * its object cache when the site has a persistent one, or else as
 * transients. These are tracker counts per visitor address, hashed with a key
 * that changes daily and kept for two minutes, that key, the site's icon for
 * the dashboard, and a note that a warning was logged today.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Cache implements \Runlight\Cache {
	/** The object cache group. */
	private const GROUP = 'runlight';

	/**
	 * The name a value has in WordPress: short enough for a transient, whatever the key.
	 *
	 * @param string $key Runlight's key.
	 */
	private static function name( string $key ): string {
		return 'runlight_' . md5( $key );
	}

	/**
	 * Values go in as text the database keeps as it is: UTF-8 as it is, other bytes in hex.
	 *
	 * @param string $value A value.
	 */
	private static function pack( string $value ): string {
		return mb_check_encoding( $value, 'UTF-8' ) ? 't' . $value : 'h' . bin2hex( $value );
	}

	/**
	 * A value as it went in, or null.
	 *
	 * @param mixed $packed What WordPress kept.
	 */
	private static function unpack( $packed ): ?string {
		if ( ! is_string( $packed ) || '' === $packed ) {
			return null;
		}
		if ( 'h' === $packed[0] ) {
			$bytes = preg_match( '/^h(?:[0-9a-f]{2})*$/D', $packed ) ? hex2bin( substr( $packed, 1 ) ) : false;
			return false === $bytes ? null : $bytes;
		}
		return substr( $packed, 1 );
	}

	/**
	 * The value at a key, or null.
	 *
	 * @param string $key The key.
	 */
	public function get( string $key ): ?string {
		if ( wp_using_ext_object_cache() ) {
			return self::unpack( wp_cache_get( self::name( $key ), self::GROUP ) );
		}
		return self::unpack( get_transient( self::name( $key ) ) );
	}

	/**
	 * Keeps a value for a while.
	 *
	 * @param string $key     The key.
	 * @param string $value   The value.
	 * @param int    $seconds How long it is kept.
	 */
	public function set( string $key, string $value, int $seconds ): void {
		if ( wp_using_ext_object_cache() ) {
			wp_cache_set( self::name( $key ), self::pack( $value ), self::GROUP, $seconds );
			return;
		}
		set_transient( self::name( $key ), self::pack( $value ), $seconds );
	}

	/**
	 * Keeps a value only when there is none yet, and says whether it did.
	 *
	 * @param string $key     The key.
	 * @param string $value   The value.
	 * @param int    $seconds How long it is kept.
	 */
	public function add( string $key, string $value, int $seconds ): bool {
		if ( wp_using_ext_object_cache() ) {
			return wp_cache_add( self::name( $key ), self::pack( $value ), self::GROUP, $seconds );
		}
		if ( false !== get_transient( self::name( $key ) ) ) {
			return false;
		}
		return set_transient( self::name( $key ), self::pack( $value ), $seconds );
	}

	/**
	 * Adds one to a count: the new count, or null when it cannot count. A
	 * persistent object cache counts atomically; transients count nearly, as
	 * two requests at the same moment may count once between them, which a
	 * limit of 120 a minute can bear.
	 *
	 * @param string $key     The key.
	 * @param int    $seconds How long the count lasts from the first.
	 */
	public function increment( string $key, int $seconds ): ?int {
		$name = self::name( $key );
		if ( wp_using_ext_object_cache() ) {
			wp_cache_add( $name, 0, self::GROUP, $seconds );
			$count = wp_cache_incr( $name, 1, self::GROUP );
			return false === $count ? null : (int) $count;
		}
		$count = (int) get_transient( $name ) + 1;
		return set_transient( $name, $count, $seconds ) ? $count : null;
	}
}
