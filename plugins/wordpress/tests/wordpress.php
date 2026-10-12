<?php
/**
 * Stand-ins for the parts of WordPress the plugin calls, for its tests
 * (packages/sdk/test/plugins.test.ts). Options and transients live in a JSON
 * file named by RUNLIGHT_WP_STATE, so they last from one request to the next
 * as WordPress's database does, and a test can count the rows the plugin
 * leaves. Not part of the plugin's zip.
 *
 * @package Runlight
 */

// phpcs:ignoreFile -- test scaffolding, never shipped.

define( 'ABSPATH', __DIR__ . '/' );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'DAY_IN_SECONDS', 86400 );

$GLOBALS['wp_test'] = array(
	'state'   => (string) getenv( 'RUNLIGHT_WP_STATE' ),
	'home'    => getenv( 'RUNLIGHT_WP_HOME' ) ?: 'http://127.0.0.1',
	'uploads' => (string) getenv( 'RUNLIGHT_WP_UPLOADS' ),
	'now'     => null,
	'hooks'   => array(),
	'can'     => getenv( 'RUNLIGHT_WP_ADMIN' ) === '1',
);

/** The options table: name => [value, autoload]. */
function wp_test_options(): array {
	$file = $GLOBALS['wp_test']['state'];
	if ( isset( $GLOBALS['wp_test']['options'] ) ) {
		return $GLOBALS['wp_test']['options'];
	}
	$GLOBALS['wp_test']['options'] = '' !== $file && is_file( $file ) ? unserialize( (string) file_get_contents( $file ) ) : array();
	return $GLOBALS['wp_test']['options'];
}

function wp_test_save( array $options ): void {
	$GLOBALS['wp_test']['options'] = $options;
	if ( '' !== $GLOBALS['wp_test']['state'] ) {
		file_put_contents( $GLOBALS['wp_test']['state'], serialize( $options ) );
	}
}

function wp_test_now(): int {
	return $GLOBALS['wp_test']['now'] ?? time();
}

function get_option( $name, $default = false ) {
	$options = wp_test_options();
	return array_key_exists( $name, $options ) ? $options[ $name ] : $default;
}

function update_option( $name, $value, $autoload = null ): bool {
	$options          = wp_test_options();
	$options[ $name ] = $value;
	wp_test_save( $options );
	return true;
}

function add_option( $name, $value = '', $deprecated = '', $autoload = null ): bool {
	return false === get_option( $name ) ? update_option( $name, $value ) : false;
}

function wp_cache_delete( $key, $group = '' ): bool {
	return true;
}

function delete_option( $name ): bool {
	$options = wp_test_options();
	unset( $options[ $name ] );
	wp_test_save( $options );
	return true;
}

function get_site_option( $name, $default = false ) {
	return get_option( $name, $default );
}

// Transients as WordPress keeps them without an object cache: two options each, removed only when read after they expire.
function set_transient( $name, $value, $expiration = 0 ): bool {
	update_option( "_transient_$name", $value );
	if ( $expiration ) {
		update_option( "_transient_timeout_$name", wp_test_now() + $expiration );
	}
	return true;
}

function get_transient( $name ) {
	$timeout = get_option( "_transient_timeout_$name" );
	if ( false !== $timeout && $timeout < wp_test_now() ) {
		delete_transient( $name );
		return false;
	}
	return get_option( "_transient_$name" );
}

function delete_transient( $name ): bool {
	delete_option( "_transient_$name" );
	delete_option( "_transient_timeout_$name" );
	return true;
}

function wp_using_ext_object_cache( $using = null ): bool {
	return false;
}

function add_action( $hook, $callback, $priority = 10, $args = 1 ): bool {
	$GLOBALS['wp_test']['hooks'][ $hook ][ $priority ][] = $callback;
	return true;
}

function add_filter( $hook, $callback, $priority = 10, $args = 1 ): bool {
	return add_action( $hook, $callback, $priority, $args );
}

function do_action( $hook, ...$args ): void {
	$hooks = $GLOBALS['wp_test']['hooks'][ $hook ] ?? array();
	ksort( $hooks );
	foreach ( $hooks as $callbacks ) {
		foreach ( $callbacks as $callback ) {
			$callback( ...$args );
		}
	}
}

function apply_filters( $hook, $value, ...$args ) {
	$hooks = $GLOBALS['wp_test']['hooks'][ $hook ] ?? array();
	ksort( $hooks );
	foreach ( $hooks as $callbacks ) {
		foreach ( $callbacks as $callback ) {
			$value = $callback( $value, ...$args );
		}
	}
	return $value;
}

function has_filter( $hook, $callback = false ): bool {
	return ! empty( $GLOBALS['wp_test']['hooks'][ $hook ] );
}

function has_action( $hook, $callback = false ): bool {
	return has_filter( $hook, $callback );
}

