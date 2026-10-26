<?php
/**
 * Where Runlight keeps its numbers when it runs in this WordPress: in
 * WordPress's own database, in tables named after WordPress's own prefix and
 * runlight_, such as wp_runlight_events, when that is MySQL 8.0.20 or MariaDB
 * 11.4 or later, or else in a SQLite file under the uploads folder. The choice is made the
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

	/** What Runlight's table names start with, after WordPress's own prefix. */
	private const TABLES = 'runlight_';

	/** What they started with up to 0.3.0, which the tables of an earlier copy are renamed from. */
	private const OLD_TABLES = 'rl_';

	/** @var array{kind:string,file:string,tables:string}|null */
	private static ?array $kept = null;

	/**
	 * The filesystem for Runlight's files. They are uploads, which PHP writes
	 * itself as WordPress does with every upload, so the direct method is the
	 * one that reaches them; FTP or SSH, which other methods use for code,
	 * would not.
	 */
	public static function files(): \WP_Filesystem_Direct {
		static $direct = null;
		if ( null === $direct ) {
			if ( ! class_exists( 'WP_Filesystem_Direct', false ) ) {
				require_once ABSPATH . 'wp-admin/includes/class-wp-filesystem-base.php';
				require_once ABSPATH . 'wp-admin/includes/class-wp-filesystem-direct.php';
			}
			$direct = new \WP_Filesystem_Direct( null );
		}
		return $direct;
	}

	/**
	 * Where Runlight keeps its numbers: "mysql", "sqlite", or an empty string
	 * when this server can do neither. Worked out once and kept, with a name no
	 * one can guess for a SQLite file in a folder the web serves.
	 */
	public static function kind(): string {
		return self::kept()['kind'];
	}

	/** @return array{kind:string,file:string,tables:string} */
	private static function kept(): array {
		if ( null !== self::$kept ) {
			return self::$kept;
		}
		$saved = self::saved();
		if ( null !== $saved ) {
			self::$kept = $saved;
			return self::$kept;
		}
		// Sites in a network each get a file of their own, so no site sees another's settings or keys.
		$tables     = ! is_multisite() && self::database_fits() ? self::tables_free() : null;
		$kind       = null !== $tables ? 'mysql' : ( class_exists( 'SQLite3' ) ? 'sqlite' : '' );
		self::$kept = array(
			'kind'   => $kind,
			'file'   => 'runlight-' . bin2hex( random_bytes( 16 ) ) . '.db',
			'tables' => $tables ?? self::TABLES,
		);
		if ( '' !== $kind ) {
			update_option( self::OPTION, self::$kept, true );
		}
		return self::$kept;
	}

	/**
	 * The choice as saved, or null before there is one. Tables made up to
	 * 0.3.0 have no name saved, and start rl_.
	 *
	 * @return array{kind:string,file:string,tables:string}|null
	 */
	private static function saved(): ?array {
		$saved = get_option( self::OPTION, array() );
		if ( ! is_array( $saved ) || ! in_array( $saved['kind'] ?? '', array( 'mysql', 'sqlite' ), true ) || ! is_string( $saved['file'] ?? null ) ) {
			return null;
		}
		return array(
			'kind'   => $saved['kind'],
			'file'   => $saved['file'],
			'tables' => in_array( $saved['tables'] ?? null, array( self::TABLES, self::OLD_TABLES ), true ) ? $saved['tables'] : self::OLD_TABLES,
		);
	}

	/**
	 * Whether WordPress's own database can hold Runlight's tables: MySQL 8.0.20 or
	 * MariaDB 11.4 or later, reached through $wpdb. Runlight's tables
	 * compare text by code point with a collation older servers lack.
	 */
	private static function database_fits(): bool {
		global $wpdb;
		if ( ( defined( 'DB_ENGINE' ) && 'sqlite' === DB_ENGINE ) || ! $wpdb instanceof \wpdb ) {
			return false;
		}
		$version = (string) $wpdb->get_var( 'SELECT VERSION()' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- the server's version, read once to choose where Runlight's tables go.
		if ( ! preg_match( '/^(\d+\.\d+(?:\.\d+)?)/', $version, $number ) ) {
			return false;
		}
		return version_compare( $number[1], stripos( $version, 'mariadb' ) !== false ? '11.4' : '8.0.20', '>=' );
	}

	/**
	 * What Runlight's table names start with in WordPress's database:
	 * WordPress's own prefix, then runlight_, or rl_ for tables made up to 0.3.0.
	 *
	 * @param string $tables What follows WordPress's prefix.
	 */
	public static function prefix( string $tables = self::TABLES ): string {
		global $wpdb;
		return $wpdb->prefix . $tables;
	}

	/**
	 * Runlight's tables in WordPress's database, by name: the only ones it ever
	 * creates, renames, or drops.
	 *
	 * @param string $tables What follows WordPress's prefix.
	 * @return list<string>
	 */
	private static function tables( string $tables = self::TABLES ): array {
		$prefix = self::prefix( $tables );
		return array_map( static fn ( string $table ): string => $prefix . $table, \Runlight\Store\Sql::TABLES );
	}

	/**
	 * The tables already in WordPress's database whose names start as
	 * Runlight's would.
	 *
	 * @param string $tables What follows WordPress's prefix.
	 * @return list<string>
	 */
	private static function found( string $tables = self::TABLES ): array {
		global $wpdb;
		return array_map( 'strval', (array) $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( self::prefix( $tables ) ) . '%' ) ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- looking for tables named as Runlight's would be, before making them.
	}

	/**
	 * What Runlight's tables can be named in WordPress's database without
	 * meeting another's, or null when nothing can, and the numbers go in a
	 * SQLite file. No table there starts as theirs would, unless it is one of
	 * Runlight's own, left by an earlier copy of the plugin along with its
	 * record of the schema, under the names up to 0.3.0 too, which are then
	 * used again and renamed.
	 */
	private static function tables_free(): ?string {
		Library::load();
		$found = self::found();
		if ( array() !== $found ) {
			return self::own( $found, self::TABLES ) ? self::TABLES : null;
		}
		return self::own( self::found( self::OLD_TABLES ), self::OLD_TABLES ) ? self::OLD_TABLES : self::TABLES;
	}

	/**
	 * Whether the tables found are Runlight's own and nothing else, with its record of the schema.
	 *
	 * @param list<string> $found  The tables found.
	 * @param string       $tables What follows WordPress's prefix in their names.
	 */
	private static function own( array $found, string $tables ): bool {
		return in_array( self::prefix( $tables ) . 'meta', $found, true ) && array() === array_diff( $found, self::tables( $tables ) );
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
		$mode = defined( 'FS_CHMOD_FILE' ) ? FS_CHMOD_FILE : 0644;
		if ( ! file_exists( $folder . '/index.php' ) ) {
			self::files()->put_contents( $folder . '/index.php', "<?php\n// Silence is golden.\n", $mode );
		}
		if ( ! file_exists( $folder . '/.htaccess' ) ) {
			self::files()->put_contents( $folder . '/.htaccess', "Require all denied\n", $mode );
		}
	}

	/** The store Runlight runs on. */
	public static function store(): \Runlight\Store\SqlStore {
		$kept = self::kept();
		if ( 'mysql' === $kept['kind'] ) {
			global $wpdb;
			if ( self::OLD_TABLES === $kept['tables'] && self::rename() ) {
				$kept = self::kept();
			}
			return new \Runlight\Store\SqlStore( new WpdbDb( $wpdb ), self::prefix( $kept['tables'] ) );
		}
		self::protect();
		return new \Runlight\Store\SqlStore( new Sqlite3Db( self::folder() . '/' . $kept['file'] ) );
	}

	/**
	 * Renames the tables an earlier copy of the plugin made, wp_rl_events and
	 * the rest, and their indexes, to start runlight_ as new ones do, then saves
	 * that they do. Each step finds where the last one got to, so a rename cut
	 * short finishes the next time; while a table is there under both names,
	 * nothing is touched and the old names stay.
	 */
	private static function rename(): bool {
		global $wpdb;
		Library::load();
		// phpcs:disable WordPress.DB.DirectDatabaseQuery,WordPress.DB.DirectDatabaseQuerySchemaChange -- renaming Runlight's own tables and indexes, once.
		if ( '1' !== (string) $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 10)', self::prefix() . 'rename' ) ) ) {
			return false;
		}
		try {
			$old   = array_intersect( self::tables( self::OLD_TABLES ), self::found( self::OLD_TABLES ) );
			$found = self::found();
			if ( array() !== $old ) {
				// Runlight's own, by its record of the schema, under the old name or, partway through, the new one.
				if ( ! in_array( self::prefix( self::OLD_TABLES ) . 'meta', $old, true ) && ! in_array( self::prefix() . 'meta', $found, true ) ) {
					return false;
				}
				$renames = array();
				foreach ( $old as $table ) {
					$renamed = self::prefix() . substr( $table, strlen( self::prefix( self::OLD_TABLES ) ) );
					if ( in_array( $renamed, $found, true ) ) {
						return false;
					}
					$renames[ $table ] = $renamed;
				}
				foreach ( $renames as $table => $renamed ) {
					if ( false === $wpdb->query( $wpdb->prepare( 'RENAME TABLE %i TO %i', $table, $renamed ) ) ) {
						return false;
					}
				}
				$found = self::found();
			}
			foreach ( array_intersect( self::tables(), $found ) as $table ) {
				$indexes = (array) $wpdb->get_col( $wpdb->prepare( 'SELECT DISTINCT index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = %s AND index_name LIKE %s', $table, $wpdb->esc_like( self::prefix( self::OLD_TABLES ) ) . '%' ) );
				foreach ( $indexes as $index ) {
					$renamed = self::prefix() . substr( (string) $index, strlen( self::prefix( self::OLD_TABLES ) ) );
					if ( false === $wpdb->query( $wpdb->prepare( 'ALTER TABLE %i RENAME INDEX %i TO %i', $table, (string) $index, $renamed ) ) ) {
						return false;
					}
				}
			}
			$kept           = self::kept();
			$kept['tables'] = self::TABLES;
			update_option( self::OPTION, $kept, true );
			self::$kept = $kept;
			return true;
		} finally {
			$wpdb->query( $wpdb->prepare( 'DO RELEASE_LOCK(%s)', self::prefix() . 'rename' ) );
			// phpcs:enable WordPress.DB.DirectDatabaseQuery,WordPress.DB.DirectDatabaseQuerySchemaChange
		}
	}

	/**
	 * Removes Runlight's numbers, for uninstalling: its tables, each by name and
	 * only when its record of the schema is there, or its SQLite file.
	 */
	public static function remove(): void {
		$kept = self::saved();
		if ( null === $kept ) {
			return;
		}
		if ( 'mysql' === $kept['kind'] ) {
			global $wpdb;
			Library::load();
			$found = self::found( $kept['tables'] );
			if ( in_array( self::prefix( $kept['tables'] ) . 'meta', $found, true ) ) {
				foreach ( array_intersect( self::tables( $kept['tables'] ), $found ) as $table ) {
					$wpdb->query( $wpdb->prepare( 'DROP TABLE IF EXISTS %i', $table ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.DirectDatabaseQuerySchemaChange -- Runlight's own tables, each by name, dropped on uninstall.
				}
			}
		} else {
			foreach ( array( '', '-wal', '-shm' ) as $suffix ) {
				wp_delete_file( self::folder() . '/' . $kept['file'] . $suffix );
			}
		}
		delete_option( self::OPTION );
	}
}
