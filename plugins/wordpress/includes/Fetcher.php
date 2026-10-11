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

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Fetcher implements RunlightFetcher {
	/**
	 * One request, as Runlight asks for it.
	 *
	 * @param string              $url  The address.
	 * @param array<string,mixed> $init The request, with the keys fetch() takes.
	 */
	public function fetch( string $url, array $init = array() ): Response {
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
		// A pin connects to the address Runlight checked, with the name kept for the certificate.
		$pin = static function ( $handle ) use ( $init ): void {
			if ( ! empty( $init['resolve'] ) && defined( 'CURLOPT_RESOLVE' ) ) {
				curl_setopt( $handle, CURLOPT_RESOLVE, array_values( $init['resolve'] ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_setopt -- pins the address Runlight checked, on the handle WordPress made.
			}
		};
		add_action( 'http_api_curl', $pin );
		$response = wp_remote_request( $url, $args );
		remove_action( 'http_api_curl', $pin );

		if ( is_wp_error( $response ) ) {
			$message = $response->get_error_message();
			throw new FetchError( '' !== $message ? $message : 'fetch failed', (bool) preg_match( '/timed out|error 28/i', $message ) );
		}
		$body = (string) wp_remote_retrieve_body( $response );
		if ( null !== $max && strlen( $body ) > $max ) {
			if ( empty( $init['truncate'] ) ) {
				throw new BodyTooLong( "Body over $max bytes" );
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
