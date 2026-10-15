<?php
/**
 * wp-admin: the settings page, the menu item for the dashboard, and a check
 * that the address answers.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Admin {
	private const PAGE = 'runlight';

	public static function boot(): void {
		add_action( 'admin_menu', array( self::class, 'menu' ) );
		add_action( 'admin_init', array( self::class, 'register' ) );
		add_action( 'admin_enqueue_scripts', array( Dashboard::class, 'scripts' ) );
		add_action( 'admin_enqueue_scripts', array( self::class, 'scripts' ) );
		add_action( 'wp_ajax_runlight_check', array( self::class, 'ajax_check' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( RUNLIGHT_PLUGIN_FILE ), array( self::class, 'action_links' ) );
		add_action( 'admin_init', array( self::class, 'after_activation' ) );
		add_action( 'admin_notices', array( self::class, 'setup_notice' ) );
	}

	/** Set when the plugin is activated, so the next admin page can open the setup screen. */
	public const ACTIVATED = 'runlight_activated';

	/**
	 * Opens the setup screen once, right after the plugin is activated on its
	 * own, and only while there is still a choice to make.
	 */
	public static function after_activation(): void {
		if ( ! get_transient( self::ACTIVATED ) ) {
			return;
		}
		delete_transient( self::ACTIVATED );
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- only tells a bulk activation apart, which WordPress checked.
		if ( wp_doing_ajax() || is_network_admin() || isset( $_GET['activate-multi'] ) || Settings::set_up() || ! current_user_can( 'manage_options' ) ) {
			return;
		}
		wp_safe_redirect( admin_url( 'options-general.php?page=' . self::PAGE ) );
		exit;
	}

	/** A reminder on the Dashboard and Plugins screens until Runlight is set up. */
	public static function setup_notice(): void {
		$screen = get_current_screen();
		if ( null === $screen || ! in_array( $screen->id, array( 'dashboard', 'plugins' ), true ) || Settings::set_up() || ! current_user_can( 'manage_options' ) ) {
			return;
		}
		printf(
			'<div class="notice notice-info"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__( 'Runlight is not counting yet. Choose where it runs.', 'runlight' ),
			esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ),
			esc_html__( 'Set up Runlight', 'runlight' )
		);
	}

	public static function menu(): void {
		add_options_page( __( 'Runlight', 'runlight' ), __( 'Runlight', 'runlight' ), 'manage_options', self::PAGE, array( self::class, 'page' ) );
		// A top-level item for the dashboard, where the numbers are, or the steps to see them there.
		// No position, so it sits below the core items.
		add_menu_page( __( 'Runlight', 'runlight' ), __( 'Runlight', 'runlight' ), 'manage_options', Dashboard::PAGE, array( Dashboard::class, 'page' ), self::icon() );
	}

	/** The R mark, as wp-admin's menu wants it: a data URI it can tint. */
	private static function icon(): string {
		$svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="black" fill-rule="evenodd" d="M9.5 2.5h13a7 7 0 0 1 7 7v13a7 7 0 0 1-7 7h-13a7 7 0 0 1-7-7v-13a7 7 0 0 1 7-7zM11 9v14h2.8v-4.6h2.2l3.9 4.6h3.5l-4.3-5a4.3 4.3 0 0 0-1.9-9zm2.8 2.6h3.4a1.7 1.7 0 0 1 0 3.4h-3.4z"/></svg>';
		return 'data:image/svg+xml;base64,' . base64_encode( $svg ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
	}

	/**
	 * Settings and Dashboard links on the Plugins screen.
	 *
	 * @param array<int|string,string> $links The links WordPress shows.
	 * @return array<int|string,string>
	 */
	public static function action_links( array $links ): array {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ) . '">' . esc_html__( 'Settings', 'runlight' ) . '</a>' );
		return $links;
	}

	public static function register(): void {
		register_setting(
			'runlight',
			Settings::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( Settings::class, 'sanitize' ),
			)
		);
	}

	/** Whether the address answers as a Runlight, and what to say about it. */
	private static function check( string $address ): array {
		$response = wp_remote_get( $address . '/api', array( 'timeout' => 5 ) );
		if ( is_wp_error( $response ) ) {
			return array( false, sprintf( /* translators: %s: the error */ __( 'Could not reach it: %s', 'runlight' ), $response->get_error_message() ) );
		}
		$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( 200 !== wp_remote_retrieve_response_code( $response ) || ! is_array( $body ) || 'runlight' !== ( $body['name'] ?? '' ) ) {
			return array( false, __( 'Something answered, but not Runlight. Check that this is the address Runlight answers at, such as https://example.com/runlight for an app with Runlight mounted, or https://stats.example.com for the standalone server.', 'runlight' ) );
		}
		return array( true, sprintf( /* translators: %s: the version */ __( 'Connected to Runlight %s.', 'runlight' ), (string) ( $body['version'] ?? '' ) ) );
	}

	/**
	 * The check, asked for by the settings page once it has loaded, so a slow
	 * or missing Runlight never holds the page up. Only the saved address is
	 * checked, never one the request names.
	 */
	public static function ajax_check(): void {
		check_ajax_referer( 'runlight_check' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( null, 403 );
		}
		$address = Settings::get()['address'];
		if ( '' === $address ) {
			wp_send_json_success( null );
		}
		list( $ok, $message ) = self::check( $address );
		wp_send_json_success(
			array(
				'ok'      => $ok,
				'message' => $message,
			)
		);
	}

	/** The settings page's script, which asks for the check and shows its answer. */
	public static function scripts( string $hook ): void {
		if ( 'settings_page_' . self::PAGE !== $hook ) {
			return;
		}
		$config = array(
			'url'       => admin_url( 'admin-ajax.php' ),
			'nonce'     => wp_create_nonce( 'runlight_check' ),
			'dashboard' => Settings::get()['address'] . '/',
			'open'      => __( 'Open the dashboard', 'runlight' ),
			'failed'    => __( 'Could not check your Runlight from here.', 'runlight' ),
		);
		wp_enqueue_script( 'runlight-settings', plugins_url( 'assets/settings.js', RUNLIGHT_PLUGIN_FILE ), array(), RUNLIGHT_PLUGIN_VERSION, true );
		wp_localize_script( 'runlight-settings', 'runlightCheck', $config );
	}

	/**
	 * The first screen, before anything is counted: run Runlight in this
	 * WordPress with one press, or connect to one run elsewhere.
	 *
	 * @param string $missing What stops Runlight running here, or an empty string.
	 */
	private static function setup( string $missing ): void {
		$notice = Connect::notice();
		// The counting choices keep their defaults until they can be changed on the settings page.
		$defaults = static function (): void {
			foreach ( array( 'skip_admins', 'outbound', 'downloads' ) as $field ) {
				echo '<input type="hidden" name="' . esc_attr( Settings::OPTION . '[' . $field . ']' ) . '" value="1">';
			}
		};
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Set up Runlight', 'runlight' ); ?></h1>
			<p><?php esc_html_e( 'Runlight counts visitors without cookies, and its numbers stay in your own database. Choose where it runs. Nothing is counted until you do.', 'runlight' ); ?></p>
			<?php if ( null !== $notice ) : ?>
				<div class="notice inline <?php echo $notice[0] ? 'notice-success' : 'notice-error'; ?>"><p><?php echo esc_html( $notice[1] ); ?></p></div>
			<?php endif; ?>
			<div class="card">
				<h2><?php esc_html_e( 'Run Runlight in this WordPress', 'runlight' ); ?></h2>
				<p>
					<?php
					printf(
						/* translators: %s: the address of Runlight's dashboard on this site */
						esc_html__( 'Runlight runs inside this site and keeps its numbers in this site’s database, with a standalone dashboard at %s as well as the one in wp-admin. There is nothing else to set up.', 'runlight' ),
						'<code>' . esc_html( Local::address() . '/' ) . '</code>'
					);
					?>
				</p>
				<?php if ( '' !== $missing ) : ?>
					<p><?php echo esc_html( $missing ); ?></p>
				<?php else : ?>
					<form method="post" action="options.php">
						<?php // settings_fields(), with the Runlight page in place of this one as where WordPress goes once saved. ?>
						<input type="hidden" name="option_page" value="runlight">
						<input type="hidden" name="action" value="update">
						<?php wp_nonce_field( 'runlight-options', '_wpnonce', false ); ?>
						<input type="hidden" name="_wp_http_referer" value="<?php echo esc_attr( wp_make_link_relative( admin_url( 'admin.php?page=' . Dashboard::PAGE ) ) ); ?>">
						<input type="hidden" name="<?php echo esc_attr( Settings::OPTION ); ?>[mode]" value="local">
						<?php $defaults(); ?>
						<?php submit_button( __( 'Run Runlight in this WordPress', 'runlight' ), 'primary', 'submit', false ); ?>
					</form>
				<?php endif; ?>
			</div>
			<div class="card">
				<h2><?php esc_html_e( 'Connect to a Runlight you run elsewhere', 'runlight' ); ?></h2>
				<p><?php esc_html_e( 'The standalone server, or an app with Runlight in it, for one dashboard across several sites. Enter its address, shown in Runlight under Settings, Install, and press Connect. Runlight asks you to pick this site, then fills in everything.', 'runlight' ); ?></p>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="runlight_connect">
					<?php wp_nonce_field( 'runlight_connect', 'runlight_connect_nonce', false ); ?>
					<p>
						<label class="screen-reader-text" for="runlight-setup-address"><?php esc_html_e( 'Runlight address', 'runlight' ); ?></label>
						<input id="runlight-setup-address" class="regular-text code" type="url" name="<?php echo esc_attr( Settings::OPTION ); ?>[address]" placeholder="https://stats.example.com" required<?php echo Settings::can_change_address() ? '' : ' readonly'; ?>>
						<?php submit_button( __( 'Connect', 'runlight' ), 'secondary', 'submit', false ); ?>
					</p>
				</form>
				<p><a href="<?php echo esc_url( admin_url( 'options-general.php?page=' . self::PAGE . '&setup=manual' ) ); ?>"><?php esc_html_e( 'Enter the settings by hand instead', 'runlight' ); ?></a></p>
			</div>
			<p><?php printf( /* translators: %s: link to the docs */ esc_html__( 'Not sure? %s', 'runlight' ), '<a href="https://runlight.sh/docs/wordpress/" target="_blank" rel="noopener">' . esc_html__( 'Read how each one works.', 'runlight' ) . '</a>' ); ?></p>
		</div>
		<?php
	}

	/** What a site running Runlight here should know: where it answers with plain permalinks, and upkeep that has not run. */
	private static function local_notices(): void {
		$cron_off = defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON;
		?>
		<?php if ( Local::plain_permalinks() ) : ?>
			<div class="notice notice-info inline"><p>
				<?php
				printf(
					/* translators: 1: Runlight's address on this site, 2: link to the permalink settings */
					esc_html__( 'With plain permalinks, Runlight answers at %1$s, through index.php, so it works on every server. Choose another structure under %2$s to have it at /runlight.', 'runlight' ),
					'<code>' . esc_html( Local::address() . '/' ) . '</code>',
					'<a href="' . esc_url( admin_url( 'options-permalink.php' ) ) . '">' . esc_html__( 'Settings, Permalinks', 'runlight' ) . '</a>'
				);
				?>
			</p></div>
		<?php endif; ?>
		<?php if ( Local::overdue() ) : ?>
			<div class="notice notice-warning inline"><p>
				<?php esc_html_e( 'Runlight’s hourly upkeep has not run for over a day, so email reports, location data, daily totals, and removing visits past their retention are waiting.', 'runlight' ); ?>
				<?php if ( $cron_off ) : ?>
					<?php esc_html_e( 'WordPress’s cron is turned off with DISABLE_WP_CRON, so have your server run wp-cron.php every hour, or run “wp cron event run --due-now” with WP-CLI.', 'runlight' ); ?>
				<?php else : ?>
					<?php esc_html_e( 'WordPress runs it when the site has visitors, so on a quiet site, or where the host blocks it, have your server run wp-cron.php every hour.', 'runlight' ); ?>
				<?php endif; ?>
			</p></div>
		<?php endif; ?>
		<?php
	}

	public static function page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings = Settings::get();
		$missing  = Library::missing();
		$local    = 'local' === $settings['mode'];
		// The setup screen stays until a choice is made, unless the admin asked for the fields to fill in by hand.
		$unset  = ! Settings::set_up();
		$manual = isset( $_GET['setup'] ) && 'manual' === $_GET['setup']; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- only picks which screen to show.
		if ( $unset && ! $manual ) {
			self::setup( $missing );
			return;
		}
		// By hand, the fields start at "elsewhere", but only until a choice is saved.
		if ( $unset && $manual ) {
			$local = false;
		}
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Runlight', 'runlight' ); ?></h1>
			<p><?php esc_html_e( 'Runlight counts visitors without cookies, and its numbers stay in your own database. This plugin adds its script to every page and records AI agents that read your pages.', 'runlight' ); ?></p>
			<?php if ( $unset ) : ?>
				<p><a href="<?php echo esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ); ?>"><?php esc_html_e( 'Back to the setup choices', 'runlight' ); ?></a></p>
			<?php endif; ?>
			<?php $notice = Connect::notice(); ?>
			<?php if ( null !== $notice ) : ?>
				<div class="notice inline <?php echo $notice[0] ? 'notice-success' : 'notice-error'; ?>"><p><?php echo esc_html( $notice[1] ); ?></p></div>
			<?php elseif ( $local && '' === $missing ) : ?>
				<div class="notice notice-success inline"><p>
					<?php esc_html_e( 'Runlight is counting this site.', 'runlight' ); ?>
					<a href="<?php echo esc_url( admin_url( 'admin.php?page=' . Dashboard::PAGE ) ); ?>"><?php esc_html_e( 'See the numbers', 'runlight' ); ?></a>
				</p></div>
				<?php self::local_notices(); ?>
			<?php elseif ( ! $local && '' !== $settings['address'] ) : ?>
				<div id="runlight-status" class="notice notice-info inline"><p><?php esc_html_e( 'Checking that your Runlight answers…', 'runlight' ); ?></p></div>
			<?php endif; ?>
			<form method="post" action="options.php">
				<?php settings_fields( 'runlight' ); ?>
				<?php wp_nonce_field( 'runlight_connect', 'runlight_connect_nonce', false ); ?>
				<?php // Enter in any field saves, rather than pressing Connect, the first button in the form. ?>
				<input type="submit" value="<?php esc_attr_e( 'Save Changes', 'runlight' ); ?>" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Where Runlight runs', 'runlight' ); ?></th>
						<td>
							<fieldset id="runlight-mode">
								<label><input type="radio" name="<?php echo esc_attr( Settings::OPTION ); ?>[mode]" value="local" <?php checked( $local ); ?><?php disabled( '' !== $missing && ! $local ); ?>> <?php esc_html_e( 'In this WordPress', 'runlight' ); ?></label>
								<p class="description">
									<?php
									printf(
										/* translators: %s: the address of Runlight's dashboard on this site */
										esc_html__( 'Runlight runs inside this site and keeps its numbers in this site’s database, with a standalone dashboard at %s as well as the one in wp-admin. There is nothing else to set up.', 'runlight' ),
										'<code>' . esc_html( Local::address() . '/' ) . '</code>'
									);
									?>
								</p>
								<?php if ( '' !== $missing ) : ?>
									<p class="description"><?php echo esc_html( $missing ); ?></p>
								<?php endif; ?>
								<br>
								<label><input type="radio" name="<?php echo esc_attr( Settings::OPTION ); ?>[mode]" value="remote" <?php checked( ! $local ); ?>> <?php esc_html_e( 'On a Runlight you run elsewhere', 'runlight' ); ?></label>
								<p class="description"><?php esc_html_e( 'The standalone server, or an app with Runlight in it, for one dashboard across several sites.', 'runlight' ); ?></p>
							</fieldset>
						</td>
					</tr>
					<tr class="runlight-remote">
						<th scope="row"><label for="runlight-address"><?php esc_html_e( 'Runlight address', 'runlight' ); ?></label></th>
						<td>
							<input id="runlight-address" class="regular-text code" type="url" name="<?php echo esc_attr( Settings::OPTION ); ?>[address]" value="<?php echo esc_attr( $settings['address'] ); ?>" placeholder="https://example.com/runlight or https://stats.example.com"<?php echo Settings::can_change_address() ? '' : ' readonly'; ?>>
							<?php // Sent to admin-post.php, where this button's action follows, and so wins over, the form's own. ?>
							<button type="submit" class="button button-primary" formaction="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" name="action" value="runlight_connect"><?php esc_html_e( 'Connect', 'runlight' ); ?></button>
							<p class="description"><?php esc_html_e( 'Enter your Runlight’s address, shown in Runlight under Settings, Install, and press Connect. Runlight asks you to pick this site, then fills in everything below. That Runlight must count this site, or its visits are ignored.', 'runlight' ); ?></p>
							<?php if ( ! Settings::can_change_address() ) : ?>
								<p class="description"><?php esc_html_e( 'On a network of sites, only a network administrator can change the address, since this server connects to it.', 'runlight' ); ?></p>
							<?php endif; ?>
						</td>
					</tr>
					<tr class="runlight-remote">
						<th scope="row"><label for="runlight-site"><?php esc_html_e( 'Site id', 'runlight' ); ?></label></th>
						<td>
							<input id="runlight-site" class="regular-text code" type="text" name="<?php echo esc_attr( Settings::OPTION ); ?>[site]" value="<?php echo esc_attr( $settings['site'] ); ?>">
							<p class="description"><?php esc_html_e( 'Optional. Shown in Runlight under Settings, Install. Only needed when that Runlight cannot tell this site by its domain.', 'runlight' ); ?></p>
						</td>
					</tr>
					<tr class="runlight-remote">
						<th scope="row"><label for="runlight-key"><?php esc_html_e( 'Agents key', 'runlight' ); ?></label></th>
						<td>
							<input id="runlight-key" class="regular-text code" type="password" autocomplete="off" name="<?php echo esc_attr( Settings::OPTION ); ?>[observe_key]" value="" placeholder="<?php echo '' !== $settings['observe_key'] ? esc_attr__( 'Saved. Leave blank to keep it for this address.', 'runlight' ) : ''; ?>">
							<p class="description"><?php esc_html_e( 'Optional. Shown in Runlight under Settings, Install. With it, the plugin reports AI agents such as ChatGPT and Claude reading your pages, which run no JavaScript, so the script cannot see them. The key can report fetches for this site and nothing else.', 'runlight' ); ?></p>
						</td>
					</tr>
					<tr class="runlight-remote">
						<th scope="row"><label for="runlight-dashboard-key"><?php esc_html_e( 'Dashboard key', 'runlight' ); ?></label></th>
						<td>
							<input id="runlight-dashboard-key" class="regular-text code" type="password" autocomplete="off" name="<?php echo esc_attr( Settings::OPTION ); ?>[dashboard_key]" value="" placeholder="<?php echo '' !== $settings['dashboard_key'] ? esc_attr__( 'Saved. Leave blank to keep it for this address.', 'runlight' ) : ''; ?>">
							<p class="description"><?php esc_html_e( 'Optional. Made in Runlight under Settings, Install. With it, the Runlight item in the admin menu shows this site’s numbers right here, in the same read-only view a share link shows, framed only by this admin. Anyone holding the key can read this site’s dashboard, so keep it as you would a password.', 'runlight' ); ?></p>
						</td>
					</tr>
					<tr class="runlight-local">
						<th scope="row"><?php esc_html_e( 'Locations', 'runlight' ); ?></th>
						<td>
							<label><input type="checkbox" name="<?php echo esc_attr( Settings::OPTION ); ?>[locations]" value="1" <?php checked( $settings['locations'] ); ?>> <?php esc_html_e( 'Show which countries visitors come from', 'runlight' ); ?></label>
							<p class="description"><?php esc_html_e( 'With DB-IP’s free country data, which the plugin downloads from db-ip.com once a month and keeps in the uploads folder. Visitors’ addresses are looked up on this server and never sent anywhere. Sites behind Cloudflare get countries without it.', 'runlight' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Counting', 'runlight' ); ?></th>
						<td>
							<fieldset>
								<label><input type="checkbox" name="<?php echo esc_attr( Settings::OPTION ); ?>[skip_admins]" value="1" <?php checked( $settings['skip_admins'] ); ?>> <?php esc_html_e( 'Leave out administrators’ visits', 'runlight' ); ?></label><br>
								<label><input type="checkbox" name="<?php echo esc_attr( Settings::OPTION ); ?>[outbound]" value="1" <?php checked( $settings['outbound'] ); ?>> <?php esc_html_e( 'Count clicks on links to other sites', 'runlight' ); ?></label><br>
								<label><input type="checkbox" name="<?php echo esc_attr( Settings::OPTION ); ?>[downloads]" value="1" <?php checked( $settings['downloads'] ); ?>> <?php esc_html_e( 'Count file downloads', 'runlight' ); ?></label>
							</fieldset>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
			<p><?php printf( /* translators: %s: link to the docs */ esc_html__( 'Need help? %s', 'runlight' ), '<a href="https://runlight.sh/docs/wordpress/" target="_blank" rel="noopener">' . esc_html__( 'Read the Runlight docs.', 'runlight' ) . '</a>' ); ?></p>
		</div>
		<?php
	}
}
