<?php
/**
 * Connecting to a Runlight without copying keys: the plugin registers itself
 * with the Runlight's OAuth server, sends the admin to its consent page to
 * pick this site, and on the way back swaps the code, checked with PKCE, for
 * the site's dashboard key, agents key, and id, which it saves.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Connect {
	/** How long a connection may wait on the consent page before it has to be started again. */
	private const PENDING = 15 * MINUTE_IN_SECONDS;

	public static function boot(): void {
		add_action( 'admin_post_runlight_connect', array( self::class, 'start' ) );
		add_action( 'admin_post_runlight_connected', array( self::class, 'finish' ) );
	}

	/** Where the Runlight sends the admin back to, which it is registered with. */
	private static function back(): string {
		return admin_url( 'admin-post.php?action=runlight_connected' );
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
	 * Whether this admin is somewhere a Runlight can send people back to: https,
	 * or this computer while trying things out.
	 */
	public static function possible(): bool {
		$back = wp_parse_url( self::back() );
		$host = strtolower( (string) ( $back['host'] ?? '' ) );
		return 'https' === ( $back['scheme'] ?? '' ) || in_array( $host, array( 'localhost', '127.0.0.1', '[::1]' ), true );
	}

	/**
	 * JSON from the Runlight, or null when it could not be reached or did not answer with any.
	 *
	 * @param array<string,mixed>|\WP_Error $response What wp_remote_* returned.
	 * @return array<string,mixed>|null
	 */
	private static function json( $response ): ?array {
		if ( is_wp_error( $response ) ) {
			return null;
		}
		$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		return is_array( $body ) ? $body : null;
	}

	/** Starts connecting, from the Connect button on the settings page. */
	public static function start(): void {
		check_admin_referer( 'runlight_connect', 'runlight_connect_nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Sorry, you are not allowed to connect this site.', 'runlight' ), 403 );
		}
		$fields  = isset( $_POST[ Settings::OPTION ] ) && is_array( $_POST[ Settings::OPTION ] ) ? wp_unslash( $_POST[ Settings::OPTION ] ) : array(); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- the one field used is sanitized below.
		$address = Settings::sanitize_address( sanitize_text_field( (string) ( $fields['address'] ?? '' ) ) );
		if ( ! Settings::can_change_address() ) {
			$address = Settings::get()['address'];
		}
		if ( '' === $address ) {
			self::done( __( 'Enter your Runlight’s address, then press Connect.', 'runlight' ) );
		}
		if ( ! self::possible() ) {
			self::done( __( 'Connecting needs this site’s admin on https. Copy the keys from Runlight’s Settings, Install into the fields below instead.', 'runlight' ) );
		}

		$meta = self::json( wp_remote_get( $address . '/.well-known/oauth-authorization-server', array( 'timeout' => 10, 'redirection' => 0 ) ) );
		if ( null === $meta || ! is_string( $meta['authorization_endpoint'] ?? null ) || ! is_string( $meta['token_endpoint'] ?? null ) || ! is_string( $meta['registration_endpoint'] ?? null ) ) {
			/* translators: %s: the Runlight's address */
			self::done( sprintf( __( 'Could not connect to a Runlight at %s. Check the address, which is shown in Runlight under Settings, Install.', 'runlight' ), $address ) );
		}
		// Its endpoints must be on its own address, so an address cannot send this server's requests elsewhere.
		$origin = self::origin( $address );
		foreach ( array( 'authorization_endpoint', 'token_endpoint', 'registration_endpoint' ) as $endpoint ) {
			if ( self::origin( $meta[ $endpoint ] ) !== $origin ) {
				/* translators: %s: the Runlight's address */
				self::done( sprintf( __( 'Could not connect to a Runlight at %s. Check the address, which is shown in Runlight under Settings, Install.', 'runlight' ), $address ) );
			}
		}
		if ( ! in_array( 'cms', (array) ( $meta['scopes_supported'] ?? array() ), true ) ) {
			self::done( __( 'Your Runlight is older than this plugin. Update it, or copy the keys from its Settings, Install into the fields below.', 'runlight' ) );
		}

		$client = self::json(
			wp_remote_post(
				$meta['registration_endpoint'],
				array(
					'timeout'     => 10,
					'redirection' => 0,
					'headers'     => array( 'Content-Type' => 'application/json' ),
					/* translators: %s: this site's host */
					'body'        => (string) wp_json_encode( array( 'client_name' => sprintf( __( 'WordPress at %s', 'runlight' ), (string) wp_parse_url( home_url(), PHP_URL_HOST ) ), 'redirect_uris' => array( self::back() ) ) ),
				)
			)
		);
		if ( null === $client || ! is_string( $client['client_id'] ?? null ) ) {
			$reason = is_string( $client['error_description'] ?? null ) ? $client['error_description'] : __( 'It did not say why.', 'runlight' );
			/* translators: %s: what the Runlight said */
			self::done( sprintf( __( 'Your Runlight would not let this site connect: %s', 'runlight' ), $reason ) );
		}

		$state    = bin2hex( random_bytes( 16 ) );
		$verifier = rtrim( strtr( base64_encode( random_bytes( 48 ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- PKCE wants base64url.
		set_transient(
			self::key( 'connect' ),
			array(
				'state'    => $state,
				'verifier' => $verifier,
				'client'   => $client['client_id'],
				'token'    => $meta['token_endpoint'],
				'address'  => $address,
			),
			self::PENDING
		);
		$challenge = rtrim( strtr( base64_encode( hash( 'sha256', $verifier, true ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- PKCE wants base64url.
		$to        = add_query_arg(
			rawurlencode_deep(
				array(
					'response_type'         => 'code',
					'client_id'             => $client['client_id'],
					'redirect_uri'          => self::back(),
					'code_challenge'        => $challenge,
					'code_challenge_method' => 'S256',
					'scope'                 => 'cms',
					'state'                 => $state,
				)
			),
			$meta['authorization_endpoint']
		);
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
		// Each attempt works once, and only for the admin who started it: the state it was sent with proves that.
		$pending = get_transient( self::key( 'connect' ) );
		delete_transient( self::key( 'connect' ) );
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- the state, kept for this admin and compared below, does a nonce's work.
		$state = isset( $_GET['state'] ) ? sanitize_text_field( wp_unslash( $_GET['state'] ) ) : '';
		if ( ! is_array( $pending ) || ! hash_equals( (string) ( $pending['state'] ?? '' ), $state ) ) {
			self::done( __( 'That connection took too long or was already used. Press Connect again.', 'runlight' ) );
		}
		if ( isset( $_GET['error'] ) ) {
			if ( 'access_denied' === $_GET['error'] ) {
				self::done( __( 'The connection was not allowed.', 'runlight' ) );
			}
			$reason = isset( $_GET['error_description'] ) ? sanitize_text_field( wp_unslash( $_GET['error_description'] ) ) : sanitize_text_field( wp_unslash( $_GET['error'] ) );
			/* translators: %s: what the Runlight said */
			self::done( sprintf( __( 'Your Runlight did not connect this site: %s', 'runlight' ), $reason ) );
		}
		$code = isset( $_GET['code'] ) ? sanitize_text_field( wp_unslash( $_GET['code'] ) ) : '';
		// phpcs:enable WordPress.Security.NonceVerification.Recommended

		$granted = self::json(
			wp_remote_post(
				$pending['token'],
				array(
					'timeout'     => 10,
					'redirection' => 0,
					'body'        => array(
						'grant_type'    => 'authorization_code',
						'code'          => $code,
						'client_id'     => $pending['client'],
						'redirect_uri'  => self::back(),
						'code_verifier' => $pending['verifier'],
					),
				)
			)
		);
		if ( null === $granted || ! is_string( $granted['access_token'] ?? null ) || ! is_string( $granted['agents_key'] ?? null ) ) {
			self::done( __( 'Your Runlight did not give this site its keys. Press Connect again.', 'runlight' ) );
		}
		$site   = is_string( $granted['site'] ?? null ) ? $granted['site'] : '';
		$before = Settings::get();
		update_option(
			Settings::OPTION,
			array(
				'mode'          => 'remote',
				'address'       => $pending['address'],
				'site'          => $site,
				'observe_key'   => $granted['agents_key'],
				'dashboard_key' => $granted['access_token'],
				'skip_admins'   => $before['skip_admins'],
				'outbound'      => $before['outbound'],
				'downloads'     => $before['downloads'],
				'locations'     => $before['locations'],
			)
		);
		/* translators: %s: the site's id in Runlight */
		self::done( sprintf( __( 'Connected. Runlight counts this site as %s.', 'runlight' ), $site ), true );
	}

	/** The scheme, host, and port of an address. */
	private static function origin( string $address ): string {
		$parts = wp_parse_url( $address );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return '';
		}
		return strtolower( $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' ) );
	}
}
