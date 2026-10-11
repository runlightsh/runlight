<?php
/**
 * Runlight's outgoing requests, made through WordPress's HTTP API, so they
 * follow this site's proxy settings and the filters other plugins put on it.
 * Runlight sends them for what an owner sets up in its dashboard: email
 * through a mail service, imports, the assistant's AI provider, and a site's
 * icon.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

use Runlight\Http\BodyTooLong;
use Runlight\Http\Fetcher as RunlightFetcher;
use Runlight\Http\FetchError;
use Runlight\Http\Headers;
use Runlight\Http\Response;
use Runlight\Http\Url;
use Runlight\Safefetch;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Fetcher implements RunlightFetcher {
	/** Redirects followed for one pinned request, as WordPress's own limit for Runlight's requests is. */
	private const MAX_REDIRECTS = 20;

	/**
	 * One request, as Runlight asks for it.
	 *
	 * @param string              $url  The address.
	 * @param array<string,mixed> $init The request, with the keys fetch() takes.
	 * @throws FetchError When no answer came, or a pinned request could not be held to its pin.
	 */
	public function fetch( string $url, array $init = array() ): Response {
		if ( empty( $init['resolve'] ) || 'manual' === ( $init['redirect'] ?? 'follow' ) ) {
			return $this->send( $url, $init );
		}
		// A pinned request's redirects are followed here, so each one is checked against the pins as the first address was.
		for ( $hop = 0; ; $hop++ ) {
			$answer   = $this->send( $url, array( 'redirect' => 'manual' ) + $init );
			$location = $answer->headers->get( 'location' );
			if ( $answer->status < 300 || $answer->status >= 400 || null === $location || '' === $location ) {
				return $answer;
			}
			if ( $hop >= self::MAX_REDIRECTS ) {
				throw new FetchError( 'Too many redirects.' );
			}
			$url = ( new Url( $location, $url ) )->href();
		}
	}

	/**
	 * One request, with no redirect followed when it is pinned.
	 *
	 * @param string              $url  The address.
	 * @param array<string,mixed> $init The request, with the keys fetch() takes.
	 * @throws FetchError When no answer came, or a pinned request could not be held to its pin.
	 * @throws BodyTooLong When the answer is longer than maxBytes allows.
	 */
	private function send( string $url, array $init ): Response {
		$headers = $init['headers'] ?? array();
		$headers = $headers instanceof Headers ? $headers : new Headers( $headers );
		$flat    = array();
		foreach ( $headers->all() as $name => $values ) {
			$flat[ $name ] = implode( ', ', $values );
		}
		$max  = isset( $init['maxBytes'] ) ? (int) $init['maxBytes'] : null;
		$args = array(
			'method'      => strtoupper( (string) ( $init['method'] ?? 'GET' ) ),
			'headers'     => $flat,
			'timeout'     => ( (int) ( $init['timeoutMs'] ?? 30000 ) ) / 1000,
			'redirection' => ( $init['redirect'] ?? 'follow' ) === 'manual' ? 0 : 20,
		);
		if ( isset( $init['body'] ) && ! in_array( $args['method'], array( 'GET', 'HEAD' ), true ) ) {
			$args['body'] = (string) $init['body'];
		}
		// One byte past the limit is enough to know the answer is too long.
		if ( null !== $max ) {
			$args['limit_response_size'] = $max + 1;
		}
		if ( empty( $init['resolve'] ) ) {
			$response = wp_remote_request( $url, $args );
		} else {
			$response = $this->pinned( $url, $args, array_values( $init['resolve'] ) );
		}

		if ( is_wp_error( $response ) ) {
			$message = $response->get_error_message();
			throw new FetchError( '' !== $message ? $message : 'fetch failed', (bool) preg_match( '/timed out|error 28/i', $message ) ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- never printed as HTML: Runlight puts it in a JSON answer or a log line.
		}
		$body = (string) wp_remote_retrieve_body( $response );
		if ( null !== $max && strlen( $body ) > $max ) {
			if ( empty( $init['truncate'] ) ) {
				throw new BodyTooLong( sprintf( 'Body over %d bytes', (int) $max ) );
			}
			$body = substr( $body, 0, $max );
		}
		$received = array();
		$found    = wp_remote_retrieve_headers( $response );
		foreach ( is_object( $found ) && method_exists( $found, 'getAll' ) ? $found->getAll() : (array) $found as $name => $value ) {
			$received[ strtolower( (string) $name ) ] = array_map( 'strval', (array) $value );
		}
		return new Response( $body, (int) wp_remote_retrieve_response_code( $response ), $received );
	}

	/**
	 * A request held to the addresses Runlight checked, with the name kept for the certificate. Only WordPress's
	 * curl transport can be told the address, and only without a proxy, which would look the name up again, so
	 * otherwise the request is refused before it connects, as is an address no pin names. The answer counts only
	 * from a pinned address.
	 *
	 * @param string              $url  The address.
	 * @param array<string,mixed> $args The request, as wp_remote_request() takes it.
	 * @param string[]            $pins "host:port:address" pins.
	 * @return array|\WP_Error The answer.
	 * @throws FetchError When the pin cannot be applied.
	 */
	private function pinned( string $url, array $args, array $pins ) {
		$addresses = Safefetch::pinned( $url, $pins );
		if ( ! function_exists( 'curl_init' ) || ! defined( 'CURLOPT_RESOLVE' ) ) {
			throw new FetchError( 'Runlight needs PHP’s curl extension to make this request safely.' );
		}
		$proxy = new \WP_HTTP_Proxy();
		if ( $proxy->is_enabled() && $proxy->send_through_proxy( $url ) ) {
			throw new FetchError( 'Runlight cannot make this request safely through a proxy.' );
		}
		$applied = false;
		$reached = false;
		$pin     = static function ( $handle ) use ( $pins, &$applied ): void {
			// No proxy from the environment either, which curl would read itself.
			curl_setopt( $handle, CURLOPT_RESOLVE, $pins ); // phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_setopt -- pins the address Runlight checked, on the handle WordPress made.
			curl_setopt( $handle, CURLOPT_PROXY, '' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_setopt -- keeps a proxy from looking the name up again.
			$applied = true;
		};
		$check   = static function ( $headers, $info ) use ( $addresses, &$reached ): void {
			$connected = is_array( $info ) ? (string) ( $info['primary_ip'] ?? '' ) : '';
			foreach ( $addresses as $address ) {
				if ( '' !== $connected && @inet_pton( trim( $connected, '[]' ) ) === @inet_pton( $address ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- an address that is not one compares as false.
					$reached = true;
				}
			}
		};
		// Before it connects, so WordPress answers with its usual error.
		$refuse = static function (): void {
			throw new \WpOrg\Requests\Exception( 'Runlight needs WordPress’s curl transport to make this request safely.', 'runlight_unpinned' ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- a fixed message, never printed as HTML.
		};
		add_action( 'http_api_curl', $pin );
		add_action( 'requests-curl.after_request', $check, 10, 2 );
		add_action( 'requests-fsockopen.before_request', $refuse );
		try {
			$response = wp_remote_request( $url, $args );
		} finally {
			remove_action( 'http_api_curl', $pin );
			remove_action( 'requests-curl.after_request', $check, 10 );
			remove_action( 'requests-fsockopen.before_request', $refuse );
		}
		if ( ! is_wp_error( $response ) && ( ! $applied || ! $reached ) ) {
			throw new FetchError( 'Runlight did not reach the address it checked, so the answer is not used.' );
		}
		return $response;
	}

	/**
	 * Saves the file at an address, for DB-IP's location data: whether it
	 * arrived whole.
	 *
	 * @param string $url  The address.
	 * @param string $file Where to save it.
	 */
	public static function download( string $url, string $file ): bool {
		$response = wp_remote_get(
			$url,
			array(
				'timeout'  => 300,
				'stream'   => true,
				'filename' => $file,
			)
		);
		if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
			wp_delete_file( $file );
			return false;
		}
		return true;
	}
}
