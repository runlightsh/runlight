<?php

declare(strict_types=1);

// One of several processes racing on one database: php turns.php <what> <start> <kind> <url or path> [schema]
// "count" adds one to a setting 20 times under the lock; "throttle" makes 10 tries against a limit of 5.

require __DIR__ . '/../../vendor/autoload.php';

use Runlight\Accounts\Throttle;
use Runlight\Store\Stores;

[, $what, $start, $kind, $where] = $argv;
$store = match ($kind) {
    'sqlite' => Stores::sqlite($where),
    'postgres' => Stores::postgres($where, ['schema' => $argv[5]]),
    default => Stores::mysql($where),
};
$store->migrate();
// Every process starts at the same moment, so their turns overlap.
while (microtime(true) < (float) $start) {
    usleep(1000);
}
if ($what === 'count') {
    for ($i = 0; $i < 20; $i++) {
        $store->db->exclusive(static function () use ($store): void {
            $n = (int) ($store->setting('turns') ?? 0);
            usleep(500);
            $store->setSetting('turns', (string) ($n + 1));
        });
    }
    echo "ok\n";
} else {
    $throttle = new Throttle($store, 'race', 5);
    $taken = 0;
    for ($i = 0; $i < 10; $i++) {
        $taken += $throttle->take('jon@example.com', 1_791_288_000_000) ? 1 : 0;
    }
    echo "$taken\n";
}
$store->close();
