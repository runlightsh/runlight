<?php
/**
 * Removes everything the plugin stored: its settings, and when Runlight ran
 * in this WordPress, its numbers, in its own tables or in its own folder
 * under uploads, with the location data.
 *
 * @package Runlight
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

require_once __DIR__ . '/includes/Storage.php';

$runlight_folder = \Runlight\WordPress\Storage::folder();
\Runlight\WordPress\Storage::remove();
// The folder is the plugin's alone: what Runlight kept there goes with it.
if ( is_dir( $runlight_folder ) ) {
	$runlight_walk = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $runlight_folder, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST );
	foreach ( $runlight_walk as $runlight_entry ) {
		if ( $runlight_entry->isDir() ) {
			rmdir( $runlight_entry->getPathname() ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- the plugin's own folder, emptied first.
		} else {
			wp_delete_file( $runlight_entry->getPathname() );
		}
	}
	rmdir( $runlight_folder ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- the plugin's own folder, emptied above.
}
wp_clear_scheduled_hook( 'runlight_check' );
delete_option( 'runlight_settings' );
delete_option( 'runlight_secret' );
