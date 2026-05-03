use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream, UdpSocket},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileBridgeInfo {
    pub running: bool,
    pub url: Option<String>,
    pub local_url: Option<String>,
    pub lan_ip: Option<String>,
    pub port: Option<u16>,
    pub started_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileAction {
    pub id: String,
    #[serde(rename = "type")]
    pub action_type: String,
    pub content: Option<String>,
    pub session_id: Option<String>,
    pub prompt: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncomingMobileAction {
    #[serde(rename = "type")]
    action_type: String,
    content: Option<String>,
    session_id: Option<String>,
    prompt: Option<String>,
}

struct MobileBridgeInner {
    running: bool,
    url: Option<String>,
    local_url: Option<String>,
    lan_ip: Option<String>,
    port: Option<u16>,
    token: Option<String>,
    started_at: Option<u64>,
    shutdown: Option<Arc<AtomicBool>>,
    actions: VecDeque<MobileAction>,
    latest_snapshot: serde_json::Value,
}

#[derive(Clone)]
pub struct MobileBridgeState {
    inner: Arc<Mutex<MobileBridgeInner>>,
}

impl Default for MobileBridgeState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(MobileBridgeInner {
                running: false,
                url: None,
                local_url: None,
                lan_ip: None,
                port: None,
                token: None,
                started_at: None,
                shutdown: None,
                actions: VecDeque::new(),
                latest_snapshot: json!({
                    "sessions": [],
                    "messages": [],
                    "statusLine": null,
                    "isStreaming": false
                }),
            })),
        }
    }
}

