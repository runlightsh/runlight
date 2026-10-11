<?php

/**
 * Builds the plugin zip the WordPress.org directory takes:
 *
 *     php plugins/wordpress/build.php [output directory]
 *
 * writes runlight-<version>.zip (default into plugins/wordpress/dist/) with
 * one folder, runlight/, holding the plugin's own files and, under lib/, the
 * PHP package it runs Runlight with inside WordPress.
 * The header's Version, the readme's Stable tag, and the readme's changelog
 * must agree, or the build stops. Entries carry a fixed time, so the same
 * sources give the same zip.
 */

declare(strict_types=1);

$root = __DIR__;
$main = (string) file_get_contents("$root/runlight.php");
$readme = (string) file_get_contents("$root/readme.txt");
preg_match('/^ \* Version:\s+(\S+)/m', $main, $m);
$version = $m[1] ?? '';
preg_match('/^Stable tag:\s+(\S+)/m', $readme, $s);
if ($version === '' || ($s[1] ?? '') !== $version || !str_contains($readme, "= $version =")) {
    fwrite(STDERR, "build: the Version ($version), the readme's Stable tag, and its changelog must agree\n");
    exit(1);
}
if (!str_contains($main, "define( 'RUNLIGHT_PLUGIN_VERSION', '$version' )")) {
    fwrite(STDERR, "build: RUNLIGHT_PLUGIN_VERSION must be $version\n");
    exit(1);
}

$files = ['runlight.php', 'uninstall.php', 'readme.txt'];
foreach (glob("$root/includes/*.php") ?: [] as $file) {
    $files[] = 'includes/' . basename($file);
}
sort($files);

// Runlight itself, from packages/php, for running it in this WordPress: its source and the built dashboard,
// under lib/ as the package lays them out. The command line, the standalone server, and the framework bridges
// are left out, since WordPress never runs them.
$library = dirname($root, 2) . '/packages/php';
$leftOut = ['src/Server/Cli.php', 'src/Server/Config.php', 'src/Server/Standalone.php', 'src/Server/Agents.php', 'src/Server/SendError.php', 'src/Server/FrontController.php', 'src/Bridge/HttpFoundation.php', 'src/Bridge/ShortLinks.php'];
$bundled = ['LICENSE' => 'lib/LICENSE'];
foreach (['src', 'assets'] as $folder) {
    $walk = new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$library/$folder", FilesystemIterator::SKIP_DOTS));
    foreach ($walk as $file) {
        $path = substr($file->getPathname(), strlen("$library/"));
        if ($file->isFile() && !in_array($path, $leftOut, true) && !str_starts_with($file->getFilename(), '.')) {
            $bundled[$path] = "lib/$path";
        }
    }
}
ksort($bundled);

$out = rtrim($argv[1] ?? "$root/dist", '/');
@mkdir($out, 0775, true);
$zipPath = "$out/runlight-$version.zip";
@unlink($zipPath);
$zip = new ZipArchive();
if ($zip->open($zipPath, ZipArchive::CREATE) !== true) {
    fwrite(STDERR, "build: cannot write $zipPath\n");
    exit(1);
}
foreach ($files as $file) {
    $zip->addFile("$root/$file", "runlight/$file");
    $zip->setMtimeName("runlight/$file", 1767225600);
}
foreach ($bundled as $from => $to) {
    $zip->addFile("$library/$from", "runlight/$to");
    $zip->setMtimeName("runlight/$to", 1767225600);
}
$zip->close();
echo "build: $zipPath (" . (count($files) + count($bundled)) . " files)\n";
