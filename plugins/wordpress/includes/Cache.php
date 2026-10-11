<?php
/**
 * The small values Runlight shares between requests, kept by WordPress: in
 * its object cache when the site has a persistent one, or else as
 * transients. These are tracker counts per visitor address, hashed with a key
 * that changes daily and kept for two minutes, that key, the site's icon for
 * the dashboard, and a note that a warning was logged today.
 *
 * Transients live in wp_options, and an expired one stays there until it is
 * read again or WordPress's daily cleanup runs, which never happens with its
 * cron off. So without an object cache the rate limit's values take two
 * transients of fixed names, whatever the address and minute: one holding
 * the current minute's counts, at most a few hundred of them, and one holding
 * the day's key, each replaced when its minute or day is over.
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

	/** What the rate limit's keys start with: then the minute and the hashed address, or "key:" and the day. */
	private const RATE = 'runlight:rl:';

	/** The transient holding the current minute's counts. */
	private const COUNTS = 'runlight_rate';

	/** The transient holding the day's key for the counts. */
	private const DAY_KEY = 'runlight_rate_key';

	/** The most addresses counted in one minute; past that, each request counts on its own. */
	private const MOST = 500;

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
		if ( str_starts_with( $key, self::RATE . 'key:' ) ) {
			$kept = get_transient( self::DAY_KEY );
			return is_array( $kept ) && ( $kept['key'] ?? null ) === $key ? self::unpack( $kept['value'] ?? null ) : null;
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
		if ( str_starts_with( $key, self::RATE . 'key:' ) ) {
			self::keep_day_key( $key, $value, $seconds );
			return;
		}
		set_transient( self::name( $key ), self::pack( $value ), $seconds );
	}

	/**
	 * Keeps the day's key in place of any earlier day's.
	 *
	 * @param string $key     The key's name, with its day.
	 * @param string $value   The key.
	 * @param int    $seconds How long it is kept.
	 */
	private static function keep_day_key( string $key, string $value, int $seconds ): bool {
		return set_transient(
			self::DAY_KEY,
			array(
				'key'   => $key,
				'value' => self::pack( $value ),
			),
			$seconds
		);
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
		if ( str_starts_with( $key, self::RATE . 'key:' ) ) {
			return null === $this->get( $key ) && self::keep_day_key( $key, $value, $seconds );
		}
		if ( false !== get_transient( self::name( $key ) ) ) {
			return false;
		}
		return set_transient( self::name( $key ), self::pack( $value ), $seconds );
	}

	/**
	 * Adds one to a count: the new count, or null when it cannot count. A
	 * persistent object cache counts atomically. Otherwise the counts for one
	 * minute share a transient, and count nearly, as two requests at the same
	 * moment may count once between them, which a limit of 120 a minute can
	 * bear. A new minute starts it afresh, and past MOST addresses a new one
	 * is not counted here.
	 *
	 * @param string $key     The key: the minute, then a colon and the hashed address.
	 * @param int    $seconds How long the count lasts.
	 */
	public function increment( string $key, int $seconds ): ?int {
		if ( wp_using_ext_object_cache() ) {
			$name = self::name( $key );
			wp_cache_add( $name, 0, self::GROUP, $seconds );
			$count = wp_cache_incr( $name, 1, self::GROUP );
			return false === $count ? null : (int) $count;
		}
		$split = strrpos( $key, ':' );
		if ( false === $split ) {
			return null;
		}
		$window = substr( $key, 0, $split );
		$id     = substr( $key, $split + 1 );
		$kept   = get_transient( self::COUNTS );
		$counts = is_array( $kept ) && ( $kept['window'] ?? null ) === $window && is_array( $kept['counts'] ?? null ) ? $kept['counts'] : array();
		if ( ! isset( $counts[ $id ] ) && count( $counts ) >= self::MOST ) {
			return null;
		}
		$counts[ $id ] = (int) ( $counts[ $id ] ?? 0 ) + 1;
		$saved         = set_transient(
			self::COUNTS,
			array(
				'window' => $window,
				'counts' => $counts,
			),
			$seconds
		);
		return $saved ? $counts[ $id ] : null;
	}

	/**
	 * Deletes the rate limit's transients once their minute or day is over,
	 * which the hourly check does, so no hashed address outlives its day.
	 */
	public static function sweep(): void {
		if ( wp_using_ext_object_cache() ) {
			return;
		}
		// Reading an expired transient deletes it.
		get_transient( self::COUNTS );
		$kept = get_transient( self::DAY_KEY );
		$day  = (int) floor( time() / DAY_IN_SECONDS );
		if ( is_array( $kept ) && self::RATE . 'key:' . $day !== ( $kept['key'] ?? null ) ) {
			delete_transient( self::DAY_KEY );
		}
	}
}
