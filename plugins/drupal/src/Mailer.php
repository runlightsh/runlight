<?php

declare(strict_types=1);

namespace Drupal\runlight;

use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Mail\MailManagerInterface;
use Drupal\Core\Render\Markup;

/**
 * Runlight's email through Drupal's own mailer, when the site has a real one
 * set up, such as the SMTP or Symfony Mailer modules. PHP's mail(), which
 * Drupal uses on its own, does not count, so without one the dashboard asks
 * for a mail service as before.
 */
final class Mailer {

  /** Drupal's plain mail() sender, and its collector for tests, which do not count. */
  private const PLAIN = ['php_mail', 'test_mail_collector'];

  /**
   * The mailer to hand Runlight, or NULL when Drupal would send with PHP's
   * mail() alone: from the site's email address, in the site's name.
   *
   * @return array{send: callable, from: string, fromName: string, via: string}|null
   */
  public static function option(ConfigFactoryInterface $config, MailManagerInterface $mail, string $langcode): ?array {
    $via = self::via($config, $mail);
    $site = $config->get('system.site');
    $from = (string) $site->get('mail');
    if ($via === NULL || !filter_var($from, FILTER_VALIDATE_EMAIL)) {
      return NULL;
    }
    return [
      'send' => static fn (array $message) => self::send($mail, $langcode, $message),
      'from' => $from,
      'fromName' => trim(strip_tags((string) $site->get('name'))),
      'via' => $via,
    ];
  }

  /** What the dashboard calls the mailer, or NULL when there is none but mail(). */
  private static function via(ConfigFactoryInterface $config, MailManagerInterface $mail): ?string {
    $interface = (array) $config->get('system.mail')->get('interface');
    // The Mail System module, when it is installed, picks the sender in its own settings.
    $mailsystem = $config->get('mailsystem.settings');
    $id = (string) ($mailsystem->get('modules.runlight.none.sender') ?: ($mailsystem->get('defaults.sender') ?: ($interface['runlight'] ?? $interface['default'] ?? 'php_mail')));
    if (in_array($id, self::PLAIN, TRUE)) {
      return NULL;
    }
    $definition = $mail->hasDefinition($id) ? (array) $mail->getDefinition($id) : [];
    // Core's own Symfony mailer sends with the server's sendmail unless it is given another transport.
    if (($definition['provider'] ?? '') === 'core' && in_array($config->get('system.mail')->get('mailer_dsn.scheme') ?? 'sendmail', ['sendmail', 'native', 'null'], TRUE)) {
      return NULL;
    }
    $label = trim(strip_tags((string) ($definition['label'] ?? '')));
    return $label !== '' ? "Drupal ($label)" : 'Drupal';
  }

  /**
   * Sends one of Runlight's emails through Drupal's mail manager, which
   * builds it with runlight_mail().
   *
   * @param array{to: string, from: string, fromName?: string, subject: string, html: string, text: string, headers?: array<string, string>} $message
   *
   * @throws \RuntimeException
   *   When Drupal could not send it.
   */
  public static function send(MailManagerInterface $mail, string $langcode, array $message): void {
    $result = $mail->mail('runlight', 'message', $message['to'], $langcode, $message, NULL, TRUE);
    if (empty($result['result'])) {
      throw new \RuntimeException('Drupal could not send the email. Its log says why.');
    }
  }

  /**
   * Builds the email for hook_mail(): the HTML, with the text beside it for
   * mailers that send both, and Runlight's headers, such as List-Unsubscribe.
   */
  public static function build(string $key, array &$message, array $params): void {
    if ($key !== 'message') {
      return;
    }
    $clean = static fn (string $value): string => trim(str_replace(["\r", "\n"], ' ', $value));
    $message['subject'] = $clean((string) $params['subject']);
    $message['body'] = [Markup::create((string) $params['html'])];
    $message['headers']['Content-Type'] = 'text/html; charset=UTF-8';
    // The text part, where the SMTP, Swift Mailer, and Symfony Mailer Lite modules look for it.
    $message['plain'] = (string) $params['text'];
    $message['params']['plain'] = (string) $params['text'];
    $message['params']['plaintext'] = (string) $params['text'];
    foreach ($params['headers'] ?? [] as $name => $value) {
      $message['headers'][$clean((string) $name)] = $clean((string) $value);
    }
  }

}
