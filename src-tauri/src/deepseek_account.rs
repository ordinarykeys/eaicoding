//! Platform PKCE flow adapted from DeepSeek Harness (MIT); see THIRD_PARTY_NOTICES.md.
//! Grants stay in the native process and are never serialized into renderer state.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use reqwest::{header::HeaderMap, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Mutex},
};

const PLATFORM: &str = "https://platform.deepseek.com";
const STORAGE_ERROR: &str = "无法读取或保存登录凭据，请检查应用数据目录的权限。";
pub static ACCOUNT_HTTP: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("account HTTP client")
});

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub signed_in: bool,
    pub name: Option<String>,
    pub contact: Option<String>,
    pub phase: String,
    pub error: Option<String>,
    pub attempt_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Wallet {
    currency: String,
    balance: String,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDetails {
    name: Option<String>,
    contact: Option<String>,
    profile_available: bool,
    wallets: Option<Vec<Wallet>>,
    bonus_wallets: Option<Vec<Wallet>>,
}
#[derive(Debug, PartialEq)]
enum DetailError {
    Expired,
    Unavailable,
}
#[derive(Serialize, Deserialize)]
struct StoredGrant {
    encrypted_token: String,
    name: Option<String>,
    contact: Option<String>,
}
struct Grant {
    token: String,
    name: Option<String>,
    contact: Option<String>,
}
struct Attempt {
    id: String,
    cancel: watch::Sender<bool>,
    url: Option<String>,
}
#[derive(Default)]
struct Inner {
    loaded: bool,
    grant: Option<Grant>,
    attempt: Option<Attempt>,
    view: AccountView,
}
#[derive(Clone, Default)]
pub struct AccountState(Arc<Mutex<Inner>>);

fn random_secret() -> String {
    let mut bytes = [0; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| STORAGE_ERROR.into())
}
async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    tokio::fs::create_dir_all(path.parent().ok_or(STORAGE_ERROR)?)
        .await
        .map_err(|_| STORAGE_ERROR)?;
    let temporary = path.with_extension(format!("{}.tmp", random_secret()));
    let result = async {
        let mut file = tokio::fs::File::create(&temporary)
            .await
            .map_err(|_| STORAGE_ERROR)?;
        file.write_all(bytes).await.map_err(|_| STORAGE_ERROR)?;
        file.sync_all().await.map_err(|_| STORAGE_ERROR)?;
        drop(file);
        tokio::fs::rename(&temporary, path)
            .await
            .map_err(|_| STORAGE_ERROR)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(temporary).await;
    }
    result.map_err(str::to_string)
}
impl Inner {
    fn snapshot(&self) -> AccountView {
        AccountView {
            signed_in: self.grant.is_some(),
            name: self.grant.as_ref().and_then(|g| g.name.clone()),
            contact: self.grant.as_ref().and_then(|g| g.contact.clone()),
            ..self.view.clone()
        }
    }
    async fn load(&mut self, dir: &Path) -> Result<(), String> {
        if self.loaded {
            return Ok(());
        }
        match tokio::fs::read(dir.join("deepseek-account-v1.json")).await {
            Ok(bytes) => {
                let stored: StoredGrant =
                    serde_json::from_slice(&bytes).map_err(|_| STORAGE_ERROR)?;
                let token = crate::crypto::decrypt_secret(stored.encrypted_token)
                    .map_err(|_| STORAGE_ERROR)?;
                if !valid_token(&token) {
                    return Err(STORAGE_ERROR.into());
                }
                self.grant = Some(Grant {
                    token,
                    name: stored.name,
                    contact: stored.contact,
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(STORAGE_ERROR.into()),
        }
        self.loaded = true;
        Ok(())
    }
    fn current(&self, id: &str) -> bool {
        self.attempt
            .as_ref()
            .is_some_and(|a| a.id == id && !*a.cancel.borrow())
    }
}
fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 16384 && token.bytes().all(|b| (0x21..=0x7e).contains(&b))
}
fn browser_url(value: &str, origin: &str, path: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "官方授权地址无效")?;
    if url.origin().ascii_serialization() != origin
        || url.path() != path
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("官方授权地址校验失败".into());
    }
    Ok(url)
}
fn client_headers(timezone: i32) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (k, v) in [
        ("x-client-bundle-id", "com.eaicoding.desktop"),
        ("x-client-platform", "desktop-win"),
        ("x-client-version", env!("CARGO_PKG_VERSION")),
        ("x-client-locale", "zh_CN"),
    ] {
        headers.insert(k, v.parse().unwrap());
    }
    headers.insert(
        "x-client-timezone-offset",
        timezone.clamp(-50400, 50400).to_string().parse().unwrap(),
    );
    headers
}
async fn platform_request(
    origin: &str,
    method: &str,
    body: Value,
    timezone: i32,
) -> Result<Value, String> {
    let response = ACCOUNT_HTTP
        .post(format!("{origin}/auth-api/v0/dsh/{method}"))
        .headers(client_headers(timezone))
        .json(&body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "无法连接 DeepSeek 官方授权服务，请检查网络后重试。")?;
    read_platform(response).await
}
async fn read_platform(mut response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(format!(
            "DeepSeek 授权服务返回 HTTP {}，请重试。",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取授权响应失败")? {
        if bytes.len() + chunk.len() > 262144 {
            return Err("授权响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "授权服务响应格式不正确")?;
    if data["code"].as_i64() != Some(0) || data["data"]["biz_code"].as_i64() != Some(0) {
        return Err("DeepSeek 未接受本次授权，请重新登录。".into());
    }
    Ok(data["data"]["biz_data"].clone())
}
fn text_field(value: &Value, key: &str) -> Result<String, String> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 16384)
        .map(str::to_string)
        .ok_or("授权服务响应缺少必要字段".into())
}

fn account_identity(value: &Value) -> (Option<String>, Option<String>) {
    let nonempty = |v: &Value, limit| {
        v.as_str()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.chars().take(limit).collect::<String>())
    };
    (
        nonempty(&value["id_profile"]["name"], 120).or_else(|| nonempty(&value["name"], 120)),
        nonempty(&value["mobile"], 160)
            .or_else(|| nonempty(&value["mobile_number"], 160))
            .or_else(|| nonempty(&value["email"], 160)),
    )
}
fn detail_payload(value: Value) -> Result<Value, DetailError> {
    if value["code"].as_i64() == Some(40003) || value["data"]["biz_code"].as_i64() == Some(40003) {
        return Err(DetailError::Expired);
    }
    if value["code"].as_i64() != Some(0) || value["data"]["biz_code"].as_i64() != Some(0) {
        return Err(DetailError::Unavailable);
    }
    Ok(value["data"]["biz_data"].clone())
}
async fn account_read(
    origin: &str,
    path: &str,
    token: &str,
    timezone: i32,
) -> Result<Value, DetailError> {
    let mut response = ACCOUNT_HTTP
        .get(format!("{origin}{path}"))
        .headers(
            grant_headers(client_headers(timezone), token).map_err(|_| DetailError::Unavailable)?,
        )
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| DetailError::Unavailable)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(DetailError::Expired);
    }
    if !response.status().is_success() {
        return Err(DetailError::Unavailable);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| DetailError::Unavailable)?
    {
        if bytes.len() + chunk.len() > 262144 {
            return Err(DetailError::Unavailable);
        }
        bytes.extend_from_slice(&chunk);
    }
    detail_payload(serde_json::from_slice(&bytes).map_err(|_| DetailError::Unavailable)?)
}
fn wallets(value: &Value) -> Option<Vec<Wallet>> {
    let entries: Vec<Wallet> = serde_json::from_value(value.clone()).ok()?;
    if entries.len() > 32
        || entries.iter().any(|wallet| {
            !matches!(wallet.currency.as_str(), "CNY" | "USD")
                || wallet.balance.len() > 128
                || !wallet
                    .balance
                    .bytes()
                    .all(|c| c.is_ascii_digit() || b".-+eE".contains(&c))
                || !wallet.balance.parse::<f64>().is_ok_and(f64::is_finite)
        })
    {
        return None;
    }
    Some(entries)
}
async fn read_account_details(
    origin: &str,
    token: &str,
    timezone: i32,
) -> Result<AccountDetails, DetailError> {
    let (profile, balance) = tokio::join!(
        account_read(origin, "/auth-api/v0/users/current", token, timezone),
        account_read(origin, "/api/v0/users/get_user_summary", token, timezone)
    );
    if matches!(profile, Err(DetailError::Expired)) || matches!(balance, Err(DetailError::Expired))
    {
        return Err(DetailError::Expired);
    }
    let mut details = AccountDetails::default();
    if let Ok(profile) = profile {
        if profile["email"].is_string()
            || profile["mobile"].is_string()
            || profile["mobile_number"].is_string()
        {
            (details.name, details.contact) = account_identity(&profile);
            details.profile_available = true;
        }
    }
    if let Ok(balance) = balance {
        if let (Some(normal), Some(bonus)) = (
            wallets(&balance["normal_wallets"]),
            wallets(&balance["bonus_wallets"]),
        ) {
            details.wallets = Some(normal);
            details.bonus_wallets = Some(bonus);
        }
    }
    Ok(details)
}

