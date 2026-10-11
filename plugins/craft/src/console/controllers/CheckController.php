<?php

declare(strict_types=1);

namespace Runlight\Craft\console\controllers;

use craft\console\Controller;
use Runlight\Craft\Local;
use yii\console\ExitCode;

/**
 * `php craft runlight/check`: Runlight's upkeep, for a cron job to run every
 * hour, so it never waits on Craft's queue.
 */
final class CheckController extends Controller
{
    public function actionIndex(): int
    {
        if (!Local::active()) {
            $this->stdout("Runlight does not run in this Craft site, so there is nothing to do.\n");
            return ExitCode::OK;
        }
        Local::check();
        $this->stdout("Done.\n");
        return ExitCode::OK;
    }
}
