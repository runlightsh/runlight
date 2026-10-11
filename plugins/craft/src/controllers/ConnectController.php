<?php

declare(strict_types=1);

namespace Runlight\Craft\controllers;

use Craft;
use craft\helpers\UrlHelper;
use craft\web\Controller;
use Runlight\Craft\Connect;
use Runlight\Craft\models\Settings;
use Runlight\Craft\Plugin;
use yii\web\Response;

/**
 * Connecting to a Runlight without copying keys (see Connect). The keys go in Craft's .env file, which
 * belongs to this environment and is never committed, and the settings name them as environment
 * variables, so project config holds no key. Where .env cannot be written, the keys are saved in the
 * settings themselves, with a note saying how to move them.
 *
 * Both actions save the plugin's settings, which live in project config, so only an admin may use them,
 * and only where admin changes are allowed, as Craft asks of its own settings page.
 */
final class ConnectController extends Controller
{
    /** The environment variables Connect keeps the keys in. */
    public const AGENTS_KEY = 'RUNLIGHT_AGENTS_KEY';
    public const DASHBOARD_KEY = 'RUNLIGHT_DASHBOARD_KEY';

    /** Where the Runlight sends the admin back to, which it is registered with. */
    private static function back(): string
    {
        return UrlHelper::cpUrl('runlight/connected');
    }

    private function connect(): Connect
    {
        return new Connect(Craft::createGuzzleClient(), Craft::$app->getCache(), (int) Craft::$app->getUser()->getId(), self::back());
    }

    /** Where what happened is said: the dashboard once connected, or the settings page to try again. */
    private function done(string $message, bool $ok = false): Response
    {
        if ($ok) {
            $this->setSuccessFlash($message);
            return $this->redirect(UrlHelper::cpUrl('runlight'));
        }
        $this->setFailFlash($message);
        return $this->redirect(UrlHelper::cpUrl('settings/plugins/runlight'));
    }

    /** Starts connecting, from the Connect button on the settings page. */
    public function actionStart(): Response
    {
        $this->requirePostRequest();
        $this->requireAdmin();
        $fields = $this->request->getBodyParam('settings');
        $entered = new Settings();
        $entered->address = is_array($fields) && is_string($fields['address'] ?? null) ? trim($fields['address']) : '';
        $address = $entered->getAddress();
        if ($address === '') {
            return $this->done(Craft::t('runlight', 'Enter your Runlight’s address, then press Connect.'));
        }
        if (!$entered->validate(['address'])) {
            return $this->done($entered->getFirstError('address') ?? '');
        }
        [$to, $error] = $this->connect()->start($address, $entered->address);
        return $to !== null ? $this->redirect($to) : $this->done($error);
    }

    /**
     * Finishes connecting when the Runlight sends the admin back. It is a GET with no CSRF token: the
     * state, kept for this admin and compared in Connect, does that work.
     */
    public function actionFinish(): Response
    {
        $this->requireAdmin();
        [$granted, $message] = $this->connect()->finish($this->request->getQueryParams());
        if ($granted === null) {
            return $this->done($message);
        }
        [$observeKey, $dashboardKey, $inEnv] = self::keep($granted['observeKey'], $granted['dashboardKey']);
        $plugin = Plugin::getInstance();
        $before = $plugin->getSettings();
        // Every setting is passed, since Craft saves only the ones it is given to project config. The keys
        // are the new address's own, so they stay even when they are named as they were before.
        $plugin->connecting = true;
        $saved = Craft::$app->getPlugins()->savePluginSettings($plugin, [
            // Connecting means Runlight runs elsewhere, even when it ran in this site before.
            'mode' => 'remote',
            'address' => $granted['address'],
            'site' => $granted['site'],
            'observeKey' => $observeKey,
            'dashboardKey' => $dashboardKey,
            'skipAdmins' => $before->skipAdmins,
            'outbound' => $before->outbound,
            'downloads' => $before->downloads,
            'locations' => $before->locations,
        ]);
        if (!$saved) {
            return $this->done(Craft::t('app', 'Couldn’t save plugin settings.'));
        }
        if (!$inEnv) {
            $message .= ' ' . Craft::t('runlight', 'Craft’s .env file could not be written, so the keys are saved in project config. To keep them out of it, set {agents} and {dashboard} in this environment and enter them as ${agents} and ${dashboard}.', ['agents' => self::AGENTS_KEY, 'dashboard' => self::DASHBOARD_KEY]);
        }
        return $this->done($message, true);
    }

    /**
     * Keeps the keys in Craft's .env file when it can be written.
     *
     * @return array{0: string, 1: string, 2: bool} the agents key and dashboard key to save in the settings,
     *   as environment variables when they went in .env, and whether they did
     */
    private static function keep(string $observeKey, string $dashboardKey): array
    {
        $config = Craft::$app->getConfig();
        $path = $config->getDotEnvPath();
        if (!is_file($path) || !is_writable($path)) {
            return [$observeKey, $dashboardKey, false];
        }
        try {
            $config->setDotEnvVar(self::AGENTS_KEY, $observeKey);
            $config->setDotEnvVar(self::DASHBOARD_KEY, $dashboardKey);
        } catch (\Throwable $e) {
            Craft::warning('Runlight could not write its keys to .env: ' . $e->getMessage(), 'runlight');
            return [$observeKey, $dashboardKey, false];
        }
        return ['$' . self::AGENTS_KEY, '$' . self::DASHBOARD_KEY, true];
    }
}
