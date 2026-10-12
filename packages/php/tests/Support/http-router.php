<?php

declare(strict_types=1);

// A router for PHP's built-in server in the fetch tests: /bytes?n=...&status=... answers n bytes of "a", in chunks. Under
// /emit/ it answers through Response::emit(), /request answers with the request Request::fromGlobals() reads, and
// /redirect?status=...&to=... redirects there.
require __DIR__ . '/../../vendor/autoload.php';
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/redirect') {
    http_response_code((int) ($_GET['status'] ?? 302));
    header('location: ' . ($_GET['to'] ?? '/'));
    return true;
}
if ($path === '/emit/untyped') {
    (new Runlight\Http\Response('', 202, ['cache-control' => 'no-store']))->emit();
    return true;
}
if ($path === '/emit/typed') {
    (new Runlight\Http\Response('{}', 200, ['content-type' => 'application/json']))->emit();
    return true;
}
if ($path === '/emit/app-typed') {
    header('Content-Type: text/x-app');
    (new Runlight\Http\Response('x', 200))->emit();
    return true;
}
if ($path === '/request') {
    $request = Runlight\Http\Request::fromGlobals();
    header('content-type: application/json');
    echo json_encode(['url' => $request->url, 'method' => $request->method, 'headers' => $request->headers->all(), 'body' => $request->text()]);
    return true;
}
if ($path === '/bytes') {
    $n = (int) ($_GET['n'] ?? 0);
    http_response_code((int) ($_GET['status'] ?? 200));
    header('content-type: text/html');
    while ($n > 0) {
        $part = min($n, 8192);
        echo str_repeat('a', $part);
        flush();
        $n -= $part;
    }
    return true;
}
header('content-type: text/plain');
echo 'host ' . ($_SERVER['HTTP_HOST'] ?? '');
return true;
