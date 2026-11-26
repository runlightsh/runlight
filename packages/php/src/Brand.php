<?php

declare(strict_types=1);

namespace Runlight;

final class Brand
{
    private static ?string $logo = null;

    /** The Runlight mark for the dashboard's tab: an R in a rounded lamp housing, one corner lit. A data: URL. */
    public static function runlightIcon(): string
    {
        return (string) Version::build()['icon'];
    }

    /**
     * The mark as a 96 pixel PNG, base64, the same drawing as the website's header and the Mac app's icon. Each
     * install serves it at <base>/logo.png, without signing in, for its emails.
     */
    public static function logoPng(): string
    {
        return (string) Version::build()['logoPng'];
    }

    /** The email logo's bytes, decoded from base64 the first time they are asked for. */
    public static function logoBytes(): string
    {
        return self::$logo ??= (string) base64_decode(self::logoPng(), true);
    }

    /**
     * The mark for emails: the PNG at the sending install's own /logo.png, shown at 48 pixels. Opening an email
     * fetches it from that install and from nowhere else; a client that blocks images shows the word Runlight.
     * $home is the install's address with its base path, such as https://example.com/runlight.
     */
    public static function emailLogo(string $home): string
    {
        $src = str_replace(['&', '"', '<', '>'], ['&amp;', '&quot;', '&lt;', '&gt;'], rtrim($home, '/') . '/logo.png');
        return '<img src="' . $src . '" width="48" height="48" alt="Runlight" style="display:block;width:48px;height:48px;margin:0 0 24px;border:0;outline:none;text-decoration:none;font:700 16px/48px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#6b7280">';
    }
}