#[tauri::command]
pub fn start_mobile_bridge(
    state: State<'_, MobileBridgeState>,
) -> Result<MobileBridgeInfo, String> {
    {
        let inner = state.inner.lock().map_err(|_| "手机桥状态锁定失败".to_string())?;
        if inner.running {
            return Ok(info_from_inner(&inner));
        }
    }

    let listener = TcpListener::bind("0.0.0.0:0")
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .map_err(|err| format!("启动手机桥失败：{err}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("设置手机桥非阻塞监听失败：{err}"))?;

    let port = listener
        .local_addr()
        .map_err(|err| format!("读取手机桥端口失败：{err}"))?
        .port();
    let lan_ip = detect_lan_ip();
    let token = make_token();
    let url = format!("http://{}:{}/mobile?token={}", lan_ip, port, token);
    let local_url = format!("http://127.0.0.1:{}/mobile?token={}", port, token);
    let started_at = now_ms();
    let shutdown = Arc::new(AtomicBool::new(false));

    {
        let mut inner = state.inner.lock().map_err(|_| "手机桥状态锁定失败".to_string())?;
        inner.running = true;
        inner.url = Some(url);
        inner.local_url = Some(local_url);
        inner.lan_ip = Some(lan_ip);
        inner.port = Some(port);
        inner.token = Some(token);
        inner.started_at = Some(started_at);
        inner.shutdown = Some(shutdown.clone());
        inner.actions.clear();
    }

    let shared_state = state.inner.clone();
    thread::spawn(move || run_mobile_server(listener, shared_state, shutdown));

    let inner = state.inner.lock().map_err(|_| "手机桥状态锁定失败".to_string())?;
    Ok(info_from_inner(&inner))
}

#[tauri::command]
pub fn stop_mobile_bridge(state: State<'_, MobileBridgeState>) -> Result<MobileBridgeInfo, String> {
    let mut inner = state.inner.lock().map_err(|_| "手机桥状态锁定失败".to_string())?;
    if let Some(shutdown) = &inner.shutdown {
        shutdown.store(true, Ordering::SeqCst);
    }
    inner.running = false;
    inner.url = None;
    inner.local_url = None;
    inner.lan_ip = None;
    inner.port = None;
    inner.token = None;
    inner.started_at = None;
    inner.shutdown = None;
    inner.actions.clear();
    Ok(info_from_inner(&inner))
}

#[tauri::command]
pub fn get_mobile_bridge_state(
    state: State<'_, MobileBridgeState>,
) -> Result<MobileBridgeInfo, String> {
    let inner = state.inner.lock().map_err(|_| "手机桥状态锁定失败".to_string())?;
    Ok(info_from_inner(&inner))
}

#[tauri::command]
pub fn poll_mobile_actions(
    state: State<'_, MobileBridgeState>,
) -> Result<Vec<MobileAction>, String> {
    let mut inner = state.inner.lock().map_err(|_| "手机桥状态锁定失败".to_string())?;
    let mut actions = Vec::with_capacity(inner.actions.len());
    while let Some(action) = inner.actions.pop_front() {
        actions.push(action);
    }
    Ok(actions)
}

#[tauri::command]
pub fn publish_mobile_snapshot(
    state: State<'_, MobileBridgeState>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|_| "手机桥状态锁定失败".to_string())?;
    inner.latest_snapshot = snapshot;
    Ok(())
}

fn info_from_inner(inner: &MobileBridgeInner) -> MobileBridgeInfo {
    MobileBridgeInfo {
        running: inner.running,
        url: inner.url.clone(),
        local_url: inner.local_url.clone(),
        lan_ip: inner.lan_ip.clone(),
        port: inner.port,
        started_at: inner.started_at,
    }
}

fn run_mobile_server(
    listener: TcpListener,
    shared_state: Arc<Mutex<MobileBridgeInner>>,
    shutdown: Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let state = shared_state.clone();
                thread::spawn(move || {
                    let _ = handle_connection(stream, state);
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }

    if let Ok(mut inner) = shared_state.lock() {
        if let Some(flag) = &inner.shutdown {
            if Arc::ptr_eq(flag, &shutdown) {
                inner.running = false;
                inner.url = None;
                inner.local_url = None;
                inner.lan_ip = None;
                inner.port = None;
                inner.token = None;
                inner.started_at = None;
                inner.shutdown = None;
                inner.actions.clear();
            }
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    shared_state: Arc<Mutex<MobileBridgeInner>>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;

    let request = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(_) => {
            write_response(
                &mut stream,
                400,
                "Bad Request",
                "text/plain; charset=utf-8",
                b"Bad Request",
            )?;
            return Ok(());
        }
    };

    if request.method == "OPTIONS" {
        write_response(
            &mut stream,
            204,
            "No Content",
            "text/plain; charset=utf-8",
            b"",
        )?;
        return Ok(());
    }

    match request.path.as_str() {
        "/" | "/mobile" => {
            if !is_valid_token(&shared_state, request.query_token.as_deref()) {
                write_response(
                    &mut stream,
                    403,
                    "Forbidden",
                    "text/html; charset=utf-8",
                    forbidden_html().as_bytes(),
                )?;
                return Ok(());
            }
            write_response(
                &mut stream,
                200,
                "OK",
                "text/html; charset=utf-8",
                mobile_html().as_bytes(),
            )?;
        }
        "/api/state" => {
            if !is_valid_token(&shared_state, request.query_token.as_deref()) {
                write_json(
                    &mut stream,
                    403,
                    "Forbidden",
                    &json!({ "ok": false, "error": "invalid token" }),
                )?;
                return Ok(());
            }
            let snapshot = shared_state
                .lock()
                .map(|inner| inner.latest_snapshot.clone())
                .unwrap_or_else(|_| json!({}));
            write_json(
                &mut stream,
                200,
                "OK",
                &json!({
                    "ok": true,
                    "serverTime": now_ms(),
                    "snapshot": snapshot
                }),
            )?;
        }
        "/api/actions" => {
            if request.method != "POST" {
                write_json(
                    &mut stream,
                    405,
                    "Method Not Allowed",
                    &json!({ "ok": false, "error": "method not allowed" }),
                )?;
                return Ok(());
            }
            if !is_valid_token(&shared_state, request.query_token.as_deref()) {
                write_json(
                    &mut stream,
                    403,
                    "Forbidden",
                    &json!({ "ok": false, "error": "invalid token" }),
                )?;
                return Ok(());
            }

            let incoming: IncomingMobileAction = match serde_json::from_slice(&request.body) {
                Ok(value) => value,
                Err(err) => {
                    write_json(
                        &mut stream,
                        400,
                        "Bad Request",
                        &json!({ "ok": false, "error": format!("invalid json: {err}") }),
                    )?;
                    return Ok(());
                }
            };

            let action_type = incoming.action_type.trim().to_string();
            if action_type.is_empty() {
                write_json(
                    &mut stream,
                    400,
                    "Bad Request",
                    &json!({ "ok": false, "error": "missing action type" }),
                )?;
                return Ok(());
            }

            let action = MobileAction {
                id: format!("ma_{}", make_short_token()),
                action_type,
                content: incoming.content,
                session_id: incoming.session_id,
                prompt: incoming.prompt,
                created_at: now_ms(),
            };
            let action_id = action.id.clone();

            if let Ok(mut inner) = shared_state.lock() {
                if inner.actions.len() > 100 {
                    inner.actions.pop_front();
                }
                inner.actions.push_back(action);
            }

            write_json(
                &mut stream,
                200,
                "OK",
                &json!({ "ok": true, "id": action_id }),
            )?;
        }
        _ => {
            write_response(
                &mut stream,
                404,
                "Not Found",
                "text/plain; charset=utf-8",
                b"Not Found",
            )?;
        }
    }

    Ok(())
}

struct HttpRequest {
    method: String,
    path: String,
    query_token: Option<String>,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
    let mut data = Vec::new();
    let mut buf = [0_u8; 4096];
    let mut header_end = None;
    let mut content_length = 0_usize;

    loop {
        let read = stream.read(&mut buf)?;
        if read == 0 {
            break;
        }
        data.extend_from_slice(&buf[..read]);

        if header_end.is_none() {
            if let Some(pos) = find_bytes(&data, b"\r\n\r\n") {
                header_end = Some(pos + 4);
                let headers = String::from_utf8_lossy(&data[..pos]);
                content_length = parse_content_length(&headers);
            }
        }

        if let Some(end) = header_end {
            if data.len() >= end + content_length {
                break;
            }
        }

        if data.len() > 1024 * 1024 {
            break;
        }
    }

    let header_end = header_end.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "missing http headers")
    })?;
    let header_text = String::from_utf8_lossy(&data[..header_end]);
    let mut lines = header_text.lines();
    let first_line = lines.next().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "missing request line")
    })?;
    let mut first_parts = first_line.split_whitespace();
    let method = first_parts.next().unwrap_or("").to_uppercase();
    let target = first_parts.next().unwrap_or("/");
    let (path, query) = split_target(target);
    let query_token = parse_query_token(query);
    let body_end = (header_end + content_length).min(data.len());
    let body = data[header_end..body_end].to_vec();

    Ok(HttpRequest {
        method,
        path,
        query_token,
        body,
    })
}

