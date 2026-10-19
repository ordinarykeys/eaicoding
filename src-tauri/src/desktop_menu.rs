//! Harness Windows caption menus, adapted to Tauri's native menu backend.
use tauri::{
    menu::{ContextMenu, Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow,
};

pub struct CaptionMenus {
    application: Menu<tauri::Wry>,
    edit: Menu<tauri::Wry>,
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let application = Menu::new(app)?;
    for (id, label) in [("about", "关于 EAiCoding"), ("updates", "检查更新…")] {
        application.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
        if id == "about" {
            application.append(&PredefinedMenuItem::separator(app)?)?;
        }
    }
    application.append(&PredefinedMenuItem::separator(app)?)?;
    application.append(&MenuItem::with_id(
        app,
        "exit",
        "退出 EAiCoding",
        true,
        None::<&str>,
    )?)?;

    let edit = Menu::new(app)?;
    for (id, label) in [
        ("edit-undo", "撤销\tCtrl+Z"),
        ("edit-redo", "重做\tCtrl+Y"),
        ("edit-cut", "剪切\tCtrl+X"),
        ("edit-copy", "复制\tCtrl+C"),
        ("edit-paste", "粘贴\tCtrl+V"),
        ("edit-delete", "删除"),
        ("edit-select-all", "全选\tCtrl+A"),
    ] {
        if id == "edit-cut" || id == "edit-select-all" {
            edit.append(&PredefinedMenuItem::separator(app)?)?;
        }
        // Display accelerators without registering a second global handler.
        edit.append(&MenuItem::with_id(app, id, label, true, None::<&str>)?)?;
    }
    app.manage(CaptionMenus { application, edit });
    app.on_menu_event(|app, event| {
        let id = event.id.as_ref();
        if id.starts_with("edit-") {
            send_editing_key(app, id);
        } else if matches!(id, "about" | "updates" | "exit") {
            let _ = app.emit_to("main", "caption-menu-action", id);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn show_caption_menu(
    window: WebviewWindow,
    name: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if window.label() != "main"
        || !x.is_finite()
        || !y.is_finite()
        || !(0.0..=100_000.0).contains(&x)
        || !(0.0..=100_000.0).contains(&y)
    {
        return Err("无效菜单位置".into());
    }
    let menus = window.state::<CaptionMenus>();
    let menu = match name.as_str() {
        "application" => &menus.application,
        "edit" => &menus.edit,
        _ => return Err("未知菜单".into()),
    };
    menu.popup_at(window.as_ref().window().clone(), LogicalPosition::new(x, y))
        .map_err(|e| format!("无法打开菜单：{e}"))
}

#[tauri::command]
pub fn exit_application(app: AppHandle) {
    app.exit(0);
}

#[cfg(windows)]
fn send_editing_key(app: &AppHandle, id: &str) {
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP, VK_CONTROL},
        WindowsAndMessaging::GetForegroundWindow,
    };
    let (key, control) = match id {
        "edit-undo" => (0x5A, true),
        "edit-redo" => (0x59, true),
        "edit-cut" => (0x58, true),
        "edit-copy" => (0x43, true),
        "edit-paste" => (0x56, true),
        "edit-delete" => (0x2E, false),
        "edit-select-all" => (0x41, true),
        _ => return,
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        // Never send simulated input to a different application.
        if GetForegroundWindow() != hwnd.0 as _ {
            return;
        }
        let mut inputs: Vec<INPUT> = Vec::new();
        let mut key_event = |key, flags| {
            let mut input: INPUT = std::mem::zeroed();
            input.r#type = INPUT_KEYBOARD;
            input.Anonymous.ki.wVk = key;
            input.Anonymous.ki.dwFlags = flags;
            inputs.push(input);
        };
        if control {
            key_event(VK_CONTROL, 0);
        }
        key_event(key, 0);
        key_event(key, KEYEVENTF_KEYUP);
        if control {
            key_event(VK_CONTROL, KEYEVENTF_KEYUP);
        }
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
}

#[cfg(not(windows))]
fn send_editing_key(_app: &AppHandle, _id: &str) {}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    version: String,
    url: String,
}

#[tauri::command]
pub async fn check_application_update() -> Result<ReleaseInfo, String> {
    let value: serde_json::Value = reqwest::Client::new()
        .get("https://api.github.com/repos/ordinarykeys/eaicoding/releases/latest")
        .header("user-agent", "EAiCoding")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "无法连接更新服务，请稍后重试。")?
        .error_for_status()
        .map_err(|_| "暂时无法获取已发布版本，请稍后重试。")?
        .json()
        .await
        .map_err(|_| "更新服务返回格式无效。")?;
    let version = value["tag_name"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("更新服务缺少版本号。")?
        .to_owned();
    let url = format!(
        "https://github.com/ordinarykeys/eaicoding/releases/tag/{}",
        version
    );
    Ok(ReleaseInfo { version, url })
}
