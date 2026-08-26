//! The loop that turns "mail arrived" into a notification.
//!
//! # Why this shell polls at all
//!
//! The deployed client already gets Web Push, and in a browser that is
//! what notifies. **It cannot work inside this window**, and that was
//! measured in the running app rather than assumed:
//!
//! ```text
//! PushManager                            undefined
//! PushSubscription                       undefined
//! serviceWorker.register('/sw.js')       OK, scope https://postbox-valen.duckdns.org/
//! registration.pushManager               undefined
//! Notification.requestPermission()       "denied"   (no prompt shown)
//! new Notification(...)                  constructs, then fires onerror
//! registration.showNotification(...)     TypeError: Registration does not
//!                                        have permission to show notifications
//! ```
//!
//! WKWebView is not Safari. It runs service workers, but it exposes no
//! Push API to subscribe with, and its `Notification` is a stub whose
//! permission request resolves `denied` without ever asking anyone. There
//! is no page-side path to a notification here, so the shell has to learn
//! about mail itself.
//!
//! # Polling, rather than bridging through the page
//!
//! The alternative was to inject a script that fetches on the page's
//! behalf and reports back. It was rejected for three reasons:
//!
//!  1. It needs a channel out of the webview, and this app deliberately
//!     grants the remote origin **no** Tauri command at all
//!     (`app.security.capabilities` is `[]`). The choice would have been
//!     to open one, or to abuse the navigation policy as an IPC channel —
//!     and that policy is the thing standing between attacker-authored
//!     email and this window (origin.rs). Neither is worth it.
//!  2. `initialization_script` runs in every frame wry creates, including
//!     the one the reader puts hostile HTML in.
//!  3. The decision "is this new mail" would then live in a JavaScript
//!     string constant inside a Rust file, where no test can reach it.
//!     In Rust it is mailwatch.rs, with fourteen.
//!
//! What polling costs, stated plainly: a notification arrives up to
//! `POLL_INTERVAL` after the mail does, where Web Push in a browser
//! arrives in seconds; and the app makes one small authenticated GET a
//! minute for as long as it is running. It buys a shell that needs no
//! change to the client, no new native capability, and no credential of
//! its own — see inbox.rs for that last part.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::WebviewWindow;

use crate::inbox::{self, Poll};
use crate::mailwatch::MailWatch;
use crate::notify;

/// How often the inbox is read.
///
/// A minute is the honest middle of the trade above: fast enough that
/// mail feels like it arrives, slow enough that an app left open all day
/// is not a background workload. It is also well clear of anything the
/// server rate-limits — `sync/src/api/rate-limit.ts` bounds failed
/// *logins*, and reads are not counted at all.
const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// A moment's grace before the first read, so the window has finished
/// loading and, on a first-ever launch, the sign-in has had a chance to
/// put a cookie in the store. Nothing depends on this — a poll with no
/// session is simply a no-op that retries a minute later — it just keeps
/// the log quiet on startup.
const FIRST_POLL_DELAY: Duration = Duration::from_secs(5);

/// Starts the poll. Returns immediately; the loop lives on its own thread
/// for the life of the process.
///
/// It must not run on the main thread: `inbox::poll` reads the webview's
/// cookie store, which dispatches to the main thread and waits for it.
pub fn start(window: WebviewWindow) {
    std::thread::spawn(move || run(window));
}

fn run(window: WebviewWindow) {
    std::thread::sleep(FIRST_POLL_DELAY);
    let mut watch = MailWatch::new();

    loop {
        watch = match inbox::poll(&window) {
            // No session. Nothing is fetched and nothing is posted, which
            // is what makes "an app that has never been signed in is
            // silent" structural rather than a rule someone wrote down.
            //
            // The watch is reset rather than kept, so that signing back
            // in re-baselines: the first poll after a sign-in reports
            // nothing, exactly like the first poll after a launch. Mail
            // that arrived while signed out is not an event to buzz
            // about — it is the state of an inbox being seen for the
            // first time.
            Poll::SignedOut => MailWatch::new(),

            // Transient — a dropped network, a restarting server. Logged
            // once and retried on the next tick, with the watch intact so
            // the outage does not re-baseline and swallow the mail that
            // arrives right after it.
            Poll::Failed(reason) => {
                eprintln!("desktop: new-mail poll failed — {reason}");
                watch
            }

            Poll::Page(page) => {
                let (next, fresh) = watch.accept(&page, now_ms());
                for message in fresh {
                    let window = window.clone();
                    std::thread::spawn(move || notify::announce(&window, &message));
                }
                next
            }
        };

        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Milliseconds since the epoch.
///
/// A clock set before 1970 is the only way this fails, and answering 0
/// for it is safe in the only direction that matters: every message then
/// looks old, so nothing is announced, rather than everything being.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}
