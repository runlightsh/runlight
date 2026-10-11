<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use craft\helpers\App;
use craft\mail\transportadapters\Sendmail;
use craft\mail\transportadapters\TransportAdapterInterface;

/**
 * Runlight's email through Craft's own mailer, when its email settings name
 * a real transport, such as SMTP. Craft's default, the server's sendmail,
 * does not count, so without one the dashboard asks for a mail service as
 * before.
 */
final class Mailer
{
    /**
     * The mailer to hand Runlight, or null when Craft would send with
     * sendmail: from Craft's system email address and sender name.
     *
     * @return array{send: callable, from: string, fromName: string, via: string}|null
     */
    public static function option(): ?array
    {
        $settings = App::mailSettings();
        $via = self::via($settings->transportType);
        $from = trim((string) App::parseEnv($settings->fromEmail));
        if ($via === null || !filter_var($from, FILTER_VALIDATE_EMAIL)) {
            return null;
        }
        return [
            'send' => [self::class, 'send'],
            'from' => $from,
            'fromName' => trim((string) App::parseEnv($settings->fromName)),
            'via' => $via,
        ];
    }

    /** What the dashboard calls the mailer, or null when it is sendmail, or a transport whose plugin is gone. */
    private static function via(?string $type): ?string
    {
        if ($type === null || $type === '' || $type === Sendmail::class || !class_exists($type) || !is_subclass_of($type, TransportAdapterInterface::class)) {
            return null;
        }
        return 'Craft (' . $type::displayName() . ')';
    }

    /**
     * Sends one of Runlight's emails with Craft's mailer: the HTML, the text
     * beside it, and Runlight's headers, such as List-Unsubscribe.
     *
     * @param array{to: string, from: string, fromName?: string, subject: string, html: string, text: string, headers?: array<string, string>} $message
     * @throws \RuntimeException when Craft could not send it.
     */
    public static function send(array $message): void
    {
        $from = ($message['fromName'] ?? '') !== '' ? [$message['from'] => $message['fromName']] : $message['from'];
        $email = Craft::$app->getMailer()->compose()
            ->setTo($message['to'])
            ->setFrom($from)
            ->setSubject($message['subject'])
            ->setHtmlBody($message['html'])
            ->setTextBody($message['text']);
        foreach ($message['headers'] ?? [] as $name => $value) {
            $email->addHeader((string) $name, str_replace(["\r", "\n"], ' ', (string) $value));
        }
        if (!$email->send()) {
            throw new \RuntimeException('Craft could not send the email. Its log says why.');
        }
    }
}
