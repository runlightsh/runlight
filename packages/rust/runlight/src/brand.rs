//! The Runlight mark.

/// The Runlight mark for the dashboard's tab: an R in a rounded lamp housing, one corner lit.
pub const RUNLIGHT_ICON: &str = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%22100%20100%20824%20824%22%3E%3Cdefs%3E%3Cmask%20id%3D%22rlf-n%22%20maskUnits%3D%22userSpaceOnUse%22%20x%3D%220%22%20y%3D%220%22%20width%3D%221024%22%20height%3D%221024%22%3E%3Crect%20width%3D%221024%22%20height%3D%221024%22%20fill%3D%22%23fff%22/%3E%3Ccircle%20cx%3D%2223.6%22%20cy%3D%228.4%22%20r%3D%223.5%22%20fill%3D%22%23000%22%20transform%3D%22translate%2896%20104%29%20scale%2826%29%22/%3E%3C/mask%3E%3C/defs%3E%3Crect%20x%3D%22100%22%20y%3D%22100%22%20width%3D%22824%22%20height%3D%22824%22%20rx%3D%22185%22%20fill%3D%22%231c1c1f%22/%3E%3Cg%20mask%3D%22url%28%23rlf-n%29%22%3E%3Cpath%20d%3D%22M11%2023V9h6.2a4.3%204.3%200%200%201%200%208.6H11M17%2017.6l5%205.4%22%20transform%3D%22translate%2896%20104%29%20scale%2826%29%22%20fill%3D%22none%22%20stroke%3D%22%23fafafa%22%20stroke-width%3D%223.1%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22/%3E%3C/g%3E%3Ccircle%20cx%3D%2223.6%22%20cy%3D%228.4%22%20r%3D%222.75%22%20fill%3D%22%2322c55e%22%20transform%3D%22translate%2896%20104%29%20scale%2826%29%22/%3E%3C/svg%3E";

/// The mark for emails: the PNG at the sending install's own /logo.png, shown at 48 pixels. Opening an email
/// fetches it from that install and from nowhere else; a client that blocks images shows the word Runlight.
/// `home` is the install's address with its base path, such as `https://example.com/runlight`.
pub fn email_logo(home: &str) -> String {
    let src = format!("{}/logo.png", home.trim_end_matches('/'))
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<img src=\"{src}\" width=\"48\" height=\"48\" alt=\"Runlight\" style=\"display:block;width:48px;height:48px;margin:0 0 24px;border:0;outline:none;text-decoration:none;font:700 16px/48px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#6b7280\">"
    )
}
