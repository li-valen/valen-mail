//! Which URLs stay inside the app window, and which leave for the browser.
//!
//! This is the load-bearing decision in the whole shell, so it lives in one
//! place with its own tests rather than inline in a closure.
//!
//! Two things make it matter more than it looks:
//!
//!  1. **The window IS the session.** This shell is a window onto one
//!     origin, and the `__Host-`prefixed, `SameSite=Strict` session cookie
//!     the sync service sets only exists for that origin. A navigation that
//!     carries the app shell somewhere else does not "show another page" —
//!     it strands the user on a foreign site inside a window with no
//!     address bar and no way back.
//!  2. **The content is hostile by construction.** The reader renders
//!     attacker-authored email HTML. Every URL a message can put in front of
//!     a click arrives here.
//!
//! `Blocked` is therefore a real outcome, not a rounding error: handing an
//! arbitrary scheme to the system opener is handing a stranger's email the
//! ability to launch whatever app has registered for it.

use url::Url;

/// The one origin this shell is a window onto.
pub const POSTBOX_URL: &str = "https://postbox-valen.duckdns.org/";

/// Compared against `Url::host_str`, which is already lowercased and
/// punycoded by the parser for special schemes — so this is an exact
/// comparison and not a case-insensitive one on purpose.
const POSTBOX_HOST: &str = "postbox-valen.duckdns.org";

/// Where a URL a webview wants to visit should actually end up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Destination {
    /// Render it here. Only the Postbox origin itself, plus the inert
    /// `about:` URLs a frame is created with.
    InApp,
    /// Hand it to the user's default browser and cancel it here.
    Browser,
    /// Drop it. Nothing opens, nothing navigates.
    Blocked,
}

/// True only for `https://postbox-valen.duckdns.org` on its default port.
///
/// Each clause closes a way to look like Postbox without being it: `https`
/// alone rejects a downgraded `http://` copy, the exact host rejects both
/// `postbox-valen.duckdns.org.evil.com` and a sibling `*.duckdns.org`, and
/// requiring the default port rejects `:8443` — a different origin as far
/// as the cookie is concerned, so it must be a different origin here too.
pub fn is_postbox(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(POSTBOX_HOST) && url.port().is_none()
}

/// Classifies one URL.
///
/// The scheme allowlist is deliberately short. `http`/`https`/`mailto` are
/// the three a mail client actually needs to hand outward; everything else —
/// `javascript:`, `data:`, `file:`, and every custom scheme some other
/// installed app has claimed — is dropped rather than forwarded, because
/// "open this with whatever handles it" is not a decision an email gets to
/// make on the user's behalf.
pub fn classify(url: &Url) -> Destination {
    if is_postbox(url) {
        return Destination::InApp;
    }

    // `about:blank` and `about:srcdoc` are how a frame presents itself
    // before and while it holds inline content — the reader's sandboxed
    // message-body iframe is exactly that. wry's navigation policy fires
    // for subframes as well as the main frame, so cancelling these would
    // blank every email body in the app.
    if url.scheme() == "about" {
        return Destination::InApp;
    }

    match url.scheme() {
        "http" | "https" | "mailto" => Destination::Browser,
        _ => Destination::Blocked,
    }
}

/// A URL reduced to the part that is safe to write to a log.
///
/// A link lifted out of a marketing email is usually a tracking URL whose
/// path and query identify the recipient. Scheme and host are enough to
/// debug "why did this not open"; the rest is not ours to record.
pub fn for_log(url: &Url) -> String {
    match url.host_str() {
        Some(host) => format!("{}://{host}/…", url.scheme()),
        None => format!("{}:…", url.scheme()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify_str(raw: &str) -> Destination {
        classify(&Url::parse(raw).expect("test URL should parse"))
    }

    #[test]
    fn the_app_origin_stays_in_the_window() {
        assert_eq!(classify_str(POSTBOX_URL), Destination::InApp);
        assert_eq!(
            classify_str("https://postbox-valen.duckdns.org"),
            Destination::InApp
        );
        assert_eq!(
            classify_str("https://postbox-valen.duckdns.org/api/inbox?limit=50"),
            Destination::InApp
        );
        assert_eq!(
            classify_str("https://postbox-valen.duckdns.org:443/"),
            Destination::InApp,
            "443 is the default port for https and the parser drops it"
        );
    }

    #[test]
    fn a_lookalike_host_is_not_the_app_origin() {
        assert_eq!(
            classify_str("https://postbox-valen.duckdns.org.evil.example/"),
            Destination::Browser
        );
        assert_eq!(
            classify_str("https://evil.duckdns.org/"),
            Destination::Browser
        );
        assert_eq!(
            classify_str("https://user:pw@evil.example/postbox-valen.duckdns.org"),
            Destination::Browser
        );
    }

    #[test]
    fn a_downgraded_or_off_port_app_origin_leaves_the_window() {
        assert_eq!(
            classify_str("http://postbox-valen.duckdns.org/"),
            Destination::Browser,
            "http is a different origin: the session cookie is Secure"
        );
        assert_eq!(
            classify_str("https://postbox-valen.duckdns.org:8443/"),
            Destination::Browser
        );
    }

    #[test]
    fn ordinary_web_links_go_to_the_browser() {
        assert_eq!(
            classify_str("https://example.com/article"),
            Destination::Browser
        );
        assert_eq!(
            classify_str("http://example.com/article"),
            Destination::Browser
        );
        assert_eq!(
            classify_str("mailto:someone@example.com?subject=hi"),
            Destination::Browser
        );
    }

    #[test]
    fn about_urls_stay_because_a_message_body_frame_is_one() {
        assert_eq!(classify_str("about:blank"), Destination::InApp);
        assert_eq!(classify_str("about:srcdoc"), Destination::InApp);
    }

    #[test]
    fn everything_else_is_dropped_rather_than_handed_to_the_system() {
        assert_eq!(classify_str("javascript:alert(1)"), Destination::Blocked);
        assert_eq!(
            classify_str("data:text/html,<h1>hi</h1>"),
            Destination::Blocked
        );
        assert_eq!(classify_str("file:///etc/passwd"), Destination::Blocked);
        assert_eq!(classify_str("ftp://example.com/x"), Destination::Blocked);
        assert_eq!(
            classify_str("x-some-other-app://do-a-thing"),
            Destination::Blocked
        );
    }

    #[test]
    fn a_log_line_carries_no_path_and_no_query() {
        let tracked =
            Url::parse("https://tracker.example/click?recipient=alice%40example.com").unwrap();
        let line = for_log(&tracked);
        assert_eq!(line, "https://tracker.example/…");
        assert!(!line.contains("alice"));
        assert!(!line.contains("click"));
    }
}
