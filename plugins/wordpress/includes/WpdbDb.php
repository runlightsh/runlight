<?php
/**
 * Runlight's tables in WordPress's own database, reached through $wpdb, so
 * Runlight uses WordPress's connection rather than opening one of its own.
 *
 * Runlight writes its SQL for SQLite and Postgres with `?` placeholders. As
 * the package's MySQL driver does, each statement is turned into MySQL's
 * form first: a "quoted" name in backticks, a backslash inside 'text'
 * doubled, and each `?` replaced by its value, escaped by $wpdb itself.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

use Runlight\Db\Db;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WpdbDb implements Db {
	/** One lock per database, so sites sharing a server do not wait on each other. */
	private const LOCK = "CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48))";

	private int $depth = 0;

	/** @param \wpdb $wpdb WordPress's database. */
	public function __construct( private readonly \wpdb $wpdb ) {}

	public function dialect(): string {
		return 'mysql';
	}

	/**
	 * Rows a statement returns, keyed by column name.
	 *
	 * @param string $sql    The statement, with `?` placeholders.
	 * @param array  $params Its values.
	 * @return list<array<string, mixed>>
	 */
	public function all( string $sql, array $params = array() ): array {
		$rows = $this->wpdb->get_results( $this->text( $sql, $params ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery -- Runlight's own statement on its own tables, every value escaped by $wpdb in text().
		$this->check();
		return is_array( $rows ) ? array_values( $rows ) : array();
	}

	/**
	 * Runs a statement.
	 *
	 * @param string $sql    The statement, with `?` placeholders.
	 * @param array  $params Its values.
	 */
	public function run( string $sql, array $params = array() ): void {
		$this->query( $this->text( $sql, $params ) );
	}

	/**
	 * Runs an UPDATE or DELETE and says how many rows it matched, since MySQL has no RETURNING.
	 *
	 * @param string $sql    The statement, with `?` placeholders.
	 * @param array  $params Its values.
	 */
	public function affected( string $sql, array $params = array() ): int {
		$this->query( $this->text( $sql, $params ) );
		return (int) $this->wpdb->rows_affected;
	}

	public function transaction( callable $fn ): mixed {
		if ( $this->depth > 0 ) {
			return $fn( $this );
		}
		// As Postgres does by default: each statement sees what was committed before it began.
		$this->query( 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' );
		$this->query( 'START TRANSACTION' );
		++$this->depth;
		try {
			$result = $fn( $this );
			--$this->depth;
			$this->query( 'COMMIT' );
			return $result;
		} catch ( \Throwable $error ) {
			$this->depth = 0;
			$this->wpdb->query( 'ROLLBACK' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- undoing Runlight's own transaction.
			throw $error;
		}
	}

	/**
	 * Runs `$fn` holding a lock on the database, so two requests starting at once do not race to create the same tables.
	 *
	 * @param callable $fn What to run.
	 */
	public function exclusive( callable $fn ): mixed {
		// Not got within five seconds means another request is creating the tables: ask again.
		do {
			$ok = $this->wpdb->get_var( 'SELECT GET_LOCK(' . self::LOCK . ', 5)' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.NotPrepared -- a fixed statement taking Runlight's own lock.
			$this->check();
			if ( null === $ok ) {
				throw new \RuntimeException( 'Runlight: MySQL refused the lock for creating tables' );
			}
		} while ( 1 !== (int) $ok );
		try {
			return $fn( $this );
		} finally {
			$this->wpdb->query( 'DO RELEASE_LOCK(' . self::LOCK . ')' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.NotPrepared -- a fixed statement releasing Runlight's own lock.
		}
	}

	/** The connection is WordPress's, which closes it itself. */
	public function close(): void {}

	/**
	 * Runs a statement that returns no rows.
	 *
	 * @param string $sql A statement with its values in place.
	 */
	private function query( string $sql ): void {
		$this->wpdb->query( $sql ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery -- Runlight's own statement on its own tables, every value escaped by $wpdb in text().
		$this->check();
	}

	/** $wpdb reports a failed statement in last_error rather than throwing, and Runlight expects it thrown. */
	private function check(): void {
		if ( '' !== $this->wpdb->last_error ) {
			throw new \RuntimeException( 'Runlight: ' . $this->wpdb->last_error );
		}
	}

	/**
	 * A statement as MySQL reads it, with its values in place.
	 *
	 * @param string $sql    SQL written for SQLite and Postgres, with `?` placeholders.
	 * @param array  $params Its values.
	 */
	private function text( string $sql, array $params ): string {
		$params = array_values( $params );
		$out    = '';
		$n      = 0;
		$quote  = null;
		$length = strlen( $sql );
		for ( $i = 0; $i < $length; $i++ ) {
			$ch = $sql[ $i ];
			if ( null !== $quote ) {
				if ( $ch === $quote ) {
					$quote = null;
					$out  .= '"' === $ch ? '`' : $ch;
				} elseif ( "'" === $quote && '\\' === $ch ) {
					$out .= '\\\\';
				} elseif ( '"' === $quote && '`' === $ch ) {
					$out .= '``';
				} else {
					$out .= $ch;
				}
			} elseif ( "'" === $ch || '"' === $ch || '`' === $ch ) {
				$quote = $ch;
				$out  .= '"' === $ch ? '`' : $ch;
			} elseif ( '?' === $ch ) {
				if ( $n >= count( $params ) ) {
					throw new \InvalidArgumentException( 'Runlight: a statement has more placeholders than values' );
				}
				$out .= $this->literal( $params[ $n++ ] );
			} else {
				$out .= $ch;
			}
		}
		if ( count( $params ) !== $n ) {
			throw new \InvalidArgumentException( 'Runlight: a statement has more values than placeholders' );
		}
		return $out;
	}

	/**
	 * A value as a MySQL literal, text escaped by $wpdb as its own prepare() escapes it.
	 *
	 * @param mixed $value The value.
	 */
	private function literal( mixed $value ): string {
		if ( null === $value ) {
			return 'NULL';
		}
		if ( is_bool( $value ) ) {
			return $value ? '1' : '0';
		}
		if ( is_int( $value ) ) {
			return (string) $value;
		}
		if ( is_float( $value ) ) {
			// Text MySQL reads back as the same number, as the package binds a float.
			return "'" . \Runlight\Json::number( $value ) . "'";
		}
		return "'" . $this->wpdb->_real_escape( (string) $value ) . "'";
	}
}
