<?php
/**
 * Plugin Name:       Runlight
 * Plugin URI:        https://runlight.sh/
 * Description:       Privacy friendly analytics with no cookies, kept in your own database. Runs Runlight inside WordPress, or sends to one you run elsewhere, counts AI agents that read your pages, and shows your dashboard in wp-admin.
 * Version:           0.1.1
 * Requires at least: 6.3
 * Requires PHP:      8.1
 * Author:            Jon C. Phillips
 * Author URI:        https://joncphillips.com/
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       runlight
 *
 * @package Runlight
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'RUNLIGHT_PLUGIN_FILE', __FILE__ );
define( 'RUNLIGHT_PLUGIN_VERSION', '0.1.1' );

require_once __DIR__ . '/includes/Agents.php';
require_once __DIR__ . '/includes/Settings.php';
require_once __DIR__ . '/includes/Storage.php';
require_once __DIR__ . '/includes/Library.php';
require_once __DIR__ . '/includes/Local.php';
require_once __DIR__ . '/includes/Tracker.php';
require_once __DIR__ . '/includes/Admin.php';
require_once __DIR__ . '/includes/Dashboard.php';
require_once __DIR__ . '/includes/Connect.php';

\Runlight\WordPress\Tracker::boot();
\Runlight\WordPress\Local::boot();
register_activation_hook(
	__FILE__,
	static function (): void {
		set_transient( \Runlight\WordPress\Admin::ACTIVATED, 1, 30 );
	}
);
register_deactivation_hook(
	__FILE__,
	static function ( $network_wide ): void {
		if ( ! $network_wide || ! is_multisite() ) {
			wp_clear_scheduled_hook( \Runlight\WordPress\Local::CRON );
			return;
		}
		// Deactivated for the whole network: each site's hourly check stops.
		foreach ( get_sites(
			array(
				'fields' => 'ids',
				'number' => 0,
			)
		) as $site ) {
			switch_to_blog( (int) $site );
			wp_clear_scheduled_hook( \Runlight\WordPress\Local::CRON );
			restore_current_blog();
		}
	}
);
if ( is_admin() ) {
	\Runlight\WordPress\Admin::boot();
	\Runlight\WordPress\Connect::boot();
}
