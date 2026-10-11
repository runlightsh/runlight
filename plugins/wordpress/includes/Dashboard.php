<?php
/**
 * The Runlight page in wp-admin: this site's dashboard, framed from your
 * Runlight with a ticket the plugin asks for on every visit to the page.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Dashboard {
	public const PAGE = 'runlight-dashboard';

	/**
	 * The scheme, host, and port wp-admin is served from, which alone may frame
	 * the dashboard.
	 */
	public static function admin_origin(): string {
		return self::origin_of( admin_url() );
	}

	/** The scheme, host, and port of an address, such as the Runlight's. */
	private static function origin_of( string $address ): string {
		$parts = wp_parse_url( $address );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return '';
		}
		$scheme = strtolower( $parts['scheme'] );
		$port   = isset( $parts['port'] ) ? (int) $parts['port'] : 0;
		// A browser leaves out the port its scheme uses anyway, and so does the origin Runlight checks.
		$default = ( 'https' === $scheme && 443 === $port ) || ( 'http' === $scheme && 80 === $port );
		return $scheme . '://' . strtolower( $parts['host'] ) . ( $port && ! $default ? ':' . $port : '' );
	}

	/**
	 * Asks the Runlight for a ticket that opens the dashboard once, framed by
	 * this admin. Each ticket works for a few minutes and only once, so one is
	 * asked for on every visit to the page and never kept.
	 *
	 * @param array{address:string,dashboard_key:string} $settings The plugin's settings.
	 * @return array{url:string,site:string}|string The page to frame and its site, or why there is none.
	 */
	private static function ticket( array $settings ) {
		$response = wp_remote_post(
			$settings['address'] . '/api/embed',
			array(
				'timeout'     => 5,
				'redirection' => 0,
				'headers'     => array(
					'Authorization' => 'Bearer ' . $settings['dashboard_key'],
					'Content-Type'  => 'application/json',
				),
				'body'        => (string) wp_json_encode( array( 'origin' => self::admin_origin() ) ),
			)
		);
		if ( is_wp_error( $response ) ) {
			/* translators: %s: the error */
			return sprintf( __( 'Could not reach your Runlight: %s', 'runlight' ), $response->get_error_message() );
		}
		$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( 201 !== $code || ! is_array( $body ) || ! is_string( $body['ticket'] ?? null ) ) {
			if ( 401 === $code ) {
				return __( 'Your Runlight does not know this dashboard key. Connect again in the settings, or make a new key in Runlight under Settings, Install.', 'runlight' );
			}
			$reason = is_array( $body ) && is_string( $body['error'] ?? null ) ? $body['error'] : sprintf( /* translators: %d: the HTTP status */ __( 'It answered %d.', 'runlight' ), $code );
			/* translators: %s: what the Runlight said */
			return sprintf( __( 'Your Runlight would not open the dashboard here: %s', 'runlight' ), $reason );
		}
		return array(
			'url'  => $settings['address'] . '/embed?ticket=' . rawurlencode( $body['ticket'] ) . '&theme=light',
			'site' => is_string( $body['site'] ?? null ) ? $body['site'] : '',
		);
	}

	public static function page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings = Settings::get();
		$setup    = admin_url( 'options-general.php?page=runlight' );
		$local    = 'local' === $settings['mode'];
		$address  = Settings::address();
		if ( $local ) {
			// Runlight here is on this site, signed in with this login, so the whole dashboard shows, not a share view.
			$ticket = '' !== $address ? array( 'url' => $address . '/' ) : Library::missing();
			$full   = '' !== $address ? $address . '/' : '';
		} else {
			$ticket = '' !== $address && '' !== $settings['dashboard_key'] ? self::ticket( $settings ) : null;
			$site   = is_array( $ticket ) && '' !== $ticket['site'] ? $ticket['site'] : $settings['site'];
			$full   = '' !== $address ? $address . '/' . ( '' !== $site ? '?site=' . rawurlencode( $site ) : '' ) : '';
		}
		?>
		<div class="wrap runlight-dashboard">
			<h1 class="wp-heading-inline"><?php esc_html_e( 'Runlight', 'runlight' ); ?></h1>
			<?php if ( '' !== $full ) : ?>
				<a class="page-title-action" href="<?php echo esc_url( $full ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'Open in Runlight', 'runlight' ); ?></a>
			<?php endif; ?>
			<hr class="wp-header-end">
			<?php $notice = Connect::notice(); ?>
			<?php if ( null !== $notice ) : ?>
				<div class="notice inline <?php echo $notice[0] ? 'notice-success' : 'notice-error'; ?>"><p><?php echo esc_html( $notice[1] ); ?></p></div>
			<?php endif; ?>
			<?php if ( ! Settings::set_up() ) : ?>
				<div class="notice notice-info inline"><p>
					<?php esc_html_e( 'Runlight is not counting yet.', 'runlight' ); ?>
					<a href="<?php echo esc_url( $setup ); ?>"><?php esc_html_e( 'Set up Runlight', 'runlight' ); ?></a>
				</p></div>
			<?php elseif ( ! $local && '' === $address ) : ?>
				<div class="notice notice-info inline"><p>
					<?php
					printf(
						/* translators: %s: link to the settings page */
						esc_html__( 'Connect this site to your Runlight on the %s to see its numbers here.', 'runlight' ),
						'<a href="' . esc_url( $setup ) . '">' . esc_html__( 'settings page', 'runlight' ) . '</a>'
					);
					?>
				</p></div>
			<?php elseif ( null === $ticket ) : ?>
				<div class="notice notice-info inline"><p>
					<?php
					printf(
						/* translators: %s: link to the settings page */
						esc_html__( 'To see this site’s numbers here, press Connect on the %s, or make a dashboard key in Runlight under Settings, Install and enter it there.', 'runlight' ),
						'<a href="' . esc_url( $setup ) . '">' . esc_html__( 'settings page', 'runlight' ) . '</a>'
					);
					?>
				</p></div>
			<?php elseif ( is_string( $ticket ) ) : ?>
				<div class="notice notice-error inline"><p>
					<?php echo esc_html( $ticket ); ?>
					<a href="<?php echo esc_url( $setup ); ?>"><?php esc_html_e( 'Check the settings', 'runlight' ); ?></a>
				</p></div>
			<?php else : ?>
				<iframe id="runlight-embed" src="<?php echo esc_url( $ticket['url'] ); ?>" data-runlight-origin="<?php echo esc_attr( self::origin_of( $address ) ); ?>" title="<?php esc_attr_e( 'Runlight dashboard', 'runlight' ); ?>" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads<?php echo $local ? ' allow-forms allow-modals' : ''; ?>" style="display:block;width:100%;height:calc(100vh - 140px);min-height:600px;margin-top:12px;border:0;border-radius:8px;background:transparent"></iframe>
			<?php endif; ?>
		</div>
		<?php
	}

	/**
	 * Grows the frame to the dashboard's height, tells the dashboard which
	 * part of it is on screen, and reloads the page when the dashboard asks,
	 * which it does once its session has run out.
	 */
	public static function scripts( string $hook ): void {
		if ( 'toplevel_page_' . self::PAGE !== $hook ) {
			return;
		}
		wp_register_script( 'runlight-dashboard', false, array(), RUNLIGHT_PLUGIN_VERSION, true );
		wp_enqueue_script( 'runlight-dashboard' );
		wp_add_inline_script( 'runlight-dashboard', self::SCRIPT );
	}

	/** The frame's few lines of script, the same in every CMS plugin. */
	private const SCRIPT = <<<'JS'
