<?php

declare(strict_types=1);

namespace Runlight\Craft;

use Craft;
use craft\base\Model;
use craft\base\Plugin as BasePlugin;
use craft\events\PluginEvent;
use craft\events\RegisterUrlRulesEvent;
use craft\helpers\UrlHelper;
use craft\services\Plugins;
use craft\services\ProjectConfig;
use craft\web\UrlManager;
use craft\web\View;
use Runlight\Craft\models\Settings;
use yii\base\Event;
use yii\web\Response;

/**
 * Runlight for Craft CMS: the script on every front-end page, AI agents
 * recorded after the response has gone, and a Control Panel item that shows
 * the dashboard. Runlight runs inside this site, with its numbers in Craft's
 * database (Local), or elsewhere, on a Runlight the plugin sends to.
 *
 * @method Settings getSettings()
 */
final class Plugin extends BasePlugin
{
    public string $schemaVersion = '1.0.0';
    public bool $hasCpSettings = true;
    public bool $hasCpSection = true;

    public function init(): void
    {
        parent::init();
        Event::on(UrlManager::class, UrlManager::EVENT_REGISTER_CP_URL_RULES, function (RegisterUrlRulesEvent $event): void {
            $event->rules['runlight'] = 'runlight/dashboard/index';
            // Where a Runlight sends the admin back to after Connect, a page address it can be registered with.
            $event->rules['runlight/connected'] = 'runlight/connect/finish';
        });
        Event::on(UrlManager::class, UrlManager::EVENT_REGISTER_SITE_URL_RULES, function (RegisterUrlRulesEvent $event): void {
            if (!Local::active()) {
                return;
            }
            $event->rules['runlight/login'] = 'runlight/serve/login';
            $event->rules['runlight'] = 'runlight/serve/index';
            $event->rules['runlight/<path:.+>'] = 'runlight/serve/index';
            $event->rules['go/<slug:.+>'] = 'runlight/serve/link';
        });
        // Nothing is counted until the admin chooses where Runlight runs, so installing leads straight there.
        Event::on(Plugins::class, Plugins::EVENT_AFTER_INSTALL_PLUGIN, function (PluginEvent $event): void {
            $request = Craft::$app->getRequest();
            if ($event->plugin === $this && !$request->getIsConsoleRequest() && $request->getIsCpRequest() && !$this->getSettings()->isSetUp()) {
                Craft::$app->getResponse()->redirect(UrlHelper::cpUrl('settings/plugins/' . $this->handle))->send();
            }
        });

        // The request is only looked at once Craft has finished starting up, as Craft asks of plugins.
        Craft::$app->onInit(function (): void {
            $request = Craft::$app->getRequest();
            if ($request->getIsConsoleRequest()) {
                return;
            }
            Event::on(Response::class, Response::EVENT_AFTER_SEND, function (): void {
                if (Local::active()) {
                    // Craft has no schedule of its own, so a request that has been answered queues the upkeep.
                    Local::schedule();
                }
            });
            if (!$request->getIsSiteRequest()) {
                return;
            }
            // The script goes in at the end of the body, which is still before Craft writes the head.
            Event::on(View::class, View::EVENT_END_BODY, function (): void {
                $this->registerScript();
            });
            Event::on(Response::class, Response::EVENT_AFTER_SEND, function (): void {
                $this->observe();
            });
        });
    }

    public function getCpNavItem(): ?array
    {
        $item = parent::getCpNavItem();
        if ($item !== null) {
            $item['label'] = 'Runlight';
        }
        return $item;
    }

    /** Uninstalling removes what Runlight kept here: its tables in Craft's database, and its folder. */
    protected function afterUninstall(): void
    {
        Storage::remove();
        Craft::$app->getCache()->delete('runlight-checked');
    }

    protected function createSettingsModel(): ?Model
    {
        return new Settings();
    }

    protected function settingsHtml(): ?string
    {
        // The address is checked by the page once it has loaded (DashboardController::actionCheck), so a
        // slow or missing Runlight never holds up the settings page.
        $settings = $this->getSettings();
        $missing = Local::missing();
        // Until Runlight is set up, the setup choices show, unless the admin asked for the settings by hand.
        $manual = Craft::$app->getRequest()->getQueryParam('setup') === 'manual';
        $setUp = $settings->isSetUp();
        return Craft::$app->getView()->renderTemplate(!$setUp && !$manual ? 'runlight/_setup.twig' : 'runlight/_settings.twig', [
            'settings' => $settings,
            'mode' => !$setUp ? 'remote' : $settings->getMode(),
            'setUp' => $setUp,
            'missing' => $missing,
            'local' => Local::address(),
            'counting' => $settings->getMode() === 'local' && $missing === '',
        ]);
    }