function register_activation_hook( $file, $callback ): void {}
function register_deactivation_hook( $file, $callback ): void {}
function is_admin(): bool {
	return false;
}
function is_multisite(): bool {
	return isset( $GLOBALS['wp_test']['blogs'] );
}

// A network, when a test sets $GLOBALS['wp_test']['blogs'] to id => uploads folder: each site has options and
// uploads of its own, and the options of the sites not current wait in 'parked'.
function get_sites( $args = array() ): array {
	return array_keys( $GLOBALS['wp_test']['blogs'] ?? array() );
}
function get_current_blog_id(): int {
	return $GLOBALS['wp_test']['blog'] ?? 1;
}
function switch_to_blog( $id ): bool {
	$GLOBALS['wp_test']['stack'][] = get_current_blog_id();
	wp_test_blog( (int) $id );
	return true;
}
function restore_current_blog(): bool {
	wp_test_blog( (int) array_pop( $GLOBALS['wp_test']['stack'] ) );
	return true;
}
function wp_test_blog( int $id ): void {
	$GLOBALS['wp_test']['parked'][ get_current_blog_id() ] = wp_test_options();
	$GLOBALS['wp_test']['blog']                         = $id;
	$GLOBALS['wp_test']['options']                      = $GLOBALS['wp_test']['parked'][ $id ] ?? array();
	$GLOBALS['wp_test']['uploads']                      = $GLOBALS['wp_test']['blogs'][ $id ];
}
function is_404(): bool {
	return false;
}
function current_user_can( $capability, ...$args ): bool {
	return $GLOBALS['wp_test']['can'];
}
function home_url( $path = '' ): string {
	return rtrim( $GLOBALS['wp_test']['home'], '/' ) . '/' . ltrim( (string) $path, '/' );
}
function admin_url( $path = '' ): string {
	return home_url( 'wp-admin/' . ltrim( (string) $path, '/' ) );
}
function wp_login_url( $redirect = '' ): string {
	return home_url( 'wp-login.php?redirect_to=' . rawurlencode( (string) $redirect ) );
}
function wp_safe_redirect( $location, $status = 302 ): bool {
	header( "Location: $location", true, $status );
	return true;
}
function wp_parse_url( $url, $component = -1 ) {
	return parse_url( (string) $url, $component );
}
function wp_unslash( $value ) {
	return $value;
}
function sanitize_text_field( $value ): string {
	return trim( (string) $value );
}
function wp_strip_all_tags( $text ): string {
	return trim( strip_tags( (string) $text ) );
}
function wp_specialchars_decode( $text, $quotes = ENT_NOQUOTES ): string {
	return htmlspecialchars_decode( (string) $text, $quotes );
}
function get_bloginfo( $show = '' ): string {
	return 'name' === $show ? 'Test site' : '';
}
function wp_timezone_string(): string {
	return 'UTC';
}
function is_email( $email ) {
	return filter_var( $email, FILTER_VALIDATE_EMAIL ) ? $email : false;
}
function wp_upload_dir( $time = null, $create_dir = true, $refresh_cache = false ): array {
	return array( 'basedir' => $GLOBALS['wp_test']['uploads'] );
}
function trailingslashit( $value ): string {
	return rtrim( (string) $value, '/\\' ) . '/';
}
function untrailingslashit( $value ): string {
	return rtrim( (string) $value, '/\\' );
}
function wp_mkdir_p( $target ): bool {
	return is_dir( $target ) || mkdir( $target, 0777, true );
}
function wp_delete_file( $file ): void {
	@unlink( $file );
}
function wp_next_scheduled( $hook, $args = array() ) {
	return get_option( "cron:$hook" );
}
function wp_schedule_event( $timestamp, $recurrence, $hook, $args = array(), $wp_error = false ): bool {
	return update_option( "cron:$hook", $timestamp );
}
function wp_clear_scheduled_hook( $hook, $args = array(), $wp_error = false ): int {
	delete_option( "cron:$hook" );
	return 1;
}
function esc_url_raw( $url, $protocols = null ): string {
	return (string) $url;
}
function __( $text, $domain = 'default' ): string {
	return $text;
}
function wp_print_script_tag( $attributes ): void {
	$out = '<script';
	foreach ( $attributes as $name => $value ) {
		$out .= true === $value ? " $name" : ' ' . $name . '="' . htmlspecialchars( (string) $value ) . '"';
	}
	echo $out, "></script>\n";
}
function is_wp_error( $thing ): bool {
	return $thing instanceof WP_Error;
}
class WP_Error {
	public function __construct( private string $code = '', private string $message = '' ) {}
	public function get_error_message(): string {
		return $this->message;
	}
}
// No HTTP from the tests: every request the plugin makes fails, as it would offline.
function wp_remote_request( $url, $args = array() ) {
	return new WP_Error( 'offline', 'no network in tests' );
}
function wp_remote_get( $url, $args = array() ) {
	return wp_remote_request( $url, $args );
}
function wp_remote_post( $url, $args = array() ) {
	return wp_remote_request( $url, $args );
}
