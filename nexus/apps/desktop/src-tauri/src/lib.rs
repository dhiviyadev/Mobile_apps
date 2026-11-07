//! NEXUS desktop shell: main window, floating assistant, global shortcuts,
//! menu-bar tray, and the core-service lifecycle. All intelligence lives in the
//! core service; the shell only manages native windows and OS integration.

mod core;

use core::{CoreInfo, CoreProcess};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const MINI_COLLAPSED: (f64, f64) = (420.0, 180.0);
const MINI_EXPANDED: (f64, f64) = (420.0, 600.0);

fn mini(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("mini")
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Place the mini assistant near the top-right of the current monitor the first time it is shown.
fn position_mini(w: &WebviewWindow) {
    if let Ok(Some(monitor)) = w.current_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let x = size.width as f64 - (MINI_EXPANDED.0 + 28.0) * scale;
        let y = 64.0 * scale;
        let _ = w.set_position(PhysicalPosition::new(x.max(0.0), y));
    }
}

fn show_mini(app: &AppHandle, focus: bool) {
    if let Some(w) = mini(app) {
        if !w.is_visible().unwrap_or(false) {
            static POSITIONED: std::sync::Once = std::sync::Once::new();
            POSITIONED.call_once(|| position_mini(&w));
        }
        let _ = w.show();
        if focus {
            let _ = w.set_focus();
            let _ = w.emit("nexus://mini-shown", ());
        }
    }
}

fn toggle_mini_window(app: &AppHandle) {
    if let Some(w) = mini(app) {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
        } else {
            show_mini(app, true);
        }
    }
}

fn show_main_window(app: &AppHandle, route: Option<String>) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if route.is_some() {
            let _ = w.emit("nexus://navigate", route);
        }
    }
}

// -- commands -------------------------------------------------------------------

#[tauri::command]
async fn core_info(app: AppHandle) -> Result<CoreInfo, String> {
    // The health wait blocks, so it runs on a blocking worker thread, never the UI thread.
    tauri::async_runtime::spawn_blocking(move || core::info(&app.state::<CoreProcess>()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn show_main(app: AppHandle, route: Option<String>) {
    show_main_window(&app, route);
}

#[tauri::command]
fn toggle_mini(app: AppHandle) {
    toggle_mini_window(&app);
}

#[tauri::command]
fn hide_mini(app: AppHandle) {
    if let Some(w) = mini(&app) {
        let _ = w.hide();
    }
}

#[tauri::command]
fn set_mini_expanded(app: AppHandle, expanded: bool) {
    if let Some(w) = mini(&app) {
        let (wd, h) = if expanded { MINI_EXPANDED } else { MINI_COLLAPSED };
        let _ = w.set_size(tauri::LogicalSize::new(wd, h));
    }
}

#[tauri::command]
fn set_mini_always_on_top(app: AppHandle, on: bool) {
    if let Some(w) = mini(&app) {
        let _ = w.set_always_on_top(on);
    }
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .set_title("Approve a folder for NEXUS")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn set_launch_at_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let auto = app.autolaunch();
    if enabled { auto.enable() } else { auto.disable() }.map_err(|e| e.to_string())?;
    auto.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn launch_at_login_status(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

// -- setup ------------------------------------------------------------------------

fn register_shortcuts(app: &AppHandle) -> tauri::Result<()> {
    let toggle = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    let ptt = Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::Space);
    let gs = app.global_shortcut();
    let result = gs.on_shortcuts([toggle, ptt], move |app, shortcut, event| {
        if event.state() != ShortcutState::Pressed {
            return;
        }
        if shortcut == &toggle {
            toggle_mini_window(app);
        } else if shortcut == &ptt {
            // Show without stealing focus from the current app; the mini window starts/stops recording.
            show_mini(app, false);
            if let Some(w) = mini(app) {
                let _ = w.emit("nexus://ptt", ());
            }
        }
    });
    if let Err(e) = result {
        // Another app may own ⌥Space. NEXUS still works; report it in the log instead of failing to start.
        eprintln!("NEXUS: could not register global shortcuts: {e}");
    }
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open NEXUS", true, None::<&str>)?;
    let assistant = MenuItem::with_id(app, "mini", "Floating Assistant    ⌥Space", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "New Conversation", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Emergency Stop", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NEXUS", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        app,
        &[&open, &assistant, &chat, &PredefinedMenuItem::separator(app)?, &stop, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("nexus-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("NEXUS")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app, None),
            "mini" => show_mini(app, true),
            "chat" => show_main_window(app, Some("chat".into())),
            "stop" => {
                // The main webview owns the authenticated API client; it performs the stop.
                if let Some(w) = main_window(app) {
                    let _ = w.emit("nexus://emergency-stop", ());
                }
                show_main_window(app, None);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app, None)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(CoreProcess::default())
        .invoke_handler(tauri::generate_handler![
            core_info,
            show_main,
            toggle_mini,
            hide_mini,
            set_mini_expanded,
            set_mini_always_on_top,
            pick_folder,
            set_launch_at_login,
            launch_at_login_status
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<CoreProcess>();
            *state.launcher.lock().unwrap() = core::load_launcher(app.path().app_config_dir().ok());
            core::ensure_running(&state);
            register_shortcuts(&handle)?;
            build_tray(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing a window hides it; NEXUS keeps running in the menu bar. Quit from the tray or ⌘Q.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building NEXUS");

    app.run(|app, event| match event {
        RunEvent::Exit => core::stop(&app.state::<CoreProcess>()),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(app, None),
        _ => {}
    });
}