#[tauri::command]
pub async fn deepseek_account_details(
    app: AppHandle,
    timezone_offset_seconds: Option<i32>,
) -> Result<AccountDetails, String> {
    let state = app.state::<AccountState>();
    let token = {
        let mut inner = state.0.lock().await;
        inner.load(&data_dir(&app)?).await?;
        inner
            .grant
            .as_ref()
            .ok_or("请先登录 DeepSeek")?
            .token
            .clone()
    };
    let details =
        match read_account_details(PLATFORM, &token, timezone_offset_seconds.unwrap_or(0)).await {
            Ok(details) => details,
            Err(DetailError::Expired) => {
                expire(&app, &token).await;
                return Err("DeepSeek 登录已失效，请重新登录。".into());
            }
            Err(DetailError::Unavailable) => return Err("账号资料暂不可用，请重试。".into()),
        };
    let mut inner = state.0.lock().await;
    let grant = inner
        .grant
        .as_mut()
        .filter(|grant| grant.token == token)
        .ok_or("账号已切换")?;
    if details.profile_available {
        grant.name = details.name.clone();
        grant.contact = details.contact.clone();
    }
    drop(inner);
    publish(&app);
    Ok(details)
}
async fn device_id(dir: &Path) -> Result<String, String> {
    let path = dir.join("deepseek-device-v1.json");
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let id: String = serde_json::from_slice(&bytes).map_err(|_| STORAGE_ERROR)?;
            if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                return Err(STORAGE_ERROR.into());
            }
            Ok(id)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let mut bytes = [0u8; 16];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            bytes[6] = (bytes[6] & 15) | 64;
            bytes[8] = (bytes[8] & 63) | 128;
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let id = format!(
                "{}-{}-{}-{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..]
            );
            atomic_write(&path, &serde_json::to_vec(&id).unwrap()).await?;
            Ok(id)
        }
        Err(_) => Err(STORAGE_ERROR.into()),
    }
}
// Compare fixed-length random state without an early-exit byte comparison.
fn valid_state(received: &str, expected: &str) -> bool {
    received.len() == expected.len()
        && received
            .bytes()
            .zip(expected.bytes())
            .fold(0, |acc, (a, b)| acc | (a ^ b))
            == 0
}
fn callback_code(request: &str, expected: &str, port: u16) -> Result<String, ()> {
    let mut line = request.lines().next().ok_or(())?.split_whitespace();
    if line.next() != Some("GET") {
        return Err(());
    }
    let target = line.next().ok_or(())?;
    if !target.starts_with('/')
        || target.starts_with("//")
        || line.next() != Some("HTTP/1.1")
        || line.next().is_some()
    {
        return Err(());
    }
    let url = Url::parse(&format!("http://127.0.0.1:{port}{target}")).map_err(|_| ())?;
    if url.path() != "/oauth/callback" || url.fragment().is_some() {
        return Err(());
    }
    let states: Vec<_> = url
        .query_pairs()
        .filter(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .collect();
    let codes: Vec<_> = url
        .query_pairs()
        .filter(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .collect();
    if states.len() != 1
        || codes.len() != 1
        || !valid_state(&states[0], expected)
        || codes[0].is_empty()
        || codes[0].len() > 4096
    {
        return Err(());
    }
    Ok(codes[0].clone())
}
async fn read_callback(stream: &mut TcpStream, expected: &str, port: u16) -> Result<String, ()> {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 1024];
        let n = stream.read(&mut chunk).await.map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() > 8192 {
            return Err(());
        }
        if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    callback_code(std::str::from_utf8(&bytes).map_err(|_| ())?, expected, port)
}
async fn reply(stream: &mut TcpStream, status: &str, extra: &str, body: &str) {
    let message = format!("HTTP/1.1 {status}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n{body}", body.len());
    let _ =
        tokio::time::timeout(Duration::from_secs(2), stream.write_all(message.as_bytes())).await;
}
fn publish(app: &AppHandle) {
    let _ = app.emit("deepseek-account-changed", ());
}
async fn phase(state: &AccountState, id: &str, value: &str) -> Result<(), String> {
    let mut inner = state.0.lock().await;
    if !inner.current(id) {
        return Err("登录已取消".into());
    }
    inner.view.phase = value.into();
    Ok(())
}
struct LoginContext {
    state: AccountState,
    dir: PathBuf,
    origin: String,
    timezone: i32,
}
async fn authorize(
    context: &LoginContext,
    id: &str,
    authorize_id: &mut Option<String>,
    verifier: &str,
    open: impl Fn(&str) -> Result<(), String>,
) -> Result<(TcpStream, Value, tokio::time::Instant), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| "无法创建本机登录回调，请检查防火墙设置。")?;
    let port = listener
        .local_addr()
        .map_err(|_| "无法读取回调端口")?
        .port();
    let redirect = format!("http://127.0.0.1:{port}/oauth/callback");
    let nonce = random_secret();
    let start = tokio::time::Instant::now();
    let initialized = platform_request(&context.origin, "auth_init", json!({"code_challenge": challenge(verifier),
        "code_challenge_method":"S256", "state":nonce, "redirect_uri":redirect, "locale":"zh_CN", "login_source":"desktop"}), context.timezone).await?;
    *authorize_id = Some(text_field(&initialized, "authorize_id")?);
    let url = browser_url(
        &text_field(&initialized, "authorize_url")?,
        &context.origin,
        "/dsh/authorize",
    )?;
    let ttl = initialized["expires_in"]
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or("授权有效期不正确")?
        .min(600.0);
    let deadline = (tokio::time::Instant::now() + Duration::from_secs_f64(ttl))
        .min(start + Duration::from_secs(600));
    {
        let mut inner = context.state.0.lock().await;
        if !inner.current(id) {
            return Err("登录已取消".into());
        }
        inner.attempt.as_mut().unwrap().url = Some(url.to_string());
        inner.view.phase = "waiting-browser".into();
    }
    // Keep the attempt alive when the OS browser fails; the UI can reopen/copy the validated URL.
    let _ = open(url.as_str());
    let (browser, code) = loop {
        let (mut stream, _) = tokio::time::timeout_at(deadline, listener.accept())
            .await
            .map_err(|_| "登录链接已过期，请重新登录。")?
            .map_err(|_| "本机登录回调失败")?;
        let code = tokio::time::timeout(
            Duration::from_secs(3),
            read_callback(&mut stream, &nonce, port),
        )
        .await;
        if let Ok(Ok(code)) = code {
            break (stream, code);
        }
        reply(
            &mut stream,
            "400 Bad Request",
            "",
            "无效的登录回调，请返回官方授权页面。",
        )
        .await;
    };
    drop(listener);
    phase(&context.state, id, "exchanging").await?;
    let identity = device_id(&context.dir).await?;
    let exchange = tokio::time::timeout_at(deadline, platform_request(&context.origin,"auth_exchange",json!({
        "code":code, "code_verifier":verifier, "redirect_uri":redirect, "device_id":identity,
        "device_model":"win32-x64", "os_version":os_version().await,
    }),context.timezone)).await.map_err(|_| "登录链接已过期，请重新登录。")?;
    Ok((browser, exchange?, deadline))
}
// Commit runs outside cancellable network futures: cancellation cannot leave a
// completed disk write behind after dropping its future, or resurrect a grant.
async fn commit_authorization(
    context: &LoginContext,
    id: &str,
    mut browser: TcpStream,
    exchanged: Value,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    let result = async {
        let token = text_field(&exchanged, "token")?;
        if !valid_token(&token) {
            return Err("授权凭据格式不正确".into());
        }
        let mut completion = browser_url(
            &text_field(&exchanged, "authorized_url")?,
            &context.origin,
            "/dsh/authorized",
        )?;
        completion
            .query_pairs_mut()
            .append_pair("login_source", "desktop");
        let (name, contact) = account_identity(&exchanged["user"]);
        let stored = StoredGrant {
            encrypted_token: crate::crypto::encrypt_secret(token.clone())
                .map_err(|_| STORAGE_ERROR)?,
            name: name.clone(),
            contact: contact.clone(),
        };
        let mut inner = context.state.0.lock().await;
        if !inner.current(id) || tokio::time::Instant::now() >= deadline {
            return Err("登录已取消或过期".into());
        }
        // This short storage transaction is serialized with cancellation/logout.
        atomic_write(
            &context.dir.join("deepseek-account-v1.json"),
            &serde_json::to_vec(&stored).map_err(|_| STORAGE_ERROR)?,
        )
        .await?;
        inner.grant = Some(Grant {
            token,
            name,
            contact,
        });
        inner.view = AccountView {
            phase: "signed-in".into(),
            ..Default::default()
        };
        Ok::<_, String>(completion)
    }
    .await;
    match result {
        Ok(url) => {
            reply(
                &mut browser,
                "302 Found",
                &format!("Location: {url}\r\n"),
                "登录完成，可以返回 EAiCoding。",
            )
            .await;
            Ok(())
        }
        Err(error) => {
            reply(
                &mut browser,
                "400 Bad Request",
                "",
                "登录未完成，请返回 EAiCoding 重试。",
            )
            .await;
            Err(error)
        }
    }
}
async fn os_version() -> String {
    #[cfg(windows)]
    {
        let mut command = tokio::process::Command::new("cmd.exe");
        command
            .args(["/D", "/C", "ver"])
            .creation_flags(0x08000000)
            .kill_on_drop(true);
        if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(2), command.output()).await
        {
            return String::from_utf8_lossy(&output.stdout)
                .trim()
                .chars()
                .take(120)
                .collect();
        }
    }
    std::env::consts::OS.into()
}

