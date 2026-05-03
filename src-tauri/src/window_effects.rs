pub fn setup_window_effects(app: &mut tauri::App) {
    window_shadows_v2::set_shadows(app, true);
    remove_window_border(app);
}

#[cfg(target_os = "windows")]
fn remove_window_border(app: &tauri::App) {
    use tauri::Manager;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
    };

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    let border_color = DWMWA_COLOR_NONE;
    unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_BORDER_COLOR as u32,
            &border_color as *const _ as *const core::ffi::c_void,
            core::mem::size_of_val(&border_color) as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn remove_window_border(_app: &tauri::App) {}
