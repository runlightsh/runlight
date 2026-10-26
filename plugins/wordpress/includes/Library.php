<?php
/**
 * Runlight itself, the PHP package runlight/runlight the plugin carries under
 * vendor/runlight/runlight, for running
 * Runlight inside this WordPress: whether this server can run it, and loading
 * its classes when it can.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Library {
	/** The PHP the package needs, which is newer than the plugin's own. */
	private const PHP = '8.2';

	/** Where the package is, vendor/runlight/runlight in the plugin, or an empty string when it is missing. */
	private static function folder(): string {
		$package = dirname( __DIR__ ) . '/vendor/runlight/runlight';
		return is_dir( $package . '/src' ) ? $package : '';
	}

	/**
	 * What stops Runlight running in this WordPress, in a sentence for the
	 * settings page, or an empty string when nothing does.
	 */
	public static function missing(): string {
		if ( version_compare( PHP_VERSION, self::PHP, '<' ) ) {
			/* translators: 1: the PHP version needed, 2: the PHP version running */
			return sprintf( __( 'Running Runlight in this WordPress needs PHP %1$s or later, and this server runs %2$s.', 'runlight' ), self::PHP, PHP_VERSION );
		}
		foreach ( array( 'mbstring', 'openssl' ) as $extension ) {
			if ( ! extension_loaded( $extension ) ) {
				/* translators: %s: a PHP extension, such as mbstring */
				return sprintf( __( 'Running Runlight in this WordPress needs PHP’s %s extension, which this server does not have.', 'runlight' ), $extension );
			}
		}
		if ( '' === self::folder() ) {
			return __( 'This copy of the plugin is missing its vendor folder. Install it again from WordPress.org.', 'runlight' );
		}
		if ( '' === Storage::kind() ) {
			// Each site in a network keeps a file of its own, never tables in the network's database.
			return is_multisite()
				? __( 'Running Runlight in a site of a network needs PHP’s sqlite3 extension, which this server does not have.', 'runlight' )
				: __( 'Running Runlight in this WordPress needs WordPress’s database on MySQL 8.0.20 or MariaDB 11.4 or later, or else PHP’s sqlite3 extension, and this server has neither.', 'runlight' );
		}
		return '';
	}

	/** Whether Runlight can run in this WordPress. */
	public static function available(): bool {
		static $available = null;
		$available ??= '' === self::missing();
		return $available;
	}

	/** Lets PHP find the package's classes, once, the first time they are needed. */
	public static function load(): void {
		static $loaded = false;
		if ( $loaded ) {
			return;
		}
		$loaded = true;
		$source = self::folder() . '/src/';
		spl_autoload_register(
			static function ( string $class_name ) use ( $source ): void {
				if ( str_starts_with( $class_name, 'Runlight\\' ) && ! str_starts_with( $class_name, 'Runlight\\WordPress\\' ) ) {
					$file = $source . str_replace( '\\', '/', substr( $class_name, strlen( 'Runlight\\' ) ) ) . '.php';
					if ( is_file( $file ) ) {
						require $file;
					}
				}
			}
		);
		// Runlight's notes go to the debug log, and only while it is on.
		\Runlight\Log::to(
			static function ( string $line ): void {
				if ( defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG ) {
					error_log( $line ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- Runlight's own notes, only with debug logging on.
				}
			}
		);
	}
}