#[tauri::command]
pub async fn deepseek_account_status(app: AppHandle) -> Result<AccountView, String> {
    let state = app.state::<AccountState>();
    let mut inner = state.0.lock().await;
    inner.load(&data_dir(&app)?).await?;
    Ok(inner.snapshot())
}
#[tauri::command]
pub async fn deepseek_account_start(
    app: AppHandle,
    timezone_offset_seconds: Option<i32>,
) -> Result<AccountView, String> {
    let state = app.state::<AccountState>().inner().clone();
    let dir = data_dir(&app)?;
    let mut inner = state.0.lock().await;
    inner.load(&dir).await?;
    if inner.grant.is_some() || inner.attempt.is_some() {
        return Ok(inner.snapshot());
    }
    let id = random_secret();
    let (cancel, mut cancelled) = watch::channel(false);
    inner.attempt = Some(Attempt {
        id: id.clone(),
        cancel,
        url: None,
    });
    inner.view = AccountView {
        phase: "initializing".into(),
        attempt_id: Some(id.clone()),
        ..Default::default()
    };
    let view = inner.snapshot();
    drop(inner);
    tauri::async_runtime::spawn(async move {
        let context = LoginContext {
            state: state.clone(),
            dir,
            origin: PLATFORM.into(),
            timezone: timezone_offset_seconds.unwrap_or(0),
        };
        let verifier = random_secret();
        let mut remote_id = None;
        let exchange_result = tokio::select! { biased;
            _ = cancelled.changed() => Err("登录已取消".into()),
            result = tokio::time::timeout(Duration::from_secs(600), authorize(&context,&id,&mut remote_id,&verifier, |url| {
                app.opener().open_url(url, None::<&str>).map_err(|_| "无法打开浏览器".into())
            })) => result.unwrap_or_else(|_| Err("登录已超时，请重新登录。".into())),
        };
        let result = match exchange_result {
            Ok((browser, exchanged, deadline)) => {
                commit_authorization(&context, &id, browser, exchanged, deadline).await
            }
            Err(error) => Err(error),
        };
        let mut inner = state.0.lock().await;
        if inner.current(&id) {
            inner.attempt = None;
            if let Err(ref error) = result {
                inner.view.phase = "failed".into();
                inner.view.error = Some(error.clone());
                inner.view.attempt_id = None;
            }
        }
        drop(inner);
        publish(&app);
        if result.is_err() {
            if let Some(remote) = remote_id {
                let _ = platform_request(
                    PLATFORM,
                    "auth_cancel",
                    json!({"authorize_id":remote,"code_verifier":verifier}),
                    context.timezone,
                )
                .await;
            }
        }
    });
    Ok(view)
}
#[tauri::command]
pub async fn deepseek_account_cancel(
    app: AppHandle,
    attempt_id: String,
) -> Result<AccountView, String> {
    let state = app.state::<AccountState>();
    let mut inner = state.0.lock().await;
    if inner.grant.is_none() && inner.current(&attempt_id) {
        if let Some(attempt) = inner.attempt.take() {
            attempt.cancel.send_replace(true);
        }
        inner.view = AccountView {
            phase: "signed-out".into(),
            ..Default::default()
        };
    }
    Ok(inner.snapshot())
}
#[tauri::command]
pub async fn deepseek_account_browser(
    app: AppHandle,
    attempt_id: String,
    copy: bool,
) -> Result<(), String> {
    let state = app.state::<AccountState>();
    let inner = state.0.lock().await;
    let attempt = inner
        .attempt
        .as_ref()
        .filter(|a| a.id == attempt_id)
        .ok_or("登录链接已失效")?;
    let url = attempt.url.as_ref().ok_or("正在准备登录链接")?;
    if copy {
        app.clipboard()
            .write_text(url)
            .map_err(|_| "复制登录链接失败".into())
    } else {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "打开系统浏览器失败，请复制链接后手动打开。".into())
    }
}
async fn clear_grant(inner: &mut Inner, dir: &Path) -> Result<(), String> {
    inner.grant = None;
    inner.loaded = true;
    if let Some(attempt) = inner.attempt.take() {
        attempt.cancel.send_replace(true);
    }
    inner.view = AccountView {
        phase: "signed-out".into(),
        ..Default::default()
    };
    match tokio::fs::remove_file(dir.join("deepseek-account-v1.json")).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(STORAGE_ERROR.into()),
    }
}
#[tauri::command]
pub async fn deepseek_account_logout(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AccountState>();
    let mut inner = state.0.lock().await;
    // Logout also repairs a damaged encrypted file instead of requiring successful decryption.
    let _ = inner.load(&data_dir(&app)?).await;
    let token = inner.grant.as_ref().map(|g| g.token.clone());
    let result = clear_grant(&mut inner, &data_dir(&app)?).await;
    drop(inner);
    publish(&app);
    if let Some(token) = token {
        tauri::async_runtime::spawn(async move {
            let _ = ACCOUNT_HTTP
                .post(format!("{PLATFORM}/auth-api/v0/users/logout"))
                .headers(client_headers(0))
                .header("x-dsh-auth-token", token)
                .timeout(Duration::from_secs(15))
                .send()
                .await;
        });
    }
    result
}
pub async fn inference_headers(
    app: &AppHandle,
    url: &str,
    headers: HeaderMap,
) -> Result<(HeaderMap, String), String> {
    validate_inference_url(url)?;
    let state = app.state::<AccountState>();
    let mut inner = state.0.lock().await;
    inner.load(&data_dir(app)?).await?;
    let token = inner
        .grant
        .as_ref()
        .ok_or("请先通过 DeepSeek 官方授权登录。")?
        .token
        .clone();
    Ok((grant_headers(headers, &token)?, token))
}
fn grant_headers(mut headers: HeaderMap, token: &str) -> Result<HeaderMap, String> {
    headers.remove("authorization");
    headers.remove("x-dsh-auth-token");
    headers.remove("host");
    let mut secret =
        reqwest::header::HeaderValue::from_str(&token).map_err(|_| "登录凭据无效，请重新登录。")?;
    secret.set_sensitive(true);
    headers.insert("x-dsh-auth-token", secret);
    Ok(headers)
}
fn validate_inference_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "模型地址无效")?;
    if url.origin().ascii_serialization() != "https://api.deepseek.com"
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("账号授权仅支持 DeepSeek 官方模型接口。".into());
    }
    Ok(())
}
pub async fn expire(app: &AppHandle, token: &str) {
    let state = app.state::<AccountState>();
    let mut inner = state.0.lock().await;
    if inner.grant.as_ref().is_some_and(|g| g.token == token) {
        if let Ok(dir) = data_dir(app) {
            let _ = clear_grant(&mut inner, &dir).await;
        }
        inner.view.error = Some("DeepSeek 登录已失效，请重新登录。".into());
        drop(inner);
        publish(app);
    }
}

