<?php
/**
 * Runlight's email through WordPress's own mailer, when the site has a real
 * one set up: an SMTP or mail service plugin, or wp_mail replaced by one.
 * Plain PHP mail(), which WordPress uses on its own, does not count, so
 * without such a plugin the dashboard asks for a mail service as before.
 *
 * @package Runlight
 */

namespace Runlight\WordPress;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Mailer {
	/** Well-known mail plugins by their folder, and the name the dashboard gives them. */
	private const PLUGINS = array(
		'wp-mail-smtp'                       => 'WP Mail SMTP',
		'wp-mail-smtp-pro'                   => 'WP Mail SMTP',
		'fluent-smtp'                        => 'FluentSMTP',
		'post-smtp'                          => 'Post SMTP',
		'easy-wp-smtp'                       => 'Easy WP SMTP',
		'smtp-mailer'                        => 'SMTP Mailer',
		'wp-smtp'                            => 'WP SMTP',
		'gmail-smtp'                         => 'Gmail SMTP',
		'suremails'                          => 'SureMail',
		'site-mailer'                        => 'Site Mailer',
		'wp-ses'                             => 'WP Offload SES',
		'mailgun'                            => 'Mailgun',
		'postmark-approved-wordpress-plugin' => 'Postmark',
		'sendgrid-email-delivery-simplified' => 'SendGrid',
		'smtp2go'                            => 'SMTP2GO',
		'mailin'                             => 'Brevo',
		'wp-mail-bank'                       => 'Mail Bank',
	);

	/**
	 * The mailer to hand Runlight, or null when WordPress would send with
	 * PHP's mail() alone: from the admin email, in the site's name.
	 *
	 * @return array{send: callable, from: string, fromName: string, via: string}|null
	 */
	public static function option(): ?array {
		$via  = self::via();
		$from = (string) get_option( 'admin_email' );
		if ( null === $via || ! is_email( $from ) ) {
			return null;
		}
		return array(
			'send'     => array( self::class, 'send' ),
			'from'     => $from,
			'fromName' => wp_specialchars_decode( wp_strip_all_tags( (string) get_bloginfo( 'name' ) ), ENT_QUOTES ),
			'via'      => $via,
		);
	}

	/** What the dashboard calls the mailer, or null when there is none but mail(). */
	private static function via(): ?string {
		$known = self::known();
		if ( null !== $known ) {
			return 'WordPress (' . $known . ')';
		}
		return has_filter( 'pre_wp_mail' ) || has_action( 'phpmailer_init' ) || self::pluggable() ? 'WordPress' : null;
	}

	/** The well-known mail plugin that is active, by its folder or its own functions. */
	private static function known(): ?string {
		$active = (array) get_option( 'active_plugins', array() );
		if ( is_multisite() ) {
			$active = array_merge( $active, array_keys( (array) get_site_option( 'active_sitewide_plugins', array() ) ) );
		}
		foreach ( $active as $plugin ) {
			$folder = dirname( (string) $plugin );
			if ( isset( self::PLUGINS[ $folder ] ) ) {
				return self::PLUGINS[ $folder ];
			}
		}
		if ( function_exists( 'wp_mail_smtp' ) ) {
			return 'WP Mail SMTP';
		}
		if ( defined( 'FLUENTMAIL' ) ) {
			return 'FluentSMTP';
		}
		if ( class_exists( 'PostmanOptions' ) ) {
			return 'Post SMTP';
		}
		return null;
	}

	/** Whether a plugin replaced wp_mail, which WordPress lets one do. */
	private static function pluggable(): bool {
		if ( ! function_exists( 'wp_mail' ) ) {
			return false;
		}
		$file = ( new \ReflectionFunction( 'wp_mail' ) )->getFileName();
		return false !== $file && wp_normalize_path( $file ) !== wp_normalize_path( ABSPATH . WPINC . '/pluggable.php' );
	}

	/**
	 * Sends one of Runlight's emails with wp_mail: the HTML, with the text
	 * as its alternative, and Runlight's headers, such as List-Unsubscribe.
	 *
	 * @param array{to: string, from: string, fromName?: string, subject: string, html: string, text: string, headers?: array<string, string>} $message The email.
	 * @throws \RuntimeException When WordPress could not send it.
	 */
	public static function send( array $message ): void {
		$clean   = static fn ( string $value ): string => trim( str_replace( array( "\r", "\n" ), ' ', $value ) );
		$name    = str_replace( array( '"', '<', '>' ), '', $clean( (string) ( $message['fromName'] ?? '' ) ) );
		$headers = array(
			'Content-Type: text/html; charset=UTF-8',
			'From: ' . ( '' !== $name ? $name . ' <' . $clean( $message['from'] ) . '>' : $clean( $message['from'] ) ),
		);
		foreach ( $message['headers'] ?? array() as $header => $value ) {
			$headers[] = $clean( (string) $header ) . ': ' . $clean( (string) $value );
		}
		$text = (string) $message['text'];
		// PHPMailer sends the text beside the HTML when it has an AltBody; a mailer that skips PHPMailer sends the HTML.
		$alternative = static function ( $phpmailer ) use ( $text ): void {
			$phpmailer->AltBody = $text; // phpcs:ignore WordPress.NamingConventions.ValidVariableName.UsedPropertyNotSnakeCase -- PHPMailer's own property.
		};
		$failure     = '';
		$failed      = static function ( $error ) use ( &$failure ): void {
			$failure = is_wp_error( $error ) ? $error->get_error_message() : '';
		};
		add_action( 'phpmailer_init', $alternative );
		add_action( 'wp_mail_failed', $failed );
		try {
			$sent = wp_mail( $message['to'], $message['subject'], $message['html'], $headers );
		} finally {
			remove_action( 'phpmailer_init', $alternative );
			remove_action( 'wp_mail_failed', $failed );
		}
		if ( ! $sent ) {
			throw new \RuntimeException( '' !== $failure ? $failure : 'wp_mail said it could not send the email' ); // phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- shown as text by the dashboard.
		}
	}
}
