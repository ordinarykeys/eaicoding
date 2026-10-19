use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize)]
pub struct WorkspaceEntry {
    name: String,
    path: String,
    directory: bool,
}
#[derive(Serialize)]
pub struct WorkspaceListing {
    root: String,
    directory: String,
    entries: Vec<WorkspaceEntry>,
    next_offset: Option<usize>,
}

fn directory_path(path: &str) -> Result<PathBuf, String> {
    let path = std::fs::canonicalize(path).map_err(|e| format!("无法打开工作区：{e}"))?;
    if !path.is_dir() {
        return Err("工作区必须是文件夹".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn default_workspace(app: AppHandle) -> Result<String, String> {
    let root = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("EAiCoding")
        .join("workspace");
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().into())
}

fn list_directory(
    root: &str,
    directory: Option<&str>,
    offset: usize,
) -> Result<WorkspaceListing, String> {
    let root = directory_path(root)?;
    let directory = directory_path(directory.unwrap_or(root.to_str().ok_or("工作区路径无效")?))?;
    if !directory.starts_with(&root) {
        return Err("此目录不在当前工作区内".into());
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        // Do not follow symlinks/junctions outside the workspace.
        let canonical = match entry.path().canonicalize() {
            Ok(p) if p.starts_with(&root) => p,
            _ => continue,
        };
        entries.push(WorkspaceEntry {
            name: entry.file_name().to_string_lossy().into(),
            path: canonical.to_string_lossy().into(),
            directory: kind.is_dir() || canonical.is_dir(),
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    let next_offset =
        (offset.saturating_add(200) < entries.len()).then_some(offset.saturating_add(200));
    Ok(WorkspaceListing {
        root: root.to_string_lossy().into(),
        directory: directory.to_string_lossy().into(),
        entries: entries.into_iter().skip(offset).take(200).collect(),
        next_offset,
    })
}

#[tauri::command]
pub async fn list_workspace_directory(
    root: String,
    directory: Option<String>,
    offset: Option<usize>,
) -> Result<WorkspaceListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_directory(&root, directory.as_deref(), offset.unwrap_or(0))
    })
    .await
    .map_err(|e| e.to_string())?
}

struct TerminalProcess {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}
impl Drop for TerminalProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}
#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Arc<Mutex<TerminalProcess>>>>);

#[derive(Clone, Serialize)]
struct TerminalOutput {
    id: String,
    data: Vec<u8>,
    exited: bool,
}

fn terminal_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(2, 300),
        cols: cols.clamp(10, 500),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    state: State<'_, Terminals>,
    id: String,
    root: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let root = directory_path(&root)?;
    let mut terminals = state.0.lock().map_err(|e| e.to_string())?;
    if terminals.contains_key(&id) {
        return Err("终端已存在".into());
    }
    if terminals.len() >= 6 {
        return Err("最多同时打开 6 个终端，请先关闭不用的标签".into());
    }
    let pair = native_pty_system()
        .openpty(terminal_size(cols, rows))
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let mut command = CommandBuilder::new("powershell.exe");
    #[cfg(not(windows))]
    let mut command =
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
    #[cfg(windows)]
    command.args(["-NoLogo", "-NoProfile"]);
    let shell_root = root.to_string_lossy();
    #[cfg(windows)]
    let shell_root = shell_root
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or_else(|| {
            shell_root
                .strip_prefix(r"\\?\")
                .unwrap_or(&shell_root)
                .to_string()
        });
    command.cwd(shell_root.as_ref() as &str);
    command.env("TERM", "xterm-256color");
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let process = Arc::new(Mutex::new(TerminalProcess {
        master: pair.master,
        writer,
        child,
    }));
    let process_identity = Arc::downgrade(&process);
    terminals.insert(id.clone(), process);
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if app
                        .emit_to(
                            "main",
                            "workspace-terminal-output",
                            TerminalOutput {
                                id: id.clone(),
                                data: buffer[..count].to_vec(),
                                exited: false,
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        if let Ok(mut terminals) = app.state::<Terminals>().0.lock() {
            if terminals.get(&id).is_some_and(|process| {
                std::sync::Weak::ptr_eq(&Arc::downgrade(process), &process_identity)
            }) {
                terminals.remove(&id);
            }
        }
        let _ = app.emit_to(
            "main",
            "workspace-terminal-output",
            TerminalOutput {
                id,
                data: vec![],
                exited: true,
            },
        );
    });
    Ok(())
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, Terminals>,
    id: String,
    data: String,
) -> Result<(), String> {
    let terminal = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or("终端已退出")?;
    let mut process = terminal.lock().map_err(|e| e.to_string())?;
    process
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| process.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminal = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or("终端已退出")?;
    let result = terminal
        .lock()
        .map_err(|e| e.to_string())?
        .master
        .resize(terminal_size(cols, rows))
        .map_err(|e| e.to_string());
    result
}

#[tauri::command]
pub async fn terminal_close(state: State<'_, Terminals>, id: String) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

fn browser_label(id: &str) -> Result<&str, String> {
    if !id.starts_with("browser-")
        || id.len() > 100
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("浏览器标识无效".into());
    }
    Ok(id)
}
fn browser_url(text: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(text).map_err(|_| "请输入完整的网址".to_string())?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅支持 http/https 网页".into());
    }
    Ok(url)
}
#[derive(Clone, Serialize)]
struct BrowserLocation {
    id: String,
    url: String,
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    browser_label(&id)?;
    let url = browser_url(&url)?;
    if let Some(view) = app.get_webview(&id) {
        return view.navigate(url).map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("主窗口不可用")?;
    let event_app = app.clone();
    let event_id = id.clone();
    let view = tauri::webview::WebviewBuilder::new(&id, tauri::WebviewUrl::External(url))
        .on_navigation(move |url| {
            let allowed = matches!(url.scheme(), "https" | "http");
            if allowed {
                let _ = event_app.emit_to(
                    "main",
                    "workspace-browser-location",
                    BrowserLocation {
                        id: event_id.clone(),
                        url: url.to_string(),
                    },
                );
            }
            allowed
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    window
        .add_child(
            view,
            tauri::LogicalPosition::new(x.max(0.0), y.max(0.0)),
            tauri::LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn browser_layout(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    browser_label(&id)?;
    if let Some(view) = app.get_webview(&id) {
        if !visible {
            return view.hide().map_err(|e| e.to_string());
        }
        view.set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(x.max(0.0), y.max(0.0)).into(),
            size: tauri::LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
        })
        .map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub async fn browser_action(app: AppHandle, id: String, action: String) -> Result<(), String> {
    browser_label(&id)?;
    let view = app.get_webview(&id).ok_or("请先打开网页")?;
    match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        _ => return Err("未知浏览器操作".into()),
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    browser_label(&id)?;
    if let Some(view) = app.get_webview(&id) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    #[test]
    fn browser_rejects_local_protocols_and_credentials() {
        for url in [
            "file:///C:/secret",
            "javascript:alert(1)",
            "https://user:pass@example.com",
            "not-a-url",
        ] {
            assert!(browser_url(url).is_err());
        }
        assert!(browser_url("http://localhost:1420/test").is_ok());
        assert!(browser_label("main").is_err());
    }
    #[test]
    fn workspace_pages_and_rejects_parent_directory() {
        let root = std::env::temp_dir().join(format!("eaicoding-workspace-{}", std::process::id()));
        std::fs::create_dir_all(root.join("folder")).unwrap();
        for i in 0..205 {
            std::fs::write(root.join(format!("file-{i:03}.txt")), "test").unwrap();
        }
        let first = list_directory(root.to_str().unwrap(), None, 0).unwrap();
        assert_eq!(first.entries.len(), 200);
        assert!(first.entries[0].directory);
        assert_eq!(first.next_offset, Some(200));
        let last = list_directory(root.to_str().unwrap(), None, 200).unwrap();
        assert_eq!(last.entries.len(), 6);
        assert_eq!(last.next_offset, None);
        assert!(list_directory(
            root.to_str().unwrap(),
            root.parent().and_then(Path::to_str),
            0
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
