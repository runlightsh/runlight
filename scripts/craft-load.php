<?php

/**
 * Loads every class of the Craft plugin against a real Craft install, which
 * catches what php -l cannot: a method whose signature no longer matches the
 * Craft class it overrides, or a parent that has gone. CI runs it after
 * installing the plugin's dependencies:
 *
 *   (cd plugins/craft && composer update) && php scripts/craft-load.php
 */

declare(strict_types=1);

$plugin = dirname(__DIR__) . '/plugins/craft';
// The plugin is released with the library in this repository, which may be newer than the one Composer
// installs from Packagist, so Runlight's own classes load from here first.
$library = dirname(__DIR__) . '/packages/php/src/';
spl_autoload_register(static function (string $class) use ($library): void {
    if (str_starts_with($class, 'Runlight\\') && !str_starts_with($class, 'Runlight\\Craft\\')) {
        $file = $library . str_replace('\\', '/', substr($class, strlen('Runlight\\'))) . '.php';
        if (is_file($file)) {
            require $file;
        }
    }
}, true, true);
require $plugin . '/vendor/autoload.php';
require $plugin . '/vendor/yiisoft/yii2/Yii.php';
require $plugin . '/vendor/craftcms/cms/src/Craft.php';

$files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($plugin . '/src', FilesystemIterator::SKIP_DOTS));
$count = 0;
foreach ($files as $file) {
    // Translations are arrays of messages, not classes.
    if ($file->getExtension() !== 'php' || str_contains($file->getPathname(), '/translations/')) {
        continue;
    }
    $class = 'Runlight\\Craft\\' . str_replace('/', '\\', substr($file->getPathname(), strlen($plugin . '/src/'), -4));
    if (!class_exists($class)) {
        fwrite(STDERR, "$class did not load from {$file->getPathname()}\n");
        exit(1);
    }
    $count++;
}
echo "Loaded $count Craft plugin classes against craftcms/cms " . \Composer\InstalledVersions::getPrettyVersion('craftcms/cms') . "\n";
