<?php
/**
 * Connecting to a Runlight without copying keys: the package's Connect
 * (Runlight\Cms\Connect) registers the plugin with the Runlight's OAuth
 * server, sends the admin to its consent page to pick this site, and on the
 * way back swaps the code, checked with PKCE, for the site's dashboard key,
 * agents key, and id. This class gives it WordPress's HTTP API and the
 * plugin's words, keeps the attempt in a transient, and saves the keys.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

use Runlight\Cms\Connect as CmsConnect;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Connect {
	public static function boot(): void {
		add_action( 'admin_post_runlight_connect', array( self::class, 'start' ) );
		add_action( 'admin_post_runlight_connected', array( self::class, 'finish' ) );
	}

	/**
	 * Where the Runlight sends the admin back to, which it is registered with. Each attempt registers
	 * afresh, so the address carries a nonce for the admin who started it.
	 *
	 * @param string $nonce The attempt's nonce.
	 */
	private static function back( string $nonce ): string {
		return admin_url( 'admin-post.php?action=runlight_connected&_wpnonce=' . rawurlencode( $nonce ) );
	}

	/** Back to the settings page, or once connected to the numbers, with what happened to say there. */
	private static function done( string $message, bool $ok = false ): void {
		set_transient( self::key( 'notice' ), array( $ok, $message ), MINUTE_IN_SECONDS );
		wp_safe_redirect( admin_url( $ok ? 'admin.php?page=' . Dashboard::PAGE : 'options-general.php?page=runlight' ) );
		exit;
	}

	/** A transient for the current admin only. */
	private static function key( string $what ): string {
		return 'runlight_' . $what . '_' . get_current_user_id();
	}

	/**
	 * What connecting last said, once, for the settings page.
	 *
	 * @return array{0:bool,1:string}|null
	 */
	public static function notice(): ?array {
		$notice = get_transient( self::key( 'notice' ) );
		delete_transient( self::key( 'notice' ) );
		return is_array( $notice ) && 2 === count( $notice ) ? array( (bool) $notice[0], (string) $notice[1] ) : null;
	}

	/**
	 * The package's Connect, with WordPress's HTTP API and this plugin's words.
	 *
	 * @param string $nonce The attempt's nonce, which the address it comes back to carries.
	 */
	private static function connect( string $nonce ): CmsConnect {
		Library::load();
		if ( ! class_exists( CmsConnect::class ) ) {
			self::done( __( 'This copy of the plugin is missing its vendor folder. Install it again from WordPress.org.', 'runlight' ) );
		}
		require_once __DIR__ . '/Fetcher.php';
		return new CmsConnect( new Fetcher(), self::back( $nonce ), array( self::class, 'say' ) );
	}

	/**
	 * What to say about each step of connecting, by the package's codes.
	 *
	 * @param string               $code   What happened.
	 * @param array<string,string> $params Its details.
	 */
	public static function say( string $code, array $params ): string {
		switch ( $code ) {
			case 'address':
				return __( 'Enter your Runlight’s address, then press Connect.', 'runlight' );
			case 'scheme':
				return __( 'Enter a web address, such as https://stats.example.com.', 'runlight' );
			case 'https':
				return __( 'Connecting needs this site’s admin on https. Copy the keys from Runlight’s Settings, Install into the fields below instead.', 'runlight' );
			case 'unreachable':
				/* translators: 1: the Runlight's address, 2: why it could not be reached */
				return sprintf( __( 'Could not reach a Runlight at %1$s: %2$s', 'runlight' ), $params['address'], $params['error'] );
			case 'unknown':
				/* translators: %s: the Runlight's address */
				return sprintf( __( 'Could not connect to a Runlight at %s. Check the address, which is shown in Runlight under Settings, Install.', 'runlight' ), $params['address'] );
			case 'older':
				return __( 'Your Runlight is older than this plugin. Update it, or copy the keys from its Settings, Install into the fields below.', 'runlight' );
			case 'client':
				/* translators: %s: this site's host */
				return sprintf( __( 'WordPress at %s', 'runlight' ), $params['host'] );
			case 'silent':
				return __( 'It did not say why.', 'runlight' );
			case 'refused':
				/* translators: %s: what the Runlight said */
				return sprintf( __( 'Your Runlight would not let this site connect: %s', 'runlight' ), $params['reason'] );
			case 'expired':
				return __( 'That connection took too long or was already used. Press Connect again.', 'runlight' );
			case 'denied':
				return __( 'The connection was not allowed.', 'runlight' );
			case 'failed':
				/* translators: %s: what the Runlight said */
				return sprintf( __( 'Your Runlight did not connect this site: %s', 'runlight' ), $params['reason'] );
			case 'lost':
				/* translators: %s: why the Runlight could not be reached */
				return sprintf( __( 'Could not reach your Runlight to finish connecting: %s', 'runlight' ), $params['error'] );
			case 'keys':
				return __( 'Your Runlight did not give this site its keys. Press Connect again.', 'runlight' );
			case 'connected':
				/* translators: %s: the site's id in Runlight */
				return sprintf( __( 'Connected. Runlight counts this site as %s.', 'runlight' ), $params['site'] );
		}
		return $code;
	}

	/** Starts connecting, from the Connect button on the settings page. */
	public static function start(): void {
		check_admin_referer( 'runlight_connect', 'runlight_connect_nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Sorry, you are not allowed to connect this site.', 'runlight' ), 403 );
		}
		$address = isset( $_POST[ Settings::OPTION ]['address'] ) && is_string( $_POST[ Settings::OPTION ]['address'] )
			? Settings::sanitize_address( sanitize_text_field( wp_unslash( $_POST[ Settings::OPTION ]['address'] ) ) )
			: '';
		if ( ! Settings::can_change_address() ) {
			$address = Settings::get()['address'];
		}
		[ $to, $pending, $error ] = self::connect( wp_create_nonce( 'runlight_connected' ) )->start( $address );
		if ( null === $to ) {
			self::done( $error );
		}
		set_transient( self::key( 'connect' ), $pending, CmsConnect::WAIT );
		// The consent page is on the Runlight, which is allowed as a place to send the admin for this one redirect.
		$host = (string) wp_parse_url( $to, PHP_URL_HOST );
		add_filter(
			'allowed_redirect_hosts',
			static function ( array $hosts ) use ( $host ): array {
				$hosts[] = $host;
				return $hosts;
			}
		);
		wp_safe_redirect( $to );
		exit;
	}

	/** Finishes connecting when the Runlight sends the admin back. */
	public static function finish(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Sorry, you are not allowed to connect this site.', 'runlight' ), 403 );
		}
		// Each attempt works once, and only for the admin who started it: its nonce and the state it was sent with prove that.
		$pending = get_transient( self::key( 'connect' ) );
		delete_transient( self::key( 'connect' ) );
		$nonce = isset( $_GET['_wpnonce'] ) && is_string( $_GET['_wpnonce'] ) ? sanitize_key( wp_unslash( $_GET['_wpnonce'] ) ) : '';
		if ( ! wp_verify_nonce( $nonce, 'runlight_connected' ) ) {
			self::done( self::say( 'expired', array() ) );
		}
		$query = array();
		foreach ( array( 'state', 'code', 'error', 'error_description' ) as $name ) {
			if ( isset( $_GET[ $name ] ) && is_string( $_GET[ $name ] ) ) {
				$query[ $name ] = sanitize_text_field( wp_unslash( $_GET[ $name ] ) );
			}
		}
		// The address it was registered with, so the same nonce.
		[ $granted, $message ] = self::connect( $nonce )->finish( $query, $pending );
		if ( null === $granted ) {
			self::done( $message );
		}
		$before = Settings::get();
		update_option(
			Settings::OPTION,
			array(
				'mode'          => 'remote',
				'address'       => $granted['address'],
				'site'          => $granted['site'],
				'observe_key'   => $granted['agentsKey'],
				'dashboard_key' => $granted['dashboardKey'],
				'skip_admins'   => $before['skip_admins'],
				'outbound'      => $before['outbound'],
				'downloads'     => $before['downloads'],
				'locations'     => $before['locations'],
			)
		);
		self::done( $message, true );
	}
}
