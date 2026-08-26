//! Postbox for macOS — a native window onto the deployed Postbox client.
//!
//! # Why this loads a remote URL instead of bundling the client
//!
//! The alternative — embedding `client/`'s build output and serving it from
//! Tauri's own asset protocol — cannot authenticate, and cannot be made to
//! without editing code this task is not allowed to touch:
//!
//!  * `client/src/{api,session,composeApi,pushApi}.ts` address the API with
//!    **relative paths** (`/api/inbox`, `/api/session`) and
//!    `credentials: 'same-origin'`, and say so in their own doc comments
//!    ("this module must never learn a second base URL"). Bundled, those
//!    paths resolve against `tauri://localhost` and reach no server at all.
//!  * The session credential is a `__Host-`prefixed, `Secure`,
//!    `SameSite=Strict` cookie (sync/src/api/session.ts). From a
//!    `tauri://` origin every API call is cross-site, so the browser would
//!    not attach it even if the URLs were absolute.
//!  * `sync/` sends no `Access-Control-Allow-Origin` header anywhere, so a
//!    cross-origin call fails at the preflight before auth is even reached.
//!
//! Loading `https://postbox-valen.duckdns.org` makes the webview a
//! first-party client of that origin, exactly like Safari or Chrome: the
//! cookie is set, stored and re-sent by WebKit with no help from this
//! process, and no credential is ever handled by, or stored in, the desktop
//! app. That is also why there is no keychain code here — there is nothing
//! to keep.
//!
//! What this shell is responsible for, then, is the part a browser tab does
//! not give you: a real window that remembers itself, a native menu bar
//! (see menu.rs — without it ⌘C does nothing), a hard rule that the window
//! never leaves Postbox (see links.rs and origin.rs), and native new-mail
//! notifications (poll.rs, mailwatch.rs, inbox.rs, notify.rs).
//!
//! That last one is the one place the "no credential here" rule above gets
//! a footnote, so it is stated rather than buried: the poll borrows the
//! session cookie out of WebKit's own store for the duration of one
//! request and keeps no copy. There is still nothing stored, and still no
//! keychain. See inbox.rs.
//!
//! Notifications are native and not the page's because the page cannot do
//! it: WKWebView exposes no `PushManager` and denies
//! `Notification.requestPermission()` outright. poll.rs opens with the
//! measurement.

mod inbox;
mod links;
mod mailwatch;
mod menu;
mod notify;
mod origin;
mod poll;

