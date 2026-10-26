<?php
/**
 * Runlight's tables in WordPress's own database, reached through $wpdb, so
 * Runlight uses WordPress's connection rather than opening one of its own.
 *
 * Runlight writes its SQL for SQLite and Postgres with `?` placeholders. As
 * the package's MySQL driver does, each statement is turned into MySQL's
 * form first by MysqlText: a "quoted" name in backticks, a backslash inside
 * 'text' doubled, and each `?` replaced, here by one of $wpdb->prepare()'s
 * placeholders, so $wpdb puts every value in itself.
 * The connection is WordPress's, so its SQL mode is not changed; where it
 * includes NO_BACKSLASH_ESCAPES, a backslash in 'text' is left as it is.
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

	/** Whether WordPress's session is in NO_BACKSLASH_ESCAPES mode, read once; null until then. */
	private ?bool $plain_backslashes = null;

	/**
	 * The values of the statement being turned into MySQL's form, in order, for $wpdb->prepare().
	 *
	 * @var list<int|string>
	 */
	private array $values = array();

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
		$text = $this->text( $sql, $params );
		$rows = $this->quietly( fn () => $this->wpdb->get_results( $text, ARRAY_A ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery,PluginCheck.Security.DirectDB.UnescapedDBParameter -- Runlight's own statement on its own tables, made by $wpdb->prepare() in text().
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
			$ok   = $this->quietly( fn () => $this->wpdb->get_var( 'SELECT GET_LOCK(' . self::LOCK . ', ' . $left . ')' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.NotPrepared -- a fixed statement taking Runlight's own lock, with a whole number of seconds.
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
		$this->quietly( fn () => $this->wpdb->query( $sql ) ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared,WordPress.DB.DirectDatabaseQuery,PluginCheck.Security.DirectDB.UnescapedDBParameter -- Runlight's own statement on its own tables, made by $wpdb->prepare() in text().
		$this->check();
	}

	/**
	 * Runs one call on $wpdb without $wpdb printing or logging a failure:
	 * Runlight expects some, such as reading rl_meta before its tables exist,
	 * and check() turns each one into an exception for it instead.
	 *
	 * @param callable $call The call.
	 */
	private function quietly( callable $call ): mixed {
		$was = $this->wpdb->suppress_errors( true );
		try {
			return $call();
		} finally {
			$this->wpdb->suppress_errors( $was );
		}
	}

	/** $wpdb reports a failed statement in last_error rather than throwing, and Runlight expects it thrown. */
	private function check(): void {
		if ( '' !== $this->wpdb->last_error ) {
			throw new \RuntimeException( 'Runlight: ' . $this->wpdb->last_error ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- never printed: Local::serve() catches it, logs it, and answers a fixed JSON error.
		}
	}

	/**
	 * A statement as MySQL reads it, with its values put in by $wpdb->prepare(). A % in Runlight's own SQL, as
	 * in a LIKE pattern or a date format, is doubled first, so prepare() reads only the placeholders as its own.
	 *
	 * @param string $sql    SQL written for SQLite and Postgres, with `?` placeholders.
	 * @param array  $params Its values.
	 */
	private function text( string $sql, array $params ): string {
		$this->values = array();
		$text         = MysqlText::of( $sql, array_values( $params ), $this->placeholder( ... ), ! $this->no_backslash_escapes() );
		if ( array() === $this->values ) {
			return $text;
		}
		$text = strtr(
			str_replace( '%', '%%', $text ),
			array(
				"\x01d\x01" => '%d',
				"\x01s\x01" => '%s',
			)
		);
		return (string) $this->wpdb->prepare( $text, $this->values ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared -- Runlight's own statement, its values as placeholders.
	}

	/**
	 * Whether the session reads a backslash in text as itself. Read once, since WordPress sets the mode when it
	 * connects; its own escaping follows the mode, and so must the backslashes in Runlight's statements.
	 */
	private function no_backslash_escapes(): bool {
		if ( null === $this->plain_backslashes ) {
			$mode                    = $this->quietly( fn () => $this->wpdb->get_var( 'SELECT @@SESSION.sql_mode' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery,WordPress.DB.PreparedSQL.NotPrepared -- a fixed statement reading the session's SQL mode, once.
			$this->plain_backslashes = in_array( 'NO_BACKSLASH_ESCAPES', explode( ',', strtoupper( (string) $mode ) ), true );
		}
		return $this->plain_backslashes;
	}

	/**
	 * Where a value goes, marked for text() to give prepare() its placeholder, and the value kept for it. A null
	 * goes in as NULL itself, which prepare() has no placeholder for.
	 *
	 * @param mixed $value The value.
	 */
	private function placeholder( mixed $value ): string {
		if ( null === $value ) {
			return 'NULL';
		}
		if ( is_bool( $value ) || is_int( $value ) ) {
			$this->values[] = (int) $value;
			return "\x01d\x01";
		}
		// A float goes as text MySQL reads back as the same number, as the package binds a float.
		$this->values[] = is_float( $value ) ? \Runlight\Json::number( $value ) : (string) $value;
		return "\x01s\x01";
	}
}
