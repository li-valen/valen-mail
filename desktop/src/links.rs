//! Handing a URL to the user's default browser.
//!
//! Everything that is not the Valen Mail origin leaves this window. Two
//! separate WebKit paths can ask for that, and the shell has to answer both
//! or the requirement is only half met:
//!
//!  * **Navigation** — the main frame being sent somewhere. Cancelled and
//!    re-opened outside, so the app shell can never be carried off Valen Mail.
//!  * **New window** — `window.open`, or a link with `target="_blank"`.
//!    This is the path that actually matters for mail: the reader renders a
//!    message body inside a sandboxed iframe carrying `<base target="_blank">`
//!    (client/src/components/messageBody.ts), so *every* link in *every*
//!    email arrives here as a popup request and never as a navigation.
//!    Denied, and re-opened outside.
//!
//! Neither path is left to the `opener` plugin's click-interception script:
//! that runs in the page, and the links in question live one sandboxed
//! iframe down from it.

use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::origin::{self, Destination};

/// Sends `url` to the default browser, unless it is something a message
/// should not be able to launch at all.
///
/// Returns nothing to act on by design: from the webview's side the
/// navigation is cancelled either way, and a failure to reach LaunchServices
/// is not something the app can recover from on the user's behalf.
pub fn open_outside<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    match origin::classify(url) {
        Destination::Browser => {
            if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
                eprintln!(
                    "desktop: could not hand {} to the default browser: {error}",
                    origin::for_log(url)
                );
            }
        }
        Destination::Blocked => {
            eprintln!(
                "desktop: refused to open {} — scheme is not one a message may launch",
                origin::for_log(url)
            );
        }
        // Callers only reach here for URLs they already declined to render,
        // so this is unreachable in practice. Doing nothing is still the
        // right answer: it must never become "open Valen Mail in the browser".
        Destination::InApp => {}
    }
}