    /**
     * A key saved for one Runlight is never sent to another: when the address changes and a key was
     * left as it was, the key is cleared, as the WordPress and Drupal plugins do.
     */
    public function beforeSaveSettings(): bool
    {
        $before = Craft::$app->getProjectConfig()->get(ProjectConfig::PATH_PLUGINS . '.' . $this->handle . '.settings');
        $this->getSettings()->forgetKeysIfMoved(is_array($before) ? $before : []);
        return parent::beforeSaveSettings();
    }

    /** Whether the address answers as a Runlight, and what to say about it. */
    public static function check(string $address): array
    {
        try {
            $response = Craft::createGuzzleClient(['timeout' => 5, 'http_errors' => false])->get($address . '/api');
            $body = json_decode((string) $response->getBody(), true);
            if ($response->getStatusCode() === 200 && is_array($body) && ($body['name'] ?? '') === 'runlight') {
                return ['ok' => true, 'message' => Craft::t('runlight', 'Connected to Runlight {version}.', ['version' => (string) ($body['version'] ?? '')])];
            }
            return ['ok' => false, 'message' => Craft::t('runlight', 'Something answered, but not Runlight. Check that this is the address Runlight answers at, such as https://example.com/runlight for an app with Runlight mounted, or https://stats.example.com for the standalone server.')];
        } catch (\Throwable $e) {
            return ['ok' => false, 'message' => Craft::t('runlight', 'Could not reach it: {error}', ['error' => $e->getMessage()])];
        }
    }

    /** The address of the Runlight the script and reports go to, wherever it runs, or an empty string for none yet. */
    private function address(): string
    {
        $settings = $this->getSettings();
        return match ($settings->getMode()) {
            'local' => Local::active() ? Local::address() : '',
            'remote' => $settings->getAddress(),
            default => '',
        };
    }

    private function registerScript(): void
    {
        $settings = $this->getSettings();
        $address = $this->address();
        if ($address === '') {
            return;
        }
        $user = Craft::$app->getUser();
        if ($settings->skipAdmins && !$user->getIsGuest() && $user->checkPermission('accessCp')) {
            self::keepOutOfCaches();
            return;
        }
        $options = ['defer' => true, 'position' => View::POS_HEAD];
        if ($settings->getMode() === 'remote' && $settings->getSite() !== '') {
            $options['data-site'] = $settings->getSite();
        }
        if (!$settings->outbound) {
            $options['data-outbound'] = 'false';
        }
        if (!$settings->downloads) {
            $options['data-downloads'] = 'false';
        }
        if (Craft::$app->getResponse()->getStatusCode() === 404) {
            $options['data-404'] = true;
        }
        Craft::$app->getView()->registerJsFile($address . '/s.js', $options);
    }

    /**
     * A page left without the script for a Control Panel user must never be cached and served to
     * everyone else, or their visits would go uncounted. Blitz is told not to cache it, and any other
     * cache in front of Craft is told by the headers.
     */
    private static function keepOutOfCaches(): void
    {
        if (class_exists('putyourlightson\\blitz\\Blitz') && isset(\putyourlightson\blitz\Blitz::$plugin)) {
            \putyourlightson\blitz\Blitz::$plugin->generateCache->options->cachingEnabled = false;
        }
        Craft::$app->getResponse()->setNoCacheHeaders();
    }

    /**
     * Records a page served to an AI agent. Agents run no JavaScript, so the
     * script never sees them. It runs once the response has been sent, and
     * only for known agents.
     */
    private function observe(): void
    {
        $settings = $this->getSettings();
        $request = Craft::$app->getRequest();
        $agent = (string) $request->getUserAgent();
        $key = $settings->getObserveKey();
        $local = $settings->getMode() === 'local';
        // Runlight here records them itself, apart from its own pages; another one needs the agents key.
        $ready = $local ? Local::active() && !Local::$served : $settings->getMode() === 'remote' && $settings->getAddress() !== '' && $key !== '';
        if (!$ready || !$request->getIsGet() || !Agents::isAgent($agent)) {
            return;
        }
        // The page has been sent, but under PHP-FPM or LiteSpeed the agent still waits until PHP
        // finishes. Closing the connection first means the report never keeps it waiting.
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        }
        try {
            if ($local) {
                Local::observe($request->getAbsoluteUrl(), $agent);
                return;
            }
            Craft::createGuzzleClient(['timeout' => 3])->post($settings->getAddress() . '/api/observe', [
                'headers' => ['Authorization' => 'Bearer ' . $key],
                'json' => ['url' => $request->getAbsoluteUrl(), 'userAgent' => $agent],
            ]);
        } catch (\Throwable $e) {
            // Analytics must never break the page it watches; note it and move on.
            Craft::warning('Could not record an AI agent fetch: ' . $e->getMessage(), 'runlight');
        }
    }
}
