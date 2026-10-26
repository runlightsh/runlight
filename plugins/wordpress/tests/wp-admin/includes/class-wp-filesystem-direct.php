<?php
/**
 * Stand-in for WordPress's direct filesystem, with the calls the plugin
 * makes, for its tests. Not part of the zip.
 *
 * @package Runlight
 */

// phpcs:ignoreFile -- test scaffolding, never shipped.

class WP_Filesystem_Direct extends WP_Filesystem_Base {
	public function __construct( $arg ) {}

	public function get_contents( $file ) {
		return @file_get_contents( $file );
	}

	public function put_contents( $file, $contents, $mode = false ) {
		if ( false === @file_put_contents( $file, $contents ) ) {
			return false;
		}
		if ( $mode ) {
			chmod( $file, $mode );
		}
		return true;
	}

	public function chmod( $file, $mode = false, $recursive = false ) {
		return chmod( $file, $mode );
	}

	public function move( $source, $destination, $overwrite = false ) {
		return rename( $source, $destination );
	}

	public function rmdir( $path, $recursive = false ) {
		if ( $recursive && is_dir( $path ) ) {
			foreach ( new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $path, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST ) as $entry ) {
				$entry->isDir() ? rmdir( $entry->getPathname() ) : unlink( $entry->getPathname() );
			}
		}
		return rmdir( $path );
	}
}
