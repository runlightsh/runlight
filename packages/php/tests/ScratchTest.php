<?php

declare(strict_types=1);

namespace Runlight\Tests;

use PHPUnit\Framework\TestCase;
use Runlight\Scratch;

final class ScratchTest extends TestCase
{
    private string $base;

    protected function setUp(): void
    {
        if (DIRECTORY_SEPARATOR !== '/') {
            $this->markTestSkipped('File modes and links are checked on Unix-like systems.');
        }
        $this->base = sys_get_temp_dir() . '/runlight-scratch-' . bin2hex(random_bytes(5));
        mkdir($this->base);
    }

    protected function tearDown(): void
    {
        if (!isset($this->base)) {
            return;
        }
        foreach (['made', 'open', 'link', 'elsewhere'] as $name) {
            $path = "$this->base/$name";
            if (is_link($path)) {
                unlink($path);
            } elseif (is_dir($path)) {
                array_map('unlink', glob("$path/*") ?: []);
                rmdir($path);
            }
        }
        rmdir($this->base);
    }

    public function testAFolderIsMadeForItsOwnerAlone(): void
    {
        $dir = Scratch::dir('made', $this->base);
        $this->assertSame("$this->base/made", $dir);
        $this->assertSame(0o700, fileperms($dir) & 0o777);
        file_put_contents("$dir/file", 'x');
        Scratch::protect("$dir/file");
        $this->assertSame(0o600, fileperms("$dir/file") & 0o777);
    }

    public function testAFolderOpenToOthersIsClosedFirst(): void
    {
        mkdir("$this->base/open");
        chmod("$this->base/open", 0o777);
        $this->assertSame("$this->base/open", Scratch::dir('open', $this->base));
        clearstatcache();
        $this->assertSame(0o700, fileperms("$this->base/open") & 0o777);
    }

    public function testALinkIsNeverFollowed(): void
    {
        mkdir("$this->base/elsewhere", 0o700);
        symlink("$this->base/elsewhere", "$this->base/link");
        $this->assertNull(Scratch::dir('link', $this->base));
    }

    public function testTheSharedTemporaryFolderGetsANameOfTheUsersOwn(): void
    {
        $dir = Scratch::dir('runlight-scratch-test');
        $this->assertNotNull($dir);
        $this->assertStringStartsWith(sys_get_temp_dir() . '/runlight-scratch-test-', $dir);
        rmdir($dir);
    }
}
