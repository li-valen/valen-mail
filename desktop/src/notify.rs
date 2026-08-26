//! Raising one macOS notification, and answering the click.
//!
//! # The permission moment
//!
//! There is no permission call in this file, and that is deliberate.
//!
//! macOS does not let an app ask for notification permission on its own
//! schedule the way a web page does. The system raises its own alert —
//! "Postbox would like to send you notifications" — the first time the
//! app actually delivers one, and never again. So the moment the user is
//! asked is decided entirely by the moment the first notification is
//! posted, which under poll.rs is "the first genuinely new message
//! arrived while signed in".
//!
//! That is the sensible moment the requirement asks for, and it comes for
//! free: the prompt arrives next to a real notification about real mail,
//! not on first paint, and not at all for someone who has never signed in
//! (poll.rs never posts anything without a session, so it never triggers
//! the alert). Calling a `request_permission()` API at startup would be
//! strictly worse — it would move the prompt to first paint — and with
//! this stack it would also be a no-op: the one exposed by
//! tauri-plugin-notification returns a hardcoded `Granted` without
//! consulting the OS at all.
//!
//! Answering "Don't Allow" is therefore the user's off switch, in System
//! Settings › Notifications where every other app's is. Nothing here
//! fights that: `send()` reports success for a suppressed notification
//! the same way it does for a shown one, because delivery is the OS's
//! decision to make and not this process's to second-guess.
//!
//! # No banner while Postbox is the frontmost app, and that is correct
//!
//! `NSUserNotificationCenter` does not draw a banner for the app that is
//! already in front, and mac-notification-sys does not implement
//! `shouldPresentNotification:` to override it. So a notification posted
//! while the user is looking at Postbox is delivered to Notification
//! Centre but never flashes on screen.
//!
//! Measured, not assumed — the same notification, twice, read out of
//! `log stream --predicate 'process == "usernoted"'`:
//!
//! ```text
//! app frontmost:  Delivering <...> to [ .alert .lockScreen .notificationCenter ]
//!                 (no Presenting line)
//! app hidden:     Delivering <...> to [ .alert .lockScreen .notificationCenter ]
//!                 Presenting <...> as banner (["badge", "sound", "alert"])
//! ```
//!
//! It is left alone rather than forced, because it is the right
//! behaviour: a banner announcing mail that is already on the screen in
//! front of you is noise. It is written down because "no banner appeared"
//! while testing with the window in front looks exactly like a bug.
//!
//! # Why this blocks
//!
//! `NSUserNotificationCenter` reports an interaction through a delegate
//! callback on the main thread, and mac-notification-sys surfaces that by
//! blocking the *calling* thread until the notification is clicked,
//! dismissed, or expires. There is no non-blocking form that still hands
//! back the click.
//!
//! So each notification owns a thread for as long as its banner lives.
//! That is affordable only because the number in flight is capped
//! (`MAX_PER_POLL` in mailwatch.rs); it is the reason that cap exists.
//! It also means this must never be called on the main thread — doing so
//! would freeze the window for the life of the banner.
//!
//! One cap is not quite enough, because "the life of the banner" is not
//! bounded when the user has set this app to **Alerts** rather than
//! Banners in System Settings: an alert stays on screen until it is
//! answered, so its thread stays parked until then. `WAITING_LIMIT`
//! below is the backstop — past it, notifications are still posted, they
//! just stop being clickable-to-focus rather than accumulating threads
//! forever.

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{Manager, WebviewWindow};

use crate::mailwatch::Message;

/// How many posted notifications may hold a thread waiting for a click at
/// once. Comfortably above `MAX_PER_POLL`, so the limit is only ever
/// reached by unanswered alerts piling up across several polls.
const WAITING_LIMIT: usize = 8;

static WAITING: AtomicUsize = AtomicUsize::new(0);

/// Holds one of the `WAITING_LIMIT` slots for as long as it is alive.
struct WaitPermit;

impl WaitPermit {
    /// `None` when every slot is taken.
    fn acquire() -> Option<Self> {
        let taken = WAITING
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                (current < WAITING_LIMIT).then_some(current + 1)
            })
            .is_ok();
        taken.then_some(WaitPermit)
    }
}

impl Drop for WaitPermit {
    fn drop(&mut self) {
        WAITING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Teaches the notification centre which app is posting.
///
/// **Not optional.** Left unset, mac-notification-sys falls back to
/// `get_bundle_identifier_or_default("use_default")`, which finds no app
/// by that name and returns **`com.apple.Finder`** — so every
/// notification would arrive attributed to Finder. Called once, before
/// anything is posted.
///
/// A failure is logged rather than propagated: it means LaunchServices
/// does not know this bundle identifier, which happens when the binary is
/// run outside its `.app` (a `cargo run`). The app is still perfectly
/// usable then; it just cannot post notifications, and saying so once is
/// more use than refusing to start.
pub fn register(identifier: &str) {
    if let Err(error) = mac_notification_sys::set_application(identifier) {
        eprintln!(
            "desktop: notifications are unavailable — could not register \"{identifier}\" \
             with the notification centre: {error}"
        );
    }
}

/// Posts one new-mail notification and waits for the user to answer it.
///
/// Blocks. Call it on a thread of its own — see the module comment.
pub fn announce(window: &WebviewWindow, message: &Message) {
    let title = message.sender();
    let body = message.summary();

    // Gmail's shape, and the same one the PWA already uses
    // (`buildMailNotification`, sync/src/push/dispatch.ts): the sender is
    // the title and the subject is the body. macOS prefixes the app name
    // itself, so putting "Postbox" in the title would spend the most
    // valuable line restating something already on screen.
    //
    // Both strings are written by whoever sent the mail. They reach the
    // OS as text and nothing here builds markup from them, exactly as
    // client/public/sw.js's `asText` guarantees on the web side.
    // Without `wait_for_click` the call returns immediately and the click
    // is never reported, which would leave the banner inert. Holding a
    // permit is what makes waiting affordable; without one the
    // notification is still posted, it just cannot be clicked to focus.
    let permit = WaitPermit::acquire();
    let response = mac_notification_sys::Notification::new()
        .title(&title)
        .message(&body)
        .wait_for_click(permit.is_some())
        .send();
    drop(permit);

    match response {
        Err(error) => eprintln!("desktop: could not post a new-mail notification: {error}"),
        Ok(mac_notification_sys::NotificationResponse::Click) => focus(window),
        // Dismissed, expired, posted without a permit, or a button this
        // app never adds. Nothing to do — the mail is in the inbox either
        // way.
        Ok(_) => {}
    }
}

/// Brings the window back in front of the user.
///
/// `show()` is not redundant with `set_focus()`: closing the window hides
/// it rather than destroying it (see `handle_run_event` in main.rs), so
/// the window a notification arrives for may not be on screen at all. An
/// unminimize is needed for the same reason.
///
/// It does NOT open the specific message. `client/src/initialView.ts`
/// understands exactly one deep link — `?rail=opens` — and there is no
/// per-message route to aim at; teaching the client one is a `client/`
/// change this task does not own. The PWA's own new-mail notification has
/// the same limit and for the same reason: `INBOX_URL` in
/// sync/src/push/dispatch.ts is `'/'`, the inbox, not the message.
fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    if let Err(error) = window.show() {
        eprintln!("desktop: could not show the window for a notification click: {error}");
        return;
    }
    if let Err(error) = window.set_focus() {
        eprintln!("desktop: could not focus the window for a notification click: {error}");
        return;
    }
    // Without this the window rises but the app stays behind whatever the
    // user was in, so the click appears to have done nothing.
    let _ = window.app_handle().show();
}
