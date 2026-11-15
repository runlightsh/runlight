<?php
/**
 * DB-IP's country data on disk, under the uploads folder, through
 * WordPress's filesystem API: the folder, unpacking the monthly download,
 * reading the database, and putting files in place or away.
 *
 * The database is read whole, a few megabytes, by the requests that look a
 * visitor up, so no file stays open between them. The plugin only ever asks
 * for the country database, so a download far past its size is refused here
 * before any of it is held in memory.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

use Runlight\Mmdb;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Locations implements \Runlight\Server\DbIpFiles {
	/** The most a packed download may be to be unpacked here: 32 MiB, where DB-IP's country file is about 4. */
	private const MAX_PACKED = 33554432;

	/** The most it may unpack to here: 64 MiB, where DB-IP's country database is about 9. */
	private const MAX_UNPACKED = 67108864;

	/** The mode files are written with: WordPress's, when it has set one. */
	private static function mode(): int {
		return defined( 'FS_CHMOD_FILE' ) ? FS_CHMOD_FILE : 0644;
	}

	/**
	 * Makes the folder, and says whether it is there.
	 *
	 * @param string $dir The folder.
	 */
	public function folder( string $dir ): bool {
		return wp_mkdir_p( $dir );
	}

	/**
	 * Unpacks a gzipped download, a piece at a time, and says what it holds:
	 * the SHA-1 of the unpacked bytes, which the package compares with the one
	 * DB-IP publishes. Nothing is written unless the gzip stream ends as it
	 * should, with nothing after it, and stays within the limits. What it
	 * throws is worded as the package's own unpacking is, since the message
	 * is the reason in the log line.
	 *
	 * @param string $from The gzipped file.
	 * @param string $to   Where the database goes.
	 * @param int    $max  The most bytes it may unpack to.
	 * @return string The SHA-1 of the unpacked bytes, in lower-case hex.
	 * @throws \RuntimeException When it is cut short, has bytes after its end, is too big, or cannot be read or written.
	 */
	public function gunzip( string $from, string $to, int $max ): string {
		$max  = min( $max, self::MAX_UNPACKED );
		$size = Storage::files()->size( $from );
		if ( ! is_int( $size ) || $size > self::MAX_PACKED ) {
			throw new \RuntimeException( 'the location data is more than ' . (int) ( self::MAX_PACKED / 1048576 ) . ' MB packed' );
		}
		$packed  = Storage::files()->get_contents( $from );
		$inflate = is_string( $packed ) ? inflate_init( ZLIB_ENCODING_GZIP ) : false;
		if ( ! is_string( $packed ) || false === $inflate ) {
			throw new \RuntimeException( 'could not unpack ' . esc_html( $from ) );
		}
		$hash     = hash_init( 'sha1' );
		$unpacked = '';
		$length   = strlen( $packed );
		// Small pieces, so one that unpacks a thousandfold, as zeros do, is a few megabytes before it is counted.
		$step = 4096;
		for ( $at = 0; $at < $length && ZLIB_STREAM_END !== inflate_get_status( $inflate ); $at += $step ) {
			// A stream that is not gzip, or is damaged, makes PHP warn as well as answer false.
			$piece = @inflate_add( $inflate, substr( $packed, $at, $step ) ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- the failure is thrown just below.
			if ( false === $piece ) {
				throw new \RuntimeException( 'it is not a gzip file' );
			}
			if ( strlen( $unpacked ) + strlen( $piece ) > $max ) {
				throw new \RuntimeException( 'the location data is more than ' . (int) ( $max / 1048576 ) . ' MB' );
			}
			hash_update( $hash, $piece );
			$unpacked .= $piece;
		}
		if ( ZLIB_STREAM_END !== inflate_get_status( $inflate ) ) {
			throw new \RuntimeException( 'the gzip stream stops before its end' );
		}
		if ( inflate_get_read_len( $inflate ) !== $length ) {
			throw new \RuntimeException( 'there is more in it after the end of the gzip stream' );
		}
		unset( $packed );
		if ( ! Storage::files()->put_contents( $to, $unpacked, self::mode() ) ) {
			throw new \RuntimeException( 'the unpacked database could not be written' );
		}
		return hash_final( $hash );
	}

	/**
	 * The database in a file.
	 *
	 * @param string $file The file.
	 * @throws \RuntimeException When it cannot be read.
	 */
	public function open( string $file ): Mmdb {
		$bytes = Storage::files()->get_contents( $file );
		if ( ! is_string( $bytes ) ) {
			throw new \RuntimeException( 'Could not read ' . esc_html( $file ) );
		}
		return new Mmdb( $bytes );
	}

	/**
	 * Puts a file in place.
	 *
	 * @param string $from The file.
	 * @param string $to   Its new name.
	 * @throws \RuntimeException When it cannot.
	 */
	public function move( string $from, string $to ): void {
		if ( ! Storage::files()->move( $from, $to, true ) ) {
			throw new \RuntimeException( 'could not move ' . esc_html( $from ) );
		}
	}

	/**
	 * Deletes a file, when it is there.
	 *
	 * @param string $file The file.
	 */
	public function delete( string $file ): void {
		wp_delete_file( $file );
	}
}
