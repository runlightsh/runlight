<?php
/**
 * Runlight's tables in WordPress's own database, reached through $wpdb, so
 * Runlight uses WordPress's connection rather than opening one of its own.
 *
 * Runlight writes its SQL for SQLite and Postgres with `?` placeholders. As
 * the package's MySQL driver does, each statement is turned into MySQL's
 * form first by MysqlText: a "quoted" name in backticks, a backslash inside
 * 'text' doubled, and each `?` replaced by its value, escaped by $wpdb itself.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

use Runlight\Db\Db;
use Runlight\Db\MysqlText;
use Runlight\Db\TablesBusy;

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
		$rows = $this->wpdb->get_results( $this->text( $sql, $params ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery,PluginCheck.Security.DirectDB.UnescapedDBParameter -- Runlight's own statement on its own tables, every value escaped by $wpdb in text().
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
	 * Waits for the lock at most TablesBusy::wait() seconds, so a request does not wait on a long index build for good.
	 *
	 * @param callable $fn What to run.
	 * @throws TablesBusy When another request held the lock all that time.
	 */
	public function exclusive( callable $fn ): mixed {
		$wait  = TablesBusy::wait();
		$until = microtime( true ) + $wait;
		for ( ;; ) {
			$left = max( 1, min( 5, (int) ceil( $until - microtime( true ) ) ) );
			$ok   = $this->wpdb->get_var( 'SELECT GET_LOCK(' . self::LOCK . ', ' . $left . ')' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.NotPrepared -- a fixed statement taking Runlight's own lock, with a whole number of seconds.
			$this->check();
			if ( null === $ok ) {
				throw new \RuntimeException( 'Runlight: MySQL refused the lock for creating tables' );
			}
			if ( 1 === (int) $ok ) {
				break;
			}
			// Not got in time: another request is creating the tables. Ask again, until the wait is up.
			if ( microtime( true ) >= $until ) {
				throw new TablesBusy( $wait ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- never printed: Routes answers it with a fixed JSON error.
			}
		}
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
		$this->wpdb->query( $sql ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery,PluginCheck.Security.DirectDB.UnescapedDBParameter -- Runlight's own statement on its own tables, every value escaped by $wpdb in text().
		$this->check();
	}

	/** $wpdb reports a failed statement in last_error rather than throwing, and Runlight expects it thrown. */
	private function check(): void {
		if ( '' !== $this->wpdb->last_error ) {
			throw new \RuntimeException( 'Runlight: ' . $this->wpdb->last_error ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- never printed: Local::serve() catches it, logs it, and answers a fixed JSON error.
		}
	}

	/**
	 * A statement as MySQL reads it, with its values in place.
	 *
	 * @param string $sql    SQL written for SQLite and Postgres, with `?` placeholders.
	 * @param array  $params Its values.
	 */
	private function text( string $sql, array $params ): string {
		return MysqlText::of( $sql, array_values( $params ), $this->literal( ... ) );
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