fn parse_content_length(headers: &str) -> usize {
    headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn split_target(target: &str) -> (String, Option<&str>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    (
        if path.is_empty() { "/".to_string() } else { path.to_string() },
        if query.is_empty() { None } else { Some(query) },
    )
}

fn parse_query_token(query: Option<&str>) -> Option<String> {
    let query = query?;
    for part in query.split('&') {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        if key == "token" {
            return Some(percent_decode(value));
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn is_valid_token(
    shared_state: &Arc<Mutex<MobileBridgeInner>>,
    token: Option<&str>,
) -> bool {
    let Some(token) = token else {
        return false;
    };
    shared_state
        .lock()
        .map(|inner| inner.running && inner.token.as_deref() == Some(token))
        .unwrap_or(false)
}

fn write_json(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    value: &serde_json::Value,
) -> std::io::Result<()> {
    write_response(
        stream,
        code,
        reason,
        "application/json; charset=utf-8",
        value.to_string().as_bytes(),
    )
}

fn write_response(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let headers = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\n\r\n",
        code,
        reason,
        content_type,
        body.len()
    );
    stream.write_all(headers.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn detect_lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn make_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn make_short_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(12)
        .map(char::from)
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn forbidden_html() -> String {
    r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EAiCoding 手机模式</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#111827}.box{max-width:320px;padding:22px;border-radius:18px;background:#fff;box-shadow:0 18px 60px rgba(15,23,42,.12)}h1{font-size:18px;margin:0 0 8px}p{font-size:13px;line-height:1.6;color:#64748b;margin:0}</style></head><body><div class="box"><h1>无法连接手机模式</h1><p>二维码已过期或手机模式已关闭，请回到桌面端重新打开手机图标扫码。</p></div></body></html>"#.to_string()
}

fn mobile_html() -> String {
    if cfg!(debug_assertions) {
        if let Some(html) = read_mobile_resource("mobile.html") {
            return html;
        }
    }

    include_str!("../resources/mobile.html").to_string()
}

fn read_mobile_resource(name: &str) -> Option<String> {
    let mut candidates = Vec::new();

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        candidates.push(PathBuf::from(manifest_dir).join("resources").join(name));
    }

    candidates.push(PathBuf::from("resources").join(name));
    candidates.push(PathBuf::from("src-tauri").join("resources").join(name));

    candidates.into_iter().find_map(|path| fs::read_to_string(path).ok())
}

