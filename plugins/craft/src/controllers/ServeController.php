<?php

declare(strict_types=1);

namespace Runlight\Craft\controllers;

use Craft;
use craft\helpers\UrlHelper;
use craft\web\Controller;
use Runlight\Craft\Local;
use Runlight\Http\BodyTooLarge;
use Runlight\Http\Request;
use Runlight\Http\Response as RunlightResponse;
use yii\base\Event;
use yii\web\ForbiddenHttpException;
use yii\web\NotFoundHttpException;
use yii\web\Response;

/**
 * Runlight answering on the site, when it runs in this Craft site: the
 * dashboard and its API under /runlight, and short links under /go, which
 * the site answers itself when no link has the name.
 *
 * Anyone may reach these, since the tracker posts from every visitor's page,
 * and Craft's CSRF check is off for them: Runlight's API takes changes only
 * as JSON, which a form on another site cannot send, and it signs people in
 * through Craft's own session.
 */
final class ServeController extends Controller
{
    protected array|bool|int $allowAnonymous = self::ALLOW_ANONYMOUS_LIVE;
    public $enableCsrfValidation = false;

    /** The dashboard, its API, and the tracker. */
    public function actionIndex(): Response
    {
        return $this->answer(false);
    }

    /** A short link, or the site's own 404 page when there is none by that name. */
    public function actionLink(): Response
    {
        return $this->answer(true);
    }

    /**
     * Runlight sends people who are signed out here, naming the page to come back to, which is
     * always one of its own. Someone signed in who may not use it is told so, rather than sent
     * round to the login page and back.
     */
    public function actionLogin(): Response
    {
        $base = Local::base();
        $next = $this->request->getQueryParam('next');
        $next = is_string($next) ? $next : '';
        $back = Local::origin() . ($next === $base || str_starts_with($next, $base . '/') ? $next : $base . '/');
        $user = Craft::$app->getUser();
        if (!$user->getIsGuest()) {
            if (!$user->checkPermission('accessPlugin-runlight')) {
                throw new ForbiddenHttpException(Craft::t('runlight', 'Your account cannot open Runlight. An admin can allow it under Users, Permissions, Runlight.'));
            }
            return $this->redirect($back);
        }
        $user->setReturnUrl($back);
        return $this->redirect(UrlHelper::cpUrl('login'));
    }

    /** Hands the request to Runlight and its answer back to Craft. */
    private function answer(bool $link): Response
    {
        if (!Local::active()) {
            throw new NotFoundHttpException();
        }
        Local::$served = true;
        $url = $this->request->getAbsoluteUrl();
        $headers = [];
        foreach ($this->request->getHeaders()->toArray() as $name => $values) {
            $headers[strtolower((string) $name)] = array_map('strval', (array) $values);
        }
        // The method as sent, never one a header or field overrides, as Yii allows.
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        // Runlight's address for the visitor is the connection's own; it reads proxy headers itself.
        $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
        try {
            $body = '';
            if (!in_array($method, ['GET', 'HEAD'], true)) {
                $input = fopen('php://input', 'rb');
                $body = $input === false ? '' : Request::readBody($input, $url, $headers['content-length'][0] ?? null);
            }
            $request = new Request($url, $method, $headers, $body, $remote);
        } catch (BodyTooLarge $e) {
            return $this->send(Request::tooLarge());
        }
        $context = ['ip' => $remote];
        try {
            if ($link) {
                $answer = (Local::runlight()->linkHandler())($request, $context);
                // No link by that name: the page is the site's to answer.
                if ($answer->status === 404) {
                    Local::$served = false;
                    throw new NotFoundHttpException();
                }
            } else {
                $answer = Local::routes()->handle($request, $context);
            }
        } catch (NotFoundHttpException $e) {
            throw $e;
        } catch (\Throwable $e) {
            Craft::error('Runlight: ' . $e->getMessage(), 'runlight');
            $answer = new RunlightResponse('{"error":"Internal error","code":"internal"}', 500, ['content-type' => 'application/json; charset=utf-8', 'cache-control' => 'no-store']);
        }
        return $this->send($answer);
    }

    /**
     * Craft's response with Runlight's answer in it, exactly as Runlight made it, kept out of Blitz,
     * and with whatever Runlight left to do run once it has been sent.
     */
    private function send(RunlightResponse $answer): Response
    {
        $response = $this->response;
        $response->format = Response::FORMAT_RAW;
        $response->setStatusCode($answer->status);
        $headers = $response->getHeaders();
        foreach ($answer->headers->all() as $name => $values) {
            $headers->remove($name);
            foreach ($values as $value) {
                $headers->add($name, $value);
            }
        }
        // PHP adds its default type to every answer; one Runlight sends without a type, such as a 202, carries none.
        if (!$answer->headers->has('content-type')) {
            ini_set('default_mimetype', '');
        }
        $response->content = $answer->text();
        if (class_exists('putyourlightson\\blitz\\Blitz') && isset(\putyourlightson\blitz\Blitz::$plugin)) {
            \putyourlightson\blitz\Blitz::$plugin->generateCache->options->cachingEnabled = false;
        }
        Event::on(Response::class, Response::EVENT_AFTER_SEND, static function (): void {
            // The visitor has the answer; whatever is left runs without keeping them waiting.
            if (session_status() === PHP_SESSION_ACTIVE) {
                session_write_close();
            }
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            } elseif (function_exists('litespeed_finish_request')) {
                litespeed_finish_request();
            }
            Local::runlight()->idle();
        });
        return $response;
    }
}
