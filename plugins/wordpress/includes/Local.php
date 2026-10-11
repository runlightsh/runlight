<?php
/**
 * Runlight running in this WordPress: its dashboard and endpoints at
 * /runlight on this site, its numbers in this site's database, the people
 * who can manage options as its owners, and WordPress's cron for its hourly
 * upkeep.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

use Runlight\Http\Request;
use Runlight\Routes;
use Runlight\Runlight;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Local {
	/** The hourly upkeep: salts, reports, retention, daily totals, and location data. */
	public const CRON = 'runlight_check';

	/** The option holding the secret Runlight signs with, made once. */
	public const SECRET = 'runlight_secret';

	/** The option holding when the upkeep last finished, or was first due. */
	public const CHECKED = 'runlight_checked';

	private static ?Runlight $runlight = null;
	private static ?Routes $routes     = null;

	public static function boot(): void {
		add_action( 'init', array( self::class, 'serve' ), 1 );
		add_action( self::CRON, array( self::class, 'check' ) );
		add_action( 'init', array( self::class, 'schedule' ) );
	}

	/** Whether Runlight runs in this WordPress: chosen in the settings, and possible on this server. */
	public static function active(): bool {
		return 'local' === Settings::get()['mode'] && Library::available();
	}

	/**
	 * Whether the site's addresses go through index.php, as with plain
	 * permalinks: then no rewrite sends /runlight to WordPress on Apache or
	 * LiteSpeed, but /index.php/runlight reaches it on every server.
	 */
	public static function plain_permalinks(): bool {
		return '' === (string) get_option( 'permalink_structure' );
	}

	/** The site's own path and, with plain permalinks, index.php after it, which Runlight's paths start with. */
	private static function home_path(): string {
		return rtrim( (string) wp_parse_url( home_url( '/' ), PHP_URL_PATH ), '/' ) . ( self::plain_permalinks() ? '/index.php' : '' );
	}

	/** The path Runlight answers under, after the folder WordPress lives in, if any. */
	public static function base(): string {
		return self::home_path() . '/runlight';
	}

	/** Runlight's full address on this site. */
	public static function address(): string {
		return home_url( ( self::plain_permalinks() ? '/index.php' : '' ) . '/runlight' );
	}

	/** This site's id in Runlight, which counts this one site; a site in a network has a file of its own. */
	private static function site(): string {
		return 'default';
	}

	/** This site's domain, as Runlight counts it; an address such as 127.0.0.1 is no domain, so then any host counts. */
	private static function hostnames(): array {
		$host = strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) );
		return '' === $host || filter_var( $host, FILTER_VALIDATE_IP ) ? array() : array( $host );
	}

	/** WordPress's timezone as a name Runlight knows: a city, or for a plain offset of whole hours, Etc/GMT. */
	private static function timezone(): string {
		$zone = wp_timezone_string();
		if ( preg_match( '/^([+-])(\d{2}):00$/', $zone, $offset ) ) {
			$hours = (int) $offset[2];
			// Etc/GMT names count the other way: UTC+2 is Etc/GMT-2.
			return 0 === $hours ? 'UTC' : 'Etc/GMT' . ( '+' === $offset[1] ? '-' : '+' ) . $hours;
		}
		return str_contains( $zone, '/' ) || 'UTC' === $zone ? $zone : 'UTC';
	}

	/** The secret Runlight signs sessions and tickets with, made the first time. */
	private static function secret(): string {
		$secret = (string) get_option( self::SECRET, '' );
		if ( '' === $secret ) {
			$secret = bin2hex( random_bytes( 32 ) );
			update_option( self::SECRET, $secret, false );
		}
		return $secret;
	}

	/** The package, and the plugin's classes that build on it, loaded once. */
	private static function load(): void {
		Library::load();
		require_once __DIR__ . '/Fetcher.php';
		require_once __DIR__ . '/WpdbDb.php';
		require_once __DIR__ . '/Sqlite3Db.php';
		require_once __DIR__ . '/Cache.php';
		require_once __DIR__ . '/Locations.php';
		require_once __DIR__ . '/Mailer.php';
		require_once __DIR__ . '/Visitor.php';
	}

	/**
	 * DB-IP's free country data, kept beside a SQLite file, or in the same
	 * uploads folder, downloaded and kept through WordPress.
	 */
	private static function locations(): \Runlight\Server\DbIp {
		self::load();
		Storage::protect();
		return new \Runlight\Server\DbIp(
			Storage::folder() . '/geo',
			'country',
			array( Fetcher::class, 'download' ),
			null,
			new Locations()
		);
	}

	/** Runlight, made on first use in a request. */
	public static function runlight(): Runlight {
		if ( null !== self::$runlight ) {
			return self::$runlight;
		}
		self::load();
		$name    = wp_strip_all_tags( get_bloginfo( 'name' ) );
		$options = array(
			'store'        => Storage::store(),
			'site'         => array(
				'id'        => self::site(),
				'name'      => '' !== $name ? $name : (string) wp_parse_url( home_url(), PHP_URL_HOST ),
				'hostnames' => self::hostnames(),
				'timezone'  => self::timezone(),
			),
			'secret'       => self::secret(),
			// The plugin works out the visitor's address itself (Visitor) and hands it over with each request, so no header is believed here.
			'trustProxy'   => false,
			'fetcher'      => new Fetcher(),
			// Rate counts and the site's icon go in WordPress's cache, never in files of Runlight's own.
			'cache'        => new Cache(),
			// No SMTP, whose client opens connections of its own: WordPress's mailer and the mail services cover it.
			'mailServices' => array_values( array_diff( array_column( \Runlight\Mail\Transports::SERVICES, 'id' ), array( 'smtp' ) ) ),
			'linkPath'     => self::runlight_link_path(),
		);
		if ( Settings::get()['locations'] ) {
			$lookup = self::locations()->lookup();
			if ( null !== $lookup ) {
				$options['geo'] = $lookup;
			}
		}
		// With an SMTP or mail plugin set up, reports go through WordPress, until the dashboard names another service.
		$mailer = property_exists( Runlight::class, 'appMailer' ) ? Mailer::option() : null;
		if ( null !== $mailer ) {
			$options['mail'] = $mailer;
		}
		self::$runlight = new Runlight( $options );
		return self::$runlight;
	}

	/** Runlight's routes, signed in through WordPress: those who can manage options own it. */
	private static function routes(): Routes {
		if ( null !== self::$routes ) {
			return self::$routes;
		}
		self::$routes = self::runlight()->routes(
			array(
				'basePath'   => self::base(),
				'token'      => null,
				// Given here, so Runlight never reads them from the environment: WordPress's cron runs the upkeep, and no
				// other site reports AI agents to this one.
				'cronSecret' => '',
				'observeKey' => '',
				'authorize'  => static fn (): bool => current_user_can( 'manage_options' ),
				'signIn'     => self::base() . '/login',
				'origin'     => home_url(),
				'geoCredit'  => Settings::get()['locations'],
				'cms'        => 'WordPress',
			)
		);
		return self::$routes;
	}

	/**
	 * The request being served, as the visitor sent it. WordPress adds
	 * slashes to $_SERVER, so Runlight reads a copy without them, with the
	 * body read up to its limit as Request::fromGlobals() reads it.
	 *
	 * @throws \Runlight\Http\BodyTooLarge When the body is past its limit.
	 */
	public static function request(): Request {
		Library::load();
		return Request::fromServer( wp_unslash( $_SERVER ) ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- the path and headers reach Runlight as sent, and it checks each one itself.
	}

	/** The path of the request being served, without its query. */
	private static function path(): string {
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/';
		return (string) wp_parse_url( $uri, PHP_URL_PATH );
	}

	/**
	 * Answers requests for Runlight: the dashboard and its API under
	 * /runlight, and short links under /go, which WordPress answers itself
	 * when no link has the name. Everything else is WordPress's.
	 */
	public static function serve(): void {
		if ( ! self::active() ) {
			return;
		}
		$path = self::path();
		$base = self::base();
		$link = str_starts_with( $path, self::runlight_link_path() . '/' );
		if ( $path !== $base && ! str_starts_with( $path, $base . '/' ) && ! $link ) {
			return;
		}
		// A short link's page is left to page caches until Runlight knows the link, since another plugin may answer there.
		if ( ! $link ) {
			self::uncached();
		}
		if ( $base . '/login' === $path ) {
			self::sign_in();
		}
		try {
			$request = self::request();
		} catch ( \Runlight\Http\BodyTooLarge $too_large ) {
			Request::tooLarge()->emit( true );
			exit;
		}
		self::load();
		$context = array( 'ip' => Visitor::address( wp_unslash( $_SERVER ) ) ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- Visitor reads only REMOTE_ADDR and two headers, each checked to be an IP address.
		try {
			if ( $link ) {
				$response = ( self::runlight()->linkHandler() )( $request, $context );
				// No link by that name: the page is WordPress's to answer.
				if ( 404 === $response->status ) {
					return;
				}
				self::uncached();
			} else {
				$response = self::routes()->handle( $request, $context );
			}
		} catch ( \Throwable $error ) {
			\Runlight\Log::write( 'Runlight: ' . $error->getMessage() );
			// A short link Runlight could not look up is left to WordPress, which may have a page there.
			if ( $link ) {
				return;
			}
			$response = new \Runlight\Http\Response( '{"error":"Internal error","code":"internal"}', 500, array( 'content-type' => 'application/json; charset=utf-8', 'cache-control' => 'no-store', 'x-content-type-options' => 'nosniff' ) );
		}
		$response->emit( 'HEAD' !== $request->method );
		// The visitor has the answer; whatever is left runs without keeping them waiting.
		if ( function_exists( 'fastcgi_finish_request' ) ) {
			fastcgi_finish_request();
		} elseif ( function_exists( 'litespeed_finish_request' ) ) {
			litespeed_finish_request();
		}
		self::runlight()->idle();
		exit;
	}

	/** Tells page caches to leave this answer alone. */
	private static function uncached(): void {
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- the constant page caches look for.
		}
	}

	/** Where short links live, before Runlight is made. */
	private static function runlight_link_path(): string {
		return self::home_path() . '/go';
	}

	/**
	 * Runlight sends people who are signed out here, naming the page to come
	 * back to, which is always one of its own.
	 */
	private static function sign_in(): void {
		$next = isset( $_GET['next'] ) ? sanitize_text_field( wp_unslash( $_GET['next'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- only names a page of Runlight's to go back to.
		$back = str_starts_with( $next, self::base() . '/' ) || self::base() === $next ? $next : self::base() . '/';
		$home = wp_parse_url( home_url() );
		$to   = ( $home['scheme'] ?? 'https' ) . '://' . ( $home['host'] ?? '' ) . ( isset( $home['port'] ) ? ':' . $home['port'] : '' ) . $back;
		wp_safe_redirect( wp_login_url( $to ) );
		exit;
	}

	/** The upkeep, scheduled hourly while Runlight runs here. */
	public static function schedule(): void {
		$scheduled = wp_next_scheduled( self::CRON );
		if ( self::active() && ! $scheduled ) {
			wp_schedule_event( time(), 'hourly', self::CRON );
			// Due from now, so the settings page can tell when it has not run for a day.
			if ( false === get_option( self::CHECKED ) ) {
				update_option( self::CHECKED, time(), false );
			}
		} elseif ( ! self::active() && $scheduled ) {
			wp_clear_scheduled_hook( self::CRON );
		}
	}

	/**
	 * Runs the upkeep. A failure is logged rather than thrown, so the other
	 * events WordPress's cron runs in the same request still run.
	 */
	public static function check(): void {
		if ( ! self::active() ) {
			return;
		}
		try {
			if ( Settings::get()['locations'] ) {
				self::locations()->refresh( (int) floor( microtime( true ) * 1000 ) );
			}
			self::runlight()->check();
			Cache::sweep();
			update_option( self::CHECKED, time(), false );
		} catch ( \Throwable $error ) {
			\Runlight\Log::write( 'Runlight: the hourly check failed: ' . $error->getMessage() );
		}
	}

	/**
	 * Whether the upkeep has not finished for over a day: WordPress's cron is
	 * off, or nothing has visited the site to run it, or it keeps failing.
	 */
	public static function overdue(): bool {
		$checked = get_option( self::CHECKED );
		return self::active() && is_numeric( $checked ) && time() - (int) $checked > DAY_IN_SECONDS + HOUR_IN_SECONDS;
	}

	/**
	 * Records a page served to an AI agent, once the page has been sent.
	 *
	 * @param string $url   The page the agent fetched.
	 * @param string $agent The agent's user agent.
	 */
	public static function observe( string $url, string $agent ): void {
		Library::load();
		self::runlight()->observe( new Request( $url, 'GET', array( 'user-agent' => $agent ) ) );
	}
}
