<?php

declare(strict_types=1);

namespace Runlight\Tests\Support;

/** PHP's built-in server on a free local port, answering through http-router.php, for the tests that fetch for real. */
final class LocalServer
{
    /** @var resource */
    private $process;
    public readonly int $port;

    public function __construct()
    {
        $probe = stream_socket_server('tcp://127.0.0.1:0');
        $this->port = (int) explode(':', (string) stream_socket_get_name($probe, false))[1];
        fclose($probe);
        $this->process = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $this->port, __DIR__ . '/http-router.php'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        for ($i = 0; $i < 100; $i++) {
            $socket = @stream_socket_client('tcp://127.0.0.1:' . $this->port, $errno, $errstr, 0.1);
            if ($socket !== false) {
                fclose($socket);
                return;
            }
            usleep(50_000);
        }
    }

    public function stop(): void
    {
        if (is_resource($this->process)) {
            proc_terminate($this->process);
            proc_close($this->process);
        }
    }
}
