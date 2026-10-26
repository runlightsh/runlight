<?php

/**
 * Builds the plugin zip the WordPress.org directory takes:
 *
 *     php plugins/wordpress/build.php [output directory]
 *
 * writes runlight-<version>.zip (default into plugins/wordpress/dist/) with
 * one folder, runlight/, holding the plugin's own files and, under
 * vendor/runlight/runlight/ as Composer lays it out, the PHP package it runs
 * Runlight with inside WordPress.
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

$files = ['runlight.php', 'uninstall.php', 'readme.txt', 'composer.json'];
foreach (glob("$root/includes/*.php") ?: [] as $file) {
    $files[] = 'includes/' . basename($file);
}
foreach (glob("$root/assets/*.js") ?: [] as $file) {
    $files[] = 'assets/' . basename($file);
}
sort($files);

// Runlight itself, from packages/php, for running it in this WordPress: its source and the built dashboard,
// under vendor/runlight/runlight/ with its composer.json, as Composer installs the package. The command line, the standalone server, and the framework bridges
// are left out, since WordPress never runs them, and so are its PDO connections: inside WordPress it reaches the
// database through $wpdb, or a SQLite file through SQLite3 (includes/WpdbDb.php and includes/Sqlite3Db.php).
// So is whatever the plugin always replaces with WordPress's own: curl (includes/Fetcher.php), the files shared
// between requests (includes/Cache.php), the location data's files (includes/Locations.php), and the SMTP client,
// which the plugin does not offer. Sign-in accounts are left out too, as WordPress's own users sign in. So is what
// reads PHP's superglobals and environment, and its error log, as the plugin passes Runlight a sanitized copy of
// the request (Local::request()), every setting it would look for in the environment, and a log of its own.
$library = dirname($root, 2) . '/packages/php';
$leftOut = [
    'src/Db/PdoDb.php', 'src/Db/Connect.php', 'src/Store/Stores.php',
    'src/Server/Cli.php', 'src/Server/Config.php', 'src/Server/Standalone.php', 'src/Server/Agents.php', 'src/Server/SendError.php', 'src/Server/FrontController.php',
    'src/Bridge/HttpFoundation.php', 'src/Bridge/ShortLinks.php',
    'src/Http/CurlFetcher.php', 'src/Scratch.php', 'src/MmdbFile.php', 'src/Server/DbIpDisk.php',
    'src/Mail/Smtp.php', 'src/Mail/SmtpSession.php',
    'src/Accounts/Web.php', 'src/Accounts/Slots.php', 'src/Accounts/Pages.php',
    'src/Http/Globals.php', 'src/Env.php', 'src/ErrorLog.php',
];
$package = 'vendor/runlight/runlight';
$bundled = ['LICENSE' => "$package/LICENSE", 'composer.json' => "$package/composer.json"];
foreach (['src', 'assets'] as $folder) {
    $walk = new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$library/$folder", FilesystemIterator::SKIP_DOTS));
    foreach ($walk as $file) {
        $path = substr($file->getPathname(), strlen("$library/"));
        if ($file->isFile() && !in_array($path, $leftOut, true) && !str_starts_with($file->getFilename(), '.')) {
            $bundled[$path] = "$package/$path";
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