/// Resize the single trusted renderer, avoiding a brief workspace flash before login.
#[tauri::command]
pub async fn deepseek_account_present(app: AppHandle) -> Result<(), String> {
    let signed_in = deepseek_account_status(app.clone())
        .await
        .map(|v| v.signed_in)
        .unwrap_or(false);
    if let Some(window) = app.get_webview_window("main") {
        window.set_fullscreen(false).map_err(|_| "无法调整窗口")?;
        window.unmaximize().map_err(|_| "无法调整窗口")?;
        window
            .set_min_size(None::<tauri::LogicalSize<u32>>)
            .map_err(|_| "无法调整窗口")?;
        window
            .set_resizable(signed_in)
            .map_err(|_| "无法调整窗口")?;
        window
            .set_maximizable(signed_in)
            .map_err(|_| "无法调整窗口")?;
        window
            .set_size(if signed_in {
                tauri::LogicalSize::new(1280, 820)
            } else {
                tauri::LogicalSize::new(600, 700)
            })
            .map_err(|_| "无法调整窗口")?;
        if signed_in {
            window
                .set_min_size(Some(tauri::LogicalSize::new(960, 600)))
                .map_err(|_| "无法调整窗口")?;
        }
        window.center().map_err(|_| "无法居中窗口")?;
        window.show().map_err(|_| "无法显示窗口")?;
        let _ = window.set_focus();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_details_validation() {
        assert_eq!(
            account_identity(&json!({"email":"","mobile":"13800000000","id_profile":{"name":""}})),
            (None, Some("13800000000".into()))
        );
        assert!(wallets(&json!([{"currency":"CNY","balance":"0E-16"}])).is_some());
        for value in [
            json!([{"currency":"EUR","balance":"1"}]),
            json!([{"currency":"CNY","balance":"NaN"}]),
            json!([{"currency":"CNY","balance":0}]),
            json!(null),
        ] {
            assert!(wallets(&value).is_none());
        }
        assert_eq!(
            detail_payload(json!({"code":40003})),
            Err(DetailError::Expired)
        );
        assert_eq!(
            detail_payload(json!({"code":0,"data":{"biz_code":40003}})),
            Err(DetailError::Expired)
        );
        assert_eq!(
            detail_payload(json!({"code":0})),
            Err(DetailError::Unavailable)
        );
    }
    #[test]
    fn account_details_http_projection() {
        tauri::async_runtime::block_on(async {
            for mode in ["ready", "unavailable", "expired"] {
                let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
                let origin = format!("http://{}", listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    for _ in 0..2 {
                        let (mut stream, _) = listener.accept().await.unwrap();
                        let mut bytes = Vec::new();
                        while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                            let mut buf = [0; 2048];
                            let count = stream.read(&mut buf).await.unwrap();
                            assert!(count > 0);
                            bytes.extend_from_slice(&buf[..count]);
                        }
                        let request = String::from_utf8(bytes).unwrap();
                        assert!(request
                            .to_ascii_lowercase()
                            .contains("x-dsh-auth-token: fixture-detail-token"));
                        if request.starts_with("GET /auth-api/v0/users/current ") {
                            respond_json(&mut stream, json!({"email":"fixture@example.invalid","id_profile":{"name":"测试账号"},"token":"must-not-project"})).await;
                        } else {
                            assert!(request.starts_with("GET /api/v0/users/get_user_summary "));
                            match mode {
                                "unavailable" => reply(&mut stream, "503 Service Unavailable", "", "offline").await,
                                "expired" => reply(&mut stream, "401 Unauthorized", "", "expired").await,
                                _ => respond_json(&mut stream, json!({"normal_wallets":[{"currency":"CNY","balance":"12.34"}],"bonus_wallets":[{"currency":"CNY","balance":"5.6"}]})).await,
                            }
                        }
                    }
                });
                let result = read_account_details(&origin, "fixture-detail-token", 28800).await;
                if mode == "expired" {
                    assert!(matches!(result, Err(DetailError::Expired)));
                    server.await.unwrap();
                    continue;
                }
                let details = result.unwrap();
                assert_eq!(details.name.as_deref(), Some("测试账号"));
                assert!(details.profile_available);
                assert_eq!(details.wallets.is_some(), mode == "ready");
                let serialized = serde_json::to_string(&details).unwrap();
                assert!(!serialized.contains("fixture-detail-token"));
                assert!(!serialized.contains("must-not-project"));
                server.await.unwrap();
            }
        });
    }
    fn fixture() -> (LoginContext, String) {
        let id = random_secret();
        let state = AccountState::default();
        let dir = std::env::temp_dir().join(format!("eaicoding-account-test-{}", random_secret()));
        (
            LoginContext {
                state,
                dir,
                origin: PLATFORM.into(),
                timezone: 28800,
            },
            id,
        )
    }
    async fn active(context: &LoginContext, id: &str) {
        context.state.0.lock().await.attempt = Some(Attempt {
            id: id.into(),
            cancel: watch::channel(false).0,
            url: None,
        });
    }
    #[test]
    fn pkce_and_restricted_destinations() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(random_secret().len(), 43);
        assert!(browser_url(
            "https://platform.deepseek.com/dsh/authorize?a=1",
            PLATFORM,
            "/dsh/authorize"
        )
        .is_ok());
        for value in [
            "https://evil.example/dsh/authorize",
            "https://user@platform.deepseek.com/dsh/authorize",
            "https://platform.deepseek.com/dsh/authorize#code",
            "http://platform.deepseek.com/dsh/authorize",
        ] {
            assert!(browser_url(value, PLATFORM, "/dsh/authorize").is_err());
        }
        for value in [
            "http://api.deepseek.com/chat/completions",
            "https://api.deepseek.com.evil.example/",
            "https://api.deepseek.com:444/",
            "https://user@api.deepseek.com/",
            "http://127.0.0.1/",
        ] {
            assert!(validate_inference_url(value).is_err());
        }
        assert!(validate_inference_url("https://api.deepseek.com/v1/chat/completions").is_ok());
    }
    #[test]
    fn callback_rejects_duplicate_and_unbound_parameters() {
        for target in [
            "/oauth/callback?state=wrong&code=x",
            "/oauth/callback?state=expected&code=x&code=y",
            "/oauth/callback?state=expected&state=expected&code=x",
            "/other?state=expected&code=x",
            "/oauth/callback?state=expected&code=",
            "https://evil.example/oauth/callback?state=expected&code=x",
        ] {
            assert!(
                callback_code(&format!("GET {target} HTTP/1.1\r\n\r\n"), "expected", 1234).is_err()
            );
        }
        assert_eq!(
            callback_code(
                "GET /oauth/callback?state=expected&code=valid HTTP/1.1\r\n\r\n",
                "expected",
                1234
            )
            .unwrap(),
            "valid"
        );
    }
    #[test]
    fn inference_uses_native_sensitive_grant_header() {
        let mut supplied = HeaderMap::new();
        supplied.insert("authorization", "Bearer renderer-input".parse().unwrap());
        supplied.insert("x-dsh-auth-token", "renderer-input".parse().unwrap());
        supplied.insert("host", "evil.example".parse().unwrap());
        supplied.insert("content-type", "application/json".parse().unwrap());
        let headers = grant_headers(supplied, "fixture-native-grant").unwrap();
        assert!(!headers.contains_key("authorization"));
        assert!(!headers.contains_key("host"));
        assert_eq!(headers["x-dsh-auth-token"], "fixture-native-grant");
        assert!(headers["x-dsh-auth-token"].is_sensitive());
        assert!(!format!("{headers:?}").contains("fixture-native-grant"));
    }
    async fn read_json_request(listener: &TcpListener) -> (TcpStream, String, Value) {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut buf = [0; 1024];
            let n = stream.read(&mut buf).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let size: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + size {
                    return (
                        stream,
                        headers.lines().next().unwrap().into(),
                        serde_json::from_slice(&bytes[end + 4..end + 4 + size]).unwrap(),
                    );
                }
            }
        }
    }
    async fn respond_json(stream: &mut TcpStream, data: Value) {
        reply(
            stream,
            "200 OK",
            "",
            &json!({"code":0,"data":{"biz_code":0,"biz_data":data}}).to_string(),
        )
        .await;
    }
    #[test]
    fn full_mock_authorization_and_encrypted_restart() {
        tauri::async_runtime::block_on(async {
            let (mut context, id) = fixture();
            active(&context, &id).await;
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            context.origin = format!("http://{}", listener.local_addr().unwrap());
            let origin = context.origin.clone();
            let verifier = random_secret();
            let expected_challenge = challenge(&verifier);
            let server = tokio::spawn(async move {
                let (mut stream, path, init) = read_json_request(&listener).await;
                assert!(path.contains("/auth-api/v0/dsh/auth_init"));
                assert_eq!(init["code_challenge"], expected_challenge);
                assert_eq!(init["code_challenge_method"], "S256");
                assert_eq!(init["login_source"], "desktop");
                respond_json(&mut stream,json!({"authorize_url":format!("{origin}/dsh/authorize?id=fixture"),"authorize_id":"fixture-id","expires_in":10})).await;
                let redirect = init["redirect_uri"].as_str().unwrap().to_string();
                let state = init["state"].as_str().unwrap().to_string();
                let expected_redirect = redirect.clone();
                let callback = tokio::spawn(async move {
                    let invalid = ACCOUNT_HTTP
                        .get(format!("{redirect}?state=wrong&code=no"))
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(invalid.status(), 400);
                    let duplicate = ACCOUNT_HTTP
                        .get(format!("{redirect}?state={state}&code=x&code=y"))
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(duplicate.status(), 400);
                    ACCOUNT_HTTP
                        .get(format!("{redirect}?state={state}&code=fixture-code"))
                        .send()
                        .await
                        .unwrap()
                });
                let (mut stream, path, exchange) = read_json_request(&listener).await;
                assert!(path.contains("/auth-api/v0/dsh/auth_exchange"));
                assert_eq!(exchange["code"], "fixture-code");
                assert_eq!(
                    challenge(exchange["code_verifier"].as_str().unwrap()),
                    expected_challenge
                );
                assert_eq!(exchange["redirect_uri"], expected_redirect);
                assert_eq!(exchange["device_id"].as_str().unwrap().len(), 36);
                respond_json(&mut stream,json!({"token":"fixture-only-account-token","authorized_url":format!("{origin}/dsh/authorized"),"user":{"email":"fixture@example.invalid","id_profile":{"name":"测试账号"}}})).await;
                callback
            });
            let (browser, result, deadline) =
                authorize(&context, &id, &mut None, &verifier, |_| Ok(()))
                    .await
                    .unwrap();
            commit_authorization(&context, &id, browser, result, deadline)
                .await
                .unwrap();
            let response = server.await.unwrap().await.unwrap();
            assert_eq!(response.status(), 302);
            assert!(response.headers()["location"]
                .to_str()
                .unwrap()
                .contains("login_source=desktop"));
            let stored = tokio::fs::read_to_string(context.dir.join("deepseek-account-v1.json"))
                .await
                .unwrap();
            assert!(!stored.contains("fixture-only-account-token"));
            let mut restarted = Inner::default();
            restarted.load(&context.dir).await.unwrap();
            assert!(restarted.snapshot().signed_in);
            assert_eq!(restarted.snapshot().name.as_deref(), Some("测试账号"));
            assert!(!serde_json::to_string(&restarted.snapshot())
                .unwrap()
                .contains("fixture-only-account-token"));
            assert_eq!(
                device_id(&context.dir).await.unwrap(),
                device_id(&context.dir).await.unwrap()
            );
            clear_grant(&mut restarted, &context.dir).await.unwrap();
            let mut after_logout = Inner::default();
            after_logout.load(&context.dir).await.unwrap();
            assert!(!after_logout.snapshot().signed_in);
            tokio::fs::remove_dir_all(&context.dir).await.unwrap();
        });
    }
    #[test]
    fn late_exchange_after_cancel_cannot_write_grant() {
        tauri::async_runtime::block_on(async {
            let (context, id) = fixture();
            active(&context, &id).await;
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let client = TcpStream::connect(listener.local_addr().unwrap())
                .await
                .unwrap();
            let (browser, _) = listener.accept().await.unwrap();
            clear_grant(&mut *context.state.0.lock().await, &context.dir)
                .await
                .unwrap();
            let result = commit_authorization(&context,&id,browser,json!({"token":"fixture-late-token","authorized_url":format!("{PLATFORM}/dsh/authorized")}),tokio::time::Instant::now()+Duration::from_secs(60)).await;
            assert!(result.is_err());
            assert!(!context.dir.join("deepseek-account-v1.json").exists());
            assert!(!context.state.0.lock().await.snapshot().signed_in);
            drop(client);
        });
    }
}
