<?php
/**
 * Where Runlight keeps its numbers when it runs in this WordPress: in
 * WordPress's own database, in tables prefixed rl_, when that is MySQL 8.4 or
 * MariaDB 11.4 or later, or else in a SQLite file under the uploads folder.
 * The choice is made the first time Runlight runs and kept, so the numbers
 * never split across two places.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Storage {
	/** The option holding the choice, and for SQLite the file's name. */
	public const OPTION = 'runlight_storage';

	/**
	 * Where Runlight keeps its numbers: "mysql", "sqlite", or an empty string
	 * when this server can do neither. Worked out once and kept, with a name no
	 * one can guess for a SQLite file in a folder the web serves.
	 */
	public static function kind(): string {
		return self::kept()['kind'];
	}

	/** @return array{kind:string,file:string} */
	private static function kept(): array {
		static $kept = null;
		if ( null !== $kept ) {
			return $kept;
		}
		$saved = get_option( self::OPTION, array() );
		if ( is_array( $saved ) && in_array( $saved['kind'] ?? '', array( 'mysql', 'sqlite' ), true ) && is_string( $saved['file'] ?? null ) ) {
			$kept = array(
				'kind' => $saved['kind'],
				'file' => $saved['file'],
			);
			return $kept;
		}
		// Sites in a network each get a file of their own, so no site sees another's settings or keys.
		$kind = ! is_multisite() && self::mysql_fits() ? 'mysql' : ( class_exists( 'SQLite3' ) ? 'sqlite' : '' );
		$kept = array(
			'kind' => $kind,
			'file' => 'runlight-' . bin2hex( random_bytes( 16 ) ) . '.db',
		);
		if ( '' !== $kind ) {
			update_option( self::OPTION, $kept, true );
		}
		return $kept;
	}

	/**
	 * Whether WordPress's own database can hold Runlight's tables: MySQL 8.4 or
	 * MariaDB 11.4 or later, reached through $wpdb. Runlight's tables
	 * compare text by code point with a collation older servers lack.
	 */
	private static function mysql_fits(): bool {
		global $wpdb;
		if ( ( defined( 'DB_ENGINE' ) && 'sqlite' === DB_ENGINE ) || ! $wpdb instanceof \wpdb ) {
			return false;
		}
		$version = (string) $wpdb->get_var( 'SELECT VERSION()' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- the server's version, read once to choose where Runlight's tables go.
		if ( ! preg_match( '/^(\d+\.\d+)/', $version, $number ) ) {
			return false;
		}
		return version_compare( $number[1], stripos( $version, 'mariadb' ) !== false ? '11.4' : '8.4', '>=' );
	}

	/** The folder a SQLite file goes in, made with files that keep it from being listed. */
	public static function folder(): string {
		$uploads = wp_upload_dir( null, false );
		return trailingslashit( $uploads['basedir'] ) . 'runlight';
	}

	/** The store Runlight runs on. */
	public static function store(): \Runlight\Store\SqlStore {
		$kept = self::kept();
		if ( 'mysql' === $kept['kind'] ) {
			global $wpdb;
			return new \Runlight\Store\SqlStore( new WpdbDb( $wpdb ) );
		}
		$folder = self::folder();
		if ( ! is_dir( $folder ) ) {
			wp_mkdir_p( $folder );
			// The file's name is the protection; these keep the folder from being listed on any server.
			file_put_contents( $folder . '/index.php', "<?php\n// Silence is golden.\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- a new file in a folder the plugin made.
			file_put_contents( $folder . '/.htaccess', "Require all denied\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- a new file in a folder the plugin made.
		}
		return new \Runlight\Store\SqlStore( new Sqlite3Db( $folder . '/' . $kept['file'] ) );
	}

	/** Removes Runlight's numbers, for uninstalling: its tables, or its SQLite file. */
	public static function remove(): void {
		$kept = get_option( self::OPTION, array() );
		if ( ! is_array( $kept ) ) {
			return;
		}
		if ( 'mysql' === ( $kept['kind'] ?? '' ) ) {
			global $wpdb;
			$tables = $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( 'rl_' ) . '%' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- Runlight's own tables, found to be dropped on uninstall.
			foreach ( $tables as $table ) {
				$wpdb->query( 'DROP TABLE IF EXISTS `' . esc_sql( $table ) . '`' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuerySchemaChange -- Runlight's own tables, dropped on uninstall.
			}
		} elseif ( 'sqlite' === ( $kept['kind'] ?? '' ) && is_string( $kept['file'] ?? null ) ) {
			foreach ( array( '', '-wal', '-shm' ) as $suffix ) {
				wp_delete_file( self::folder() . '/' . $kept['file'] . $suffix );
			}
		}
		delete_option( self::OPTION );
	}
}
