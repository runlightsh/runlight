<?php

declare(strict_types=1);

namespace Runlight\Cms;

/**
 * The script a CMS plugin puts on its admin page beside Runlight's dashboard in a frame (assets/frame.js). It
 * defines runlightFrame(frame), which grows the frame to the dashboard's height, tells the dashboard which
 * part of it is on screen, and reloads the page when the dashboard asks. The frame carries the rest:
 * data-runlight-origin (the dashboard's origin), data-runlight-bars (a selector for the admin's bars that stay
 * over the page), and data-runlight-gap (the room to leave below it until the dashboard says how tall it is).
 */
final class Frame
{
    /** The script that defines runlightFrame(). */
    public static function script(): string
    {
        return (string) file_get_contents(__DIR__ . '/../../assets/frame.js');
    }

    /** The script, then a call to runlightFrame() for the frame with this id. */
    public static function run(string $id = 'runlight-embed'): string
    {
        return self::script() . 'runlightFrame(document.getElementById(' . json_encode($id) . "));\n";
    }
}
