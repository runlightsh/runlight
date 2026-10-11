<?php

declare(strict_types=1);

namespace Runlight\Craft\controllers;

use Craft;
use craft\helpers\UrlHelper;
use craft\web\Controller;
use Runlight\Craft\Local;
use Runlight\Craft\Plugin;
use yii\web\Response;

/**
 * The Control Panel's Runlight item: this site's dashboard, framed from
 * Runlight here, or from Runlight elsewhere with a ticket the plugin asks for
 * on every visit to the page.
 */
final class DashboardController extends Controller
{
    public function actionIndex(): Response
    {
        $this->requirePermission('accessPlugin-runlight');
        $settings = Plugin::getInstance()->getSettings();
        $mode = $settings->getMode();
        if ($mode === 'local') {
            // Runlight here is on this site, signed in with this login, so the whole dashboard shows, not a share view.
            $address = Local::active() ? Local::address() : '';
            $ticket = $address !== '' ? ['url' => $address . '/'] : Local::missing();
            $hasKey = true;
            $full = $address !== '' ? $address . '/' : '';
        } else {
            $address = $mode === 'remote' ? $settings->getAddress() : '';
            $key = $settings->getDashboardKey();
            $hasKey = $key !== '';
            $ticket = $address !== '' && $hasKey ? self::ticket($address, $key) : null;
            $site = is_array($ticket) && $ticket['site'] !== '' ? $ticket['site'] : $settings->getSite();
            $full = $address !== '' ? $address . '/' . ($site !== '' ? '?site=' . rawurlencode($site) : '') : '';
        }
        return $this->renderTemplate('runlight/_dashboard.twig', [
            'setUp' => $settings->isSetUp(),
            'local' => $mode === 'local',
            'address' => $address,
            'hasKey' => $hasKey,
            'frame' => is_array($ticket) ? $ticket['url'] : null,
            'error' => is_string($ticket) ? $ticket : null,
            'origin' => self::originOf($address),
            'full' => $full,
            'settingsUrl' => 'settings/plugins/runlight',
        ]);
    }

    /**
     * Whether the saved address answers as a Runlight, asked for by the settings page once it has
     * loaded. Only the saved address is checked, never one the request names.
     */
    public function actionCheck(): Response
    {
        $this->requirePostRequest();
        $this->requireAcceptsJson();
        $this->requireAdmin(false);
        $address = Plugin::getInstance()->getSettings()->getAddress();
        return $this->asJson($address !== '' ? Plugin::check($address) : null);
    }

    /** The scheme, host, and port of an address, as a browser writes its origin. */
    private static function originOf(string $address): string
    {
        $parts = parse_url($address);
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            return '';
        }
        $scheme = strtolower($parts['scheme']);
        $port = (int) ($parts['port'] ?? 0);
        $default = ($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80);
        return $scheme . '://' . strtolower($parts['host']) . ($port && !$default ? ':' . $port : '');
    }

    /**
     * Asks the Runlight for a ticket that opens the dashboard once, framed by
     * this Control Panel. Each ticket works for a few minutes and only once, so
     * one is asked for on every visit to the page and never kept. The frame's
     * origin is the Control Panel's, from baseCpUrl when it is set, so a
     * proxy that ends HTTPS in front of Craft does not turn it into http.
     *
     * @return array{url: string, site: string}|string The page to frame and its site, or why there is none.
     */
    private static function ticket(string $address, string $key): array|string
    {
        try {
            $response = Craft::createGuzzleClient(['timeout' => 5, 'http_errors' => false, 'allow_redirects' => false])->post($address . '/api/embed', [
                'headers' => ['Authorization' => 'Bearer ' . $key],
                'json' => ['origin' => self::originOf(UrlHelper::cpUrl())],
            ]);
        } catch (\Throwable $e) {
            return Craft::t('runlight', 'Could not reach your Runlight: {error}', ['error' => $e->getMessage()]);
        }
        $body = json_decode((string) $response->getBody(), true);
        $code = $response->getStatusCode();
        if ($code !== 201 || !is_array($body) || !is_string($body['ticket'] ?? null)) {
            if ($code === 401) {
                return Craft::t('runlight', 'Your Runlight does not know this dashboard key. Connect again in the settings, or make a new key in Runlight under Settings, Install.');
            }
            $reason = is_array($body) && is_string($body['error'] ?? null) ? $body['error'] : Craft::t('runlight', 'It answered {code}.', ['code' => $code]);
            return Craft::t('runlight', 'Your Runlight would not open the dashboard here: {reason}', ['reason' => $reason]);
        }
        return [
            'url' => $address . '/embed?ticket=' . rawurlencode($body['ticket']) . '&theme=light',
            'site' => is_string($body['site'] ?? null) ? $body['site'] : '',
        ];
    }
}