use tauri::menu::MenuEvent;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{
    AppHandle, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_window_state::StateFlags;
use url::Url;

/// The only window. Also the key the window-state plugin files its geometry
/// under, so renaming it silently forgets every saved position.
const MAIN_WINDOW_LABEL: &str = "main";

/// Comfortable for a three-column mail client on any modern Mac display,
/// and only used the very first time — after that the saved geometry wins.
const DEFAULT_WIDTH: f64 = 1280.0;
const DEFAULT_HEIGHT: f64 = 860.0;

/// **1024 is not a taste call.** Tailwind's `lg:` breakpoint is `64rem` =
/// 1024px, and the client's shell is `hidden lg:flex` for the sidebar and
/// `lg:hidden` for the mobile top bar (client/src/AppShell.tsx). One pixel
/// narrower and the desktop window renders the phone layout — a hamburger
/// drawer in a 1023px-wide window. This is the width below which the app is
/// simply wrong, so it is the width the window refuses to go below.
const MIN_WIDTH: f64 = 1024.0;

/// Enough for the top bar, a usable list, and the reader beneath it.
const MIN_HEIGHT: f64 = 640.0;

/// `VISIBLE` and `DECORATIONS` are deliberately not tracked. Persisting
/// "was visible" is a way for the app to start up with no window at all —
/// the plugin records visibility at restore time, and this window is built
/// hidden — and decorations never change.
const TRACKED_WINDOW_STATE: StateFlags = StateFlags::POSITION
    .union(StateFlags::SIZE)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::FULLSCREEN);

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(TRACKED_WINDOW_STATE)
                .build(),
        )
        // `open_js_links_on_click(false)`: the plugin's default injects a
        // click handler into the page to catch `target="_blank"` links, but
        // the links that matter here live inside the reader's sandboxed
        // message-body iframe, which that script does not reach — and it
        // would call back over IPC, which this app grants no capabilities
        // for. Every link is handled natively in links.rs instead. The
        // plugin is registered only for its Rust-side `open_url`.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .on_menu_event(handle_menu_event)
        .setup(|app| {
            app.set_menu(menu::build(app.handle())?)?;
            // Before anything is posted, and once — see notify::register
            // for what goes wrong when it is not called at all.
            notify::register(&app.config().identifier);
            let window = build_main_window(app.handle())?;
            // Built hidden, shown here. The window-state plugin's restore
            // is queued onto the event loop rather than run inside
            // `build()`, so it lands a turn later and the window resizes
            // once after becoming visible; `enforce_minimum_size` runs off
            // that same resize (see `handle_run_event`).
            window.show()?;
            window.set_focus()?;
            poll::start(window);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("postbox-desktop: failed to start")
        .run(handle_run_event);
}

/// Re-applies the minimum size to a window that was resized programmatically.
///
/// **`min_inner_size` alone is not enough, and this was caught in a running
/// build, not reasoned about.** The window-state plugin restores geometry
/// with `set_size`, and AppKit's `setContentSize:` does not consult the
/// window's minimum content size — so a saved size from a hand-edited state
/// file, an earlier build with a smaller floor, or a display that has since
/// changed, restores verbatim. Seeded with 900x500 the window came back at
/// 900x500 and the client rendered its MOBILE layout (`matchMedia("(min-
/// width: 1024px)")` was false) inside a desktop window.
///
/// It is called from the `Resized` handler and not just once at startup
/// because the restore is queued onto the event loop (tauri's
/// `WindowManager::attach_window` dispatches the plugin hook with
/// `run_on_main_thread`), so it lands AFTER `setup` has returned — a single
/// check in `setup` inspects the default size and finds nothing wrong.
/// Reacting to the resize is ordering-independent. It cannot fight the
/// user: AppKit does enforce the minimum for a dragged resize, so a
/// below-minimum `Resized` only ever comes from code.
fn enforce_minimum_size(window: &WebviewWindow) -> tauri::Result<()> {
    let scale = window.scale_factor()?;
    let restored = window.inner_size()?.to_logical::<f64>(scale);
    let width = restored.width.max(MIN_WIDTH);
    let height = restored.height.max(MIN_HEIGHT);
    if width > restored.width || height > restored.height {
        window.set_size(LogicalSize::new(width, height))?;
    }
    Ok(())
}

fn build_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let url: Url = origin::POSTBOX_URL
        .parse()
        .expect("POSTBOX_URL is a compile-time constant and must parse");

    let for_navigation = app.clone();
    let for_new_window = app.clone();

    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Postbox")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .visible(false)
        // The app shell itself must never be navigated off Postbox. wry
        // runs this for subframes too, which is why `classify` treats
        // `about:` as in-app — see origin.rs.
        .on_navigation(move |url| match origin::classify(url) {
            origin::Destination::InApp => true,
            _ => {
                links::open_outside(&for_navigation, url);
                false
            }
        })
        // Every link in every email arrives here, not above: the reader
        // frames message bodies with `<base target="_blank">`, so a click
        // is a popup request. Denied here, opened in the default browser.
        .on_new_window(move |url, _features| {
            links::open_outside(&for_new_window, &url);
            NewWindowResponse::Deny
        })
        // Attachments are `<a href="/api/…" download>` links. WebKit routes
        // those to the download delegate, and wry cancels them outright
        // unless a handler exists — so without this, clicking an attachment
        // would silently do nothing. wry has already resolved a
        // de-duplicated path under ~/Downloads by the time this runs; all
        // that is left is to refuse downloads that did not come from
        // Postbox itself.
        .on_download(|_webview, event| match event {
            DownloadEvent::Requested { url, .. } => {
                let allowed = origin::is_postbox(&url);
                if !allowed {
                    eprintln!(
                        "desktop: refused a download from {} — not the Postbox origin",
                        origin::for_log(&url)
                    );
                }
                allowed
            }
            _ => true,
        })
        .build()
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id() != menu::RELOAD_ITEM_ID {
        return;
    }
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    if let Err(error) = window.reload() {
        eprintln!("desktop: reload failed: {error}");
    }
}

/// Closing the window hides it instead of destroying it, and the Dock icon
/// brings it back — the macOS convention, and the reason ⌘W does not throw
/// away a loaded, signed-in webview.
///
/// This does NOT strand the app: `terminate:` (what the Quit item fires)
/// never raises `CloseRequested`, so `prevent_close` is not on the quit
/// path. Verified in the built app — quitting it exits the process and
/// still writes the saved geometry, with and without this handler.
fn handle_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == MAIN_WINDOW_LABEL => {
            api.prevent_close();
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.hide();
            }
        }
        // The window-state plugin restores geometry after `setup` has
        // returned; this is what puts the floor back under it.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Resized(_),
            ..
        } if label == MAIN_WINDOW_LABEL => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = enforce_minimum_size(&window);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    }
}
