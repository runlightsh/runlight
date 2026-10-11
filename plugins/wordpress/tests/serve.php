<?php
/**
 * A router for PHP's built-in server that hands each request to the plugin
 * as WordPress would, from the copy of the plugin RUNLIGHT_WP_PLUGIN names,
 * such as one unpacked from its zip. /__check runs the hourly upkeep. Any
 * request Runlight does not answer gets WordPress's own page. Not part of
 * the plugin's zip.
 *
 * @package Runlight
 */

// phpcs:ignoreFile -- test scaffolding, never shipped.

require __DIR__ . '/wordpress.php';
// A Runlight class the copy does not carry is a mistake in build.php, said plainly rather than as a missing method.
$runlight_plugin = rtrim( (string) getenv( 'RUNLIGHT_WP_PLUGIN' ), '/' );
spl_autoload_register(
	static function ( string $name ) use ( $runlight_plugin ): void {
		if ( ! str_starts_with( $name, 'Runlight\\' ) || str_starts_with( $name, 'Runlight\\WordPress\\' ) ) {
			return;
		}
		if ( ! is_file( $runlight_plugin . '/lib/src/' . str_replace( '\\', '/', substr( $name, strlen( 'Runlight\\' ) ) ) . '.php' ) ) {
			http_response_code( 500 );
			echo "missing class $name";
			exit;
		}
	}
);
require $runlight_plugin . '/runlight.php';
if ( '/__check' === $_SERVER['REQUEST_URI'] ) {
	do_action( 'init' );
	do_action( \Runlight\WordPress\Local::CRON );
	echo 'checked ', (int) get_option( \Runlight\WordPress\Local::CHECKED );
	return;
}
do_action( 'init' );
http_response_code( 404 );
echo 'WordPress';
