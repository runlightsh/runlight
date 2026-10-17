<?php
/**
 * The plugin's one option, and what it means.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Settings {
	public const OPTION = 'runlight_settings';

	/**
	 * The settings, with their defaults. Where Runlight runs is an empty string
	 * until the admin chooses on the setup screen, so nothing is counted before
	 * then; an address saved before there was a choice means another Runlight.
	 *
	 * @return array{mode:string,address:string,site:string,observe_key:string,dashboard_key:string,skip_admins:bool,outbound:bool,downloads:bool,locations:bool}
	 */
	public static function get(): array {
		$saved   = get_option( self::OPTION, array() );
		$saved   = is_array( $saved ) ? $saved : array();
		$address = isset( $saved['address'] ) ? (string) $saved['address'] : '';
		return array(
			'mode'        => in_array( $saved['mode'] ?? '', array( 'local', 'remote' ), true ) ? $saved['mode'] : ( '' !== $address ? 'remote' : '' ),
			'address'     => $address,
			'site'        => isset( $saved['site'] ) ? (string) $saved['site'] : '',
			'observe_key' => isset( $saved['observe_key'] ) ? (string) $saved['observe_key'] : '',
			'dashboard_key' => isset( $saved['dashboard_key'] ) ? (string) $saved['dashboard_key'] : '',
			'skip_admins' => ! isset( $saved['skip_admins'] ) || (bool) $saved['skip_admins'],
			'outbound'    => ! isset( $saved['outbound'] ) || (bool) $saved['outbound'],
			'downloads'   => ! isset( $saved['downloads'] ) || (bool) $saved['downloads'],
			'locations'   => ! empty( $saved['locations'] ),
		);
	}

	/** Whether a choice has been made on the setup screen: "elsewhere" with nothing entered is no choice yet. */
	public static function set_up(): bool {
		$settings = self::get();
		return 'local' === $settings['mode'] || ( 'remote' === $settings['mode'] && ( '' !== $settings['address'] || '' !== $settings['observe_key'] || '' !== $settings['dashboard_key'] ) );
	}

	/** The address of the Runlight the script and reports go to, wherever it runs, or an empty string for none yet. */
	public static function address(): string {
		$settings = self::get();
		if ( 'local' === $settings['mode'] ) {
			return Local::active() ? Local::address() : '';
		}
		return 'remote' === $settings['mode'] ? $settings['address'] : '';
	}

	/**
	 * Where Runlight is mounted, as typed in the settings, tidied: the full
	 * address of its routes, such as https://example.com/runlight in an app
	 * or https://stats.example.com for the standalone server.
	 */
	public static function sanitize_address( string $value ): string {
		$value = trim( $value );
		if ( '' === $value ) {
			return '';
		}
		// The script's own address works too.
		$value = preg_replace( '#/s\.js$#D', '', $value );
		$url   = esc_url_raw( untrailingslashit( (string) $value ), array( 'https', 'http' ) );
		return $url ? $url : '';
	}

	/**
	 * Whether the current user may change the Runlight address. The plugin asks
	 * that address from the server itself, and a Runlight may be on the same
	 * machine or network, so it cannot refuse private addresses. On a network
	 * of sites, then, only those who manage the network may set it, or a
	 * site's admin could have the server ask services the network keeps
	 * private. WP-CLI may always set it.
	 */
	public static function can_change_address(): bool {
		return ! is_multisite() || current_user_can( 'manage_network_options' ) || ( defined( 'WP_CLI' ) && WP_CLI );
	}

	/**
	 * Cleans what the settings form sent.
	 *
	 * @param mixed $input The submitted fields.
	 * @return array<string,mixed>
	 */
	public static function sanitize( $input ): array {
		$input  = is_array( $input ) ? $input : array();
		$before = self::get();
		$key       = isset( $input['observe_key'] ) ? trim( sanitize_text_field( wp_unslash( (string) $input['observe_key'] ) ) ) : '';
		$dashboard = isset( $input['dashboard_key'] ) ? trim( sanitize_text_field( wp_unslash( (string) $input['dashboard_key'] ) ) ) : '';
		$address   = self::sanitize_address( isset( $input['address'] ) ? sanitize_text_field( wp_unslash( (string) $input['address'] ) ) : '' );
		if ( ! self::can_change_address() ) {
			$address = $before['address'];
		}
		$same = $address === $before['address'];
		return array(
			'mode'        => in_array( $input['mode'] ?? '', array( 'local', 'remote' ), true ) ? $input['mode'] : $before['mode'],
			'address'     => $address,
			'site'        => isset( $input['site'] ) ? preg_replace( '/[^a-z0-9._-]/i', '', (string) $input['site'] ) : '',
			// Left blank, a saved key stays, so it never has to be shown again, but only for the same
			// address: pointed somewhere else, the plugin must never send that Runlight's key there.
			'observe_key' => '' === $key ? ( $same ? $before['observe_key'] : '' ) : $key,
			'dashboard_key' => '' === $dashboard ? ( $same ? $before['dashboard_key'] : '' ) : $dashboard,
			'skip_admins' => ! empty( $input['skip_admins'] ),
			'outbound'    => ! empty( $input['outbound'] ),
			'downloads'   => ! empty( $input['downloads'] ),
			'locations'   => ! empty( $input['locations'] ),
		);
	}
}
