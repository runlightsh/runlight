<?php
/**
 * The front end: the script tag, and AI agents reported to Runlight.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Tracker {
	public static function boot(): void {
		add_action( 'wp_enqueue_scripts', array( self::class, 'script' ) );
		add_action( 'template_redirect', array( self::class, 'observe' ) );
	}

	/** The Runlight script, deferred in the head, unless this visit should not count. */
	public static function script(): void {
		$settings = Settings::get();
		$address  = Settings::address();
		if ( '' === $address ) {
			return;
		}
		if ( $settings['skip_admins'] && current_user_can( 'manage_options' ) ) {
			return;
		}
		$attributes = array();
		if ( 'remote' === $settings['mode'] && '' !== $settings['site'] ) {
			$attributes['data-site'] = $settings['site'];
		}
		if ( ! $settings['outbound'] ) {
			$attributes['data-outbound'] = 'false';
		}
		if ( ! $settings['downloads'] ) {
			$attributes['data-downloads'] = 'false';
		}
		if ( is_404() ) {
			$attributes['data-404'] = true;
		}
		// Runlight's own script, served by the Runlight it reports to, unversioned since that Runlight caches it.
		wp_enqueue_script( 'runlight', $address . '/s.js', array(), null, array( 'strategy' => 'defer' ) ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion -- the Runlight serving it sets how long it is cached.
		add_filter(
			'wp_script_attributes',
			static function ( array $tag ) use ( $attributes ): array {
				return 'runlight-js' === ( $tag['id'] ?? '' ) ? array_merge( $tag, $attributes ) : $tag;
			}
		);
	}

	/**
	 * Reports a page served to an AI agent. Agents run no JavaScript, so the
	 * script never sees them. The report goes once the page has been sent, so
	 * the agent never waits for it, and only for known agents.
	 */
	public static function observe(): void {
		$settings = Settings::get();
		$local    = 'local' === $settings['mode'];
		// Runlight here records them itself; another one needs the agents key.
		if ( $local ? ! Local::active() : ( '' === $settings['address'] || '' === $settings['observe_key'] ) ) {
			return;
		}
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) : 'GET';
		$agent  = isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '';
		if ( 'GET' !== $method || ! Agents::is_agent( $agent ) || is_admin() || wp_doing_ajax() || wp_doing_cron() ) {
			return;
		}
		$path = isset( $_SERVER['REQUEST_URI'] ) ? esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/';
		$url  = self::page_url( $path );
		// Last of all at shutdown, once nothing else will write to the page.
		add_action(
			'shutdown',
			static function () use ( $settings, $local, $url, $agent ): void {
				self::report( $local ? null : $settings, $url, $agent );
			},
			PHP_INT_MAX
		);
	}

	/**
	 * The page's full address. The request's path already holds the folder
	 * WordPress lives in, so it goes after home_url's scheme and host alone,
	 * not after home_url itself, which would name that folder twice.
	 */
	private static function page_url( string $path ): string {
		$home = wp_parse_url( home_url() );
		if ( ! is_array( $home ) || empty( $home['host'] ) ) {
			return home_url( $path );
		}
		$scheme = isset( $home['scheme'] ) ? $home['scheme'] : 'https';
		$port   = isset( $home['port'] ) ? ':' . $home['port'] : '';
		return $scheme . '://' . $home['host'] . $port . '/' . ltrim( $path, '/' );
	}

	/**
	 * Sends the report. Under PHP-FPM or LiteSpeed the agent waits until PHP
	 * finishes, even after the page is out, so the connection is closed first.
	 *
	 * @param array{address:string,observe_key:string}|null $settings The plugin's settings, or null for Runlight here.
	 * @param string                                        $url      The page the agent fetched.
	 * @param string                                        $agent    The agent's user agent.
	 */
	private static function report( ?array $settings, string $url, string $agent ): void {
		if ( session_status() === PHP_SESSION_ACTIVE ) {
			session_write_close();
		}
		if ( function_exists( 'fastcgi_finish_request' ) ) {
			fastcgi_finish_request();
		} elseif ( function_exists( 'litespeed_finish_request' ) ) {
			litespeed_finish_request();
		}
		if ( null === $settings ) {
			Local::observe( $url, $agent );
			return;
		}
		wp_remote_post(
			$settings['address'] . '/api/observe',
			array(
				'timeout' => 3,
				'headers' => array(
					'authorization' => 'Bearer ' . $settings['observe_key'],
					'content-type'  => 'application/json',
				),
				'body'    => wp_json_encode(
					array(
						'url'       => $url,
						'userAgent' => $agent,
					)
				),
			)
		);
	}
}
