<?php
/**
 * Removes everything the plugin stored, on every site of a network: its
 * settings, and when Runlight ran in a site, its numbers, in its own tables
 * or in its own folder under uploads, with the location data.
 *
 * @package Runlight
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

require_once __DIR__ . '/includes/Storage.php';
require_once __DIR__ . '/includes/Library.php';
require_once __DIR__ . '/includes/Local.php';

/** Removes what the plugin stored for the current site. */
function runlight_uninstall_site(): void {
	$folder = \Runlight\WordPress\Storage::folder();
	\Runlight\WordPress\Storage::remove();
	// The folder is the plugin's alone: what Runlight kept there goes with it.
	if ( is_dir( $folder ) ) {
		\Runlight\WordPress\Storage::files()->rmdir( $folder, true );
	}
	wp_clear_scheduled_hook( \Runlight\WordPress\Local::CRON );
	delete_option( 'runlight_settings' );
	delete_option( \Runlight\WordPress\Local::SECRET );
	delete_option( \Runlight\WordPress\Local::CHECKED );
	// The plugin's transients (rate counts, the site's icon, notes), whose names all start runlight_.
	global $wpdb;
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s", $wpdb->esc_like( '_transient_runlight_' ) . '%', $wpdb->esc_like( '_transient_timeout_runlight_' ) . '%' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- the plugin's own transients, removed on uninstall.
}

if ( is_multisite() ) {
	foreach ( get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	) as $runlight_site ) {
		switch_to_blog( (int) $runlight_site );
		runlight_uninstall_site();
		restore_current_blog();
	}
} else {
	runlight_uninstall_site();
}
