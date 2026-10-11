<?php

declare(strict_types=1);

namespace Runlight\Craft\jobs;

use Craft;
use craft\queue\BaseJob;
use Runlight\Craft\Local;

/**
 * Runlight's hourly upkeep, queued by a web request when it has not run for
 * an hour: salts, reports, retention, daily totals, and location data.
 */
final class Check extends BaseJob
{
    public function execute($queue): void
    {
        Local::check();
    }

    protected function defaultDescription(): ?string
    {
        return Craft::t('runlight', 'Runlight upkeep');
    }
}
