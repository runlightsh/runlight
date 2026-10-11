<?php
/**
 * Where Runlight keeps its numbers when it runs in this WordPress: in
 * WordPress's own database, in tables named after WordPress's own prefix and
 * rl_, such as wp_rl_events, when that is MySQL 8.4 or MariaDB 11.4 or later,
 * or else in a SQLite file under the uploads folder. The choice is made the
 * first time Runlight runs and kept, so the numbers never split across two
 * places.
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
		$kind = ! is_multisite() && self::mysql_fits() && self::mysql_free() ? 'mysql' : ( class_exists( 'SQLite3' ) ? 'sqlite' : '' );
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

	/** What Runlight's table names start with in WordPress's database: WordPress's own prefix, then rl_. */
	public static function prefix(): string {
		global $wpdb;
		return $wpdb->prefix . \Runlight\Store\Sql::PREFIX;
	}

	/**
	 * Runlight's tables in WordPress's database, by name: the only ones it ever
	 * creates or drops.
	 *
	 * @return list<string>
	 */
	private static function tables(): array {
		$prefix = self::prefix();
		return array_map( static fn ( string $table ): string => $prefix . $table, \Runlight\Store\Sql::TABLES );
	}

	/**
	 * The tables already in WordPress's database whose names start as
	 * Runlight's would.
	 *
	 * @return list<string>
	 */
	private static function found(): array {
		global $wpdb;
		return array_map( 'strval', (array) $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( self::prefix() ) . '%' ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- looking for tables named as Runlight's would be, before making them.
	}

	/**
	 * Whether Runlight's tables can go in WordPress's database without meeting
	 * another's: no table there starts as theirs would, unless it is one of
	 * Runlight's own, left by an earlier copy of the plugin along with its
	 * record of the schema. Otherwise the numbers go in a SQLite file.
	 */
	private static function mysql_free(): bool {
		Library::load();
		$found = self::found();
		if ( array() === $found ) {
			return true;
		}
		return in_array( self::prefix() . 'meta', $found, true ) && array() === array_diff( $found, self::tables() );
	}

	/** The folder a SQLite file goes in, made with files that keep it from being listed. */
	public static function folder(): string {
		$uploads = wp_upload_dir( null, false );
		return trailingslashit( $uploads['basedir'] ) . 'runlight';
	}

	/**
	 * Makes the folder, if need be, with the files that keep it from being
	 * listed on any server, writing either one that is missing, whatever made
	 * the folder.
	 */
	public static function protect(): void {
		$folder = self::folder();
		if ( ! is_dir( $folder ) ) {
			wp_mkdir_p( $folder );
		}
		// The file's name is the protection; these keep the folder from being listed on any server.
		if ( ! file_exists( $folder . '/index.php' ) ) {
			file_put_contents( $folder . '/index.php', "<?php\n// Silence is golden.\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- a new file in the plugin's own folder.
		}
		if ( ! file_exists( $folder . '/.htaccess' ) ) {
			file_put_contents( $folder . '/.htaccess', "Require all denied\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- a new file in the plugin's own folder.
		}
	}

	/** The store Runlight runs on. */
	public static function store(): \Runlight\Store\SqlStore {
		$kept = self::kept();
		if ( 'mysql' === $kept['kind'] ) {
			global $wpdb;
			return new \Runlight\Store\SqlStore( new WpdbDb( $wpdb ), self::prefix() );
		}
		self::protect();
		return new \Runlight\Store\SqlStore( new Sqlite3Db( self::folder() . '/' . $kept['file'] ) );
	}

	/**
	 * Removes Runlight's numbers, for uninstalling: its tables, each by name and
	 * only when its record of the schema is there, or its SQLite file.
	 */
	public static function remove(): void {
		$kept = get_option( self::OPTION, array() );
		if ( ! is_array( $kept ) ) {
			return;
		}
		if ( 'mysql' === ( $kept['kind'] ?? '' ) ) {
			global $wpdb;
			Library::load();
			$found = self::found();
			if ( in_array( self::prefix() . 'meta', $found, true ) ) {
				foreach ( array_intersect( self::tables(), $found ) as $table ) {
					$wpdb->query( 'DROP TABLE IF EXISTS `' . esc_sql( $table ) . '`' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuerySchemaChange -- Runlight's own tables, each by name, dropped on uninstall.
				}
			}
		} elseif ( 'sqlite' === ( $kept['kind'] ?? '' ) && is_string( $kept['file'] ?? null ) ) {
			foreach ( array( '', '-wal', '-shm' ) as $suffix ) {
				wp_delete_file( self::folder() . '/' . $kept['file'] . $suffix );
			}
		}
		delete_option( self::OPTION );
	}
}
