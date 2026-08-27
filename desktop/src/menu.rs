//! The native macOS menu bar.
//!
//! **A webview does not get Cut/Copy/Paste for free.** On macOS those are
//! not keyboard shortcuts the text field implements — they are menu items
//! whose key equivalents AppKit dispatches down the responder chain. An app
//! with no Edit menu has no `copy:` item, so ⌘C reaches nothing and does
//! nothing, in every text field the app has. That is the single most common
//! complaint about webview-shell apps, and this module is the whole fix.
//!
//! Everything here except Reload is a `PredefinedMenuItem`, which is the
//! point: a predefined item is wired to the real AppKit selector and comes
//! with the real system accelerator (⌘X/⌘C/⌘V/⌘A, ⌘Z/⇧⌘Z, ⌘M, ⌘W, ⌘H, ⌘Q,
//! ⌃⌘F) already attached. Hand-rolling these as custom items would look
//! identical and behave subtly wrong — a custom "Copy" cannot copy the
//! webview's selection, because it is not the responder that owns it.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// The one custom item in the bar. WebKit has no predefined reload, so ⌘R
/// is a real menu item routed back to the webview in main.rs.
pub const RELOAD_ITEM_ID: &str = "postbox:reload";

/// Builds the whole bar in the standard macOS order: app, Edit, View,
/// Window. AppKit takes the FIRST submenu as the application menu and draws
/// its title from the bundle name, which is why the app submenu is built
/// with the package name and appears first.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = app.package_info();

    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        comments: Some("The Valen Mail mail client, as a macOS window.".into()),
        website: Some(crate::origin::POSTBOX_URL.into()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        package.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, RELOAD_ITEM_ID, "Reload", true, Some("CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}
