<?php
/**
 * Runlight itself, the PHP package the plugin carries under lib/, for running
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

	/** Where the package is: lib/ in the plugin, or packages/php beside it in a checkout of the repository. */
	private static function folder(): string {
		$plugin = dirname( __DIR__ );
		if ( is_dir( $plugin . '/lib/src' ) ) {
			return $plugin . '/lib';
		}
		$checkout = dirname( $plugin, 2 ) . '/packages/php';
		return is_dir( $checkout . '/src' ) ? $checkout : '';
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
		if ( '' === Storage::kind() ) {
			return __( 'Running Runlight in this WordPress needs WordPress’s database on MySQL 8.4 or MariaDB 11.4 or later, or else PHP’s sqlite3 extension, and this server has neither.', 'runlight' );
		}
		if ( '' === self::folder() ) {
			return __( 'This copy of the plugin is missing its lib folder. Install it again from WordPress.org.', 'runlight' );
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
	}
}
