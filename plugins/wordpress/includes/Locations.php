<?php
/**
 * DB-IP's country data on disk, under the uploads folder, through
 * WordPress's filesystem API: the folder, unpacking the monthly download,
 * reading the database, and putting files in place or away.
 *
 * The database is read whole, a few megabytes, by the requests that look a
 * visitor up, so no file stays open between them.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

use Runlight\Mmdb;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Locations implements \Runlight\Server\DbIpFiles {
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
	 * Unpacks a gzipped download.
	 *
	 * @param string $from The gzipped file.
	 * @param string $to   Where the database goes.
	 * @throws \RuntimeException When it cannot.
	 */
	public function gunzip( string $from, string $to ): void {
		$packed   = Storage::files()->get_contents( $from );
		$unpacked = is_string( $packed ) ? gzdecode( $packed ) : false;
		unset( $packed );
		if ( ! is_string( $unpacked ) || ! Storage::files()->put_contents( $to, $unpacked, self::mode() ) ) {
			throw new \RuntimeException( 'could not unpack ' . esc_html( $from ) );
		}
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
