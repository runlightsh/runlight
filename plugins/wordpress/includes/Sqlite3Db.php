<?php
/**
 * Runlight's tables in a SQLite file, through PHP's SQLite3 extension, for
 * sites whose database cannot hold them. Opened as the package opens SQLite:
 * write-ahead logging, a five second wait for a lock, and deleted rows
 * overwritten.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

use Runlight\Db\Db;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Sqlite3Db implements Db {
	private ?\SQLite3 $sqlite = null;
	private int $depth        = 0;
	/** Above zero while exclusive() holds the write lock. */
	private int $held = 0;

	/** @param string $path The database file. */
	public function __construct( private readonly string $path ) {}

	public function dialect(): string {
		return 'sqlite';
	}

	/** The connection, opened on first use, so a request that reads nothing never opens the file. */
	private function sqlite(): \SQLite3 {
		if ( null === $this->sqlite ) {
			$new          = ! file_exists( $this->path );
			$this->sqlite = new \SQLite3( $this->path );
			// The file holds sealed keys, so it is for its owner and group alone (0660), whatever the umask: a
			// scheduled job such as WP-CLI running as another user of the same group can still write to it. Set
			// before WAL is turned on, so the -wal and -shm files SQLite makes beside it take the same mode.
			if ( $new && '/' === DIRECTORY_SEPARATOR && file_exists( $this->path ) ) {
				chmod( $this->path, 0660 ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_chmod -- Runlight's own database file, just made.
			}
			$this->sqlite->enableExceptions( true );
			$this->sqlite->busyTimeout( 5000 );
			$this->sqlite->exec( 'PRAGMA journal_mode = WAL' );
			$this->sqlite->exec( 'PRAGMA synchronous = NORMAL' );
			$this->sqlite->exec( 'PRAGMA secure_delete = FAST' );
		}
		return $this->sqlite;
	}

	/**
	 * Rows a statement returns, keyed by column name.
	 *
	 * @param string $sql    The statement, with `?` placeholders.
	 * @param array  $params Its values.
	 * @return list<array<string, mixed>>
	 */
	public function all( string $sql, array $params = array() ): array {
		$result = $this->execute( $sql, $params );
		$rows   = array();
		// A statement that returns no rows, such as an INSERT through all(), gives none.
		if ( $result->numColumns() > 0 ) {
			$row = $result->fetchArray( SQLITE3_ASSOC );
			while ( false !== $row ) {
				$rows[] = $row;
				$row    = $result->fetchArray( SQLITE3_ASSOC );
			}
		}
		$result->finalize();
		return $rows;
	}

	/**
	 * Runs a statement.
	 *
	 * @param string $sql    The statement, with `?` placeholders.
	 * @param array  $params Its values.
	 */
	public function run( string $sql, array $params = array() ): void {
		$this->execute( $sql, $params )->finalize();
	}

	/**
	 * Runs an UPDATE or DELETE and says how many rows it matched. The store asks this rather than adding RETURNING,
	 * since SQLite3 runs a statement once to start it and again to read its first row, so a RETURNING statement
	 * would change the rows twice and report none.
	 *
	 * @param string $sql    The statement, with `?` placeholders.
	 * @param array  $params Its values.
	 */
	public function affected( string $sql, array $params = array() ): int {
		$this->execute( $sql, $params )->finalize();
		return $this->sqlite()->changes();
	}

	public function transaction( callable $fn ): mixed {
		if ( $this->depth > 0 ) {
			return $fn( $this );
		}
		return $this->within( 'BEGIN', $fn );
	}

	/**
	 * SQLite's lock is its write lock, taken up front with BEGIN IMMEDIATE, so a second request waits before it
	 * reads anything, and a read-then-write in `$fn` cannot interleave with another's.
	 *
	 * @param callable $fn What to run.
	 */
	public function exclusive( callable $fn ): mixed {
		++$this->held;
		try {
			return $this->depth > 0 || $this->held > 1 ? $fn( $this ) : $this->within( 'BEGIN IMMEDIATE', $fn );
		} finally {
			--$this->held;
		}
	}

	public function close(): void {
		if ( null !== $this->sqlite ) {
			$this->sqlite->close();
			$this->sqlite = null;
		}
	}

	/**
	 * Runs `$fn` in a transaction begun with `$begin`, committed when it returns and rolled back when it throws.
	 *
	 * @param string   $begin BEGIN, or BEGIN IMMEDIATE for the write lock.
	 * @param callable $fn    What to run.
	 */
	private function within( string $begin, callable $fn ): mixed {
		$sqlite = $this->sqlite();
		$sqlite->exec( $begin );
		++$this->depth;
		try {
			$result = $fn( $this );
			--$this->depth;
			$sqlite->exec( 'COMMIT' );
			return $result;
		} catch ( \Throwable $error ) {
			$this->depth = 0;
			try {
				$sqlite->exec( 'ROLLBACK' );
			} catch ( \Throwable $ignored ) {
				// Already rolled back by SQLite itself.
				unset( $ignored );
			}
			throw $error;
		}
	}

	/**
	 * A statement run with its values bound, as the package binds them: a float as text, which SQLite reads back
	 * as the same number, and true or false as 1 or 0.
	 *
	 * @param string $sql    The statement, with `?` placeholders.
	 * @param array  $params Its values.
	 */
	private function execute( string $sql, array $params ): \SQLite3Result {
		$statement = $this->sqlite()->prepare( $sql );
		foreach ( array_values( $params ) as $i => $value ) {
			if ( null === $value ) {
				$statement->bindValue( $i + 1, null, SQLITE3_NULL );
			} elseif ( is_bool( $value ) ) {
				$statement->bindValue( $i + 1, $value ? 1 : 0, SQLITE3_INTEGER );
			} elseif ( is_int( $value ) ) {
				$statement->bindValue( $i + 1, $value, SQLITE3_INTEGER );
			} elseif ( is_float( $value ) ) {
				$statement->bindValue( $i + 1, \Runlight\Json::number( $value ), SQLITE3_TEXT );
			} else {
				$statement->bindValue( $i + 1, (string) $value, SQLITE3_TEXT );
			}
		}
		return $statement->execute();
	}
}