(function () {
  var frame = document.getElementById("runlight-embed");
  if (!frame) return;
  var origin = frame.getAttribute("data-runlight-origin");
  // Until the dashboard says how tall it is, the frame fills the window below it; an older Runlight never says.
  var sized = false;
  function fit() {
    if (sized) return;
    var top = frame.getBoundingClientRect().top + window.scrollY;
    frame.style.height = Math.max(600, window.innerHeight - top - 24) + "px";
  }
  // Tells the dashboard which slice of the frame is on screen, so its drawers and sheets cover just that.
  var queued = false;
  function viewport() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var rect = frame.getBoundingClientRect();
      var top = Math.max(rect.top, 0);
      var height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - top);
      if (frame.contentWindow) frame.contentWindow.postMessage({ type: "runlight:viewport", top: top - rect.top, height: height }, origin);
    });
  }
  fit();
  window.addEventListener("resize", function () {
    fit();
    viewport();
  });
  window.addEventListener("scroll", viewport, { passive: true, capture: true });
  frame.addEventListener("load", viewport);
  window.addEventListener("message", function (event) {
    if (event.origin !== origin || event.source !== frame.contentWindow || !event.data) return;
    if (event.data.type === "runlight:reload") location.reload();
    if (event.data.type === "runlight:height" && typeof event.data.height === "number" && isFinite(event.data.height)) {
      sized = true;
      frame.style.height = Math.max(600, Math.ceil(event.data.height)) + "px";
      viewport();
    }
  });
})();
JS;
}
