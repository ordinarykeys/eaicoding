//! API-provider credentials are encrypted on disk and injected only in native HTTP.
use crate::{crypto, deepseek_account::ACCOUNT_HTTP};
use reqwest::{
    header::{HeaderMap, HeaderValue},
    Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
static WRITE: Mutex<()> = Mutex::const_new(());
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Route {
    #[serde(default)]
    provider: String,
    #[serde(default)]
    runtime: bool,
    #[serde(default)]
    models: Vec<Value>,
    base_url: String,
    protocol: String,
    encrypted_key: String,
    env_key: String,
    #[serde(default)]
    routes: Vec<Endpoint>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    base_url: String,
    protocol: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    #[serde(default)]
    provider: String,
    #[serde(default)]
    runtime: bool,
    #[serde(default)]
    models: Vec<Value>,
    id: String,
    base_url: String,
    protocol: String,
    api_key: Option<String>,
    env_key: Option<String>,
    #[serde(default)]
    routes: Vec<Endpoint>,
}
fn valid_base(base: &str) -> Result<Url, String> {
    let url = Url::parse(base).map_err(|_| "接口地址无效")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("请输入不带账号、查询参数或片段的 HTTP/HTTPS 接口地址".into());
    }
    Ok(url)
}
fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法访问配置目录")?
        .join("model-providers-v1.json"))
}
async fn read(app: &AppHandle) -> Result<BTreeMap<String, Route>, String> {
    match tokio::fs::read(path(app)?).await {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "模型凭据文件损坏，请检查配置目录".into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(_) => Err("无法读取模型凭据".into()),
    }
}
async fn write(app: &AppHandle, routes: &BTreeMap<String, Route>) -> Result<(), String> {
    let path = path(app)?;
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .map_err(|_| "无法创建配置目录")?;
    let temp = path.with_extension("tmp");
    tokio::fs::write(
        &temp,
        serde_json::to_vec(routes).map_err(|_| "无法保存模型凭据")?,
    )
    .await
    .map_err(|_| "无法保存模型凭据")?;
    tokio::fs::rename(&temp, &path)
        .await
        .map_err(|_| "无法替换模型凭据文件".into())
}
fn protocol_valid(protocol: &str) -> bool {
    matches!(
        protocol,
        "openai-chat-completions"
            | "openai-responses"
            | "anthropic-messages"
            | "google-generative-ai"
            | "bedrock-converse"
            | "pi-ai"
    )
}
#[tauri::command]
pub async fn model_provider_save(app: AppHandle, input: ProviderInput) -> Result<(), String> {
    if input.id == "default" || input.id.is_empty() || input.id.len() > 128 {
        return Err("提供商标识无效".into());
    }
    if !input.runtime || !input.base_url.is_empty() {
        valid_base(&input.base_url)?;
    }
    if input.runtime
        && (input.provider.is_empty()
            || input.provider.len() > 128
            || !input
                .provider
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
    {
        return Err("提供商标识无效".into());
    }
    if input.models.len() > 10000 {
        return Err("模型数量过多".into());
    }
    if !protocol_valid(&input.protocol) {
        return Err("不支持的模型协议".into());
    }
    if input.routes.len() > 10000 {
        return Err("模型端点过多".into());
    }
    for endpoint in &input.routes {
        valid_base(&endpoint.base_url)?;
        if !protocol_valid(&endpoint.protocol) {
            return Err("不支持的模型协议".into());
        }
    }
    let profile_lock = crate::model_runtime::profile_lock(&input.id)?;
    let _profile_lock = profile_lock.lock().await;
    let _lock = WRITE.lock().await;
    let mut routes = read(&app).await?;
    let old = routes.get(&input.id);
    if old.is_some_and(|r| !r.provider.is_empty() && r.provider != input.provider) {
        return Err("不能修改已保存的提供商标识".into());
    }
    let replacing_key = input.api_key.as_ref().is_some_and(|s| !s.trim().is_empty());
    let api_key = input.api_key.map(|k| k.trim().to_string());
    let encrypted_key = match api_key {
        Some(key) if key.len() > 16384 || key.bytes().any(|c| c < 0x20 || c == 0x7f) => {
            return Err("API 密钥包含无效字符或过长".into())
        }
        Some(key) if !key.is_empty() => crypto::encrypt_secret(key)?,
        _ => old.map(|r| r.encrypted_key.clone()).unwrap_or_default(),
    };
    let env_key = input.env_key.unwrap_or_default();
    if !env_key
        .bytes()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    {
        return Err("环境变量名称无效".into());
    }
    if replacing_key {
        crate::model_runtime::store_credential(&app, &input.id, &input.provider, Value::Null)
            .await?;
    }
    routes.insert(
        input.id,
        Route {
            provider: input.provider,
            runtime: input.runtime,
            models: input.models,
            base_url: input.base_url,
            protocol: input.protocol,
            encrypted_key,
            env_key,
            routes: input.routes,
        },
    );
    write(&app, &routes).await
}
#[tauri::command]
pub async fn model_provider_remove(app: AppHandle, id: String) -> Result<(), String> {
    let profile_lock = crate::model_runtime::profile_lock(&id)?;
    let _profile_lock = profile_lock.lock().await;
    let _lock = WRITE.lock().await;
    let mut routes = read(&app).await?;
    crate::model_runtime::store_credential(&app, &id, "", Value::Null).await?;
    routes.remove(&id);
    write(&app, &routes).await
}
#[tauri::command]
pub async fn model_provider_status(app: AppHandle) -> Result<BTreeMap<String, bool>, String> {
    let routes = read(&app).await?;
    let mut result = BTreeMap::new();
    let mut entries = Vec::new();
    for (id, route) in routes {
        if route.runtime {
            let mut entry = runtime_registration(&app, &id).await?;
            entry["credential"] = crate::model_runtime::credential(&app, &id, &route.provider)
                .await?
                .unwrap_or(entry["credential"].clone());
            entry["id"] = json!(id);
            entries.push(entry);
            continue;
        }
        let configured = !route.encrypted_key.is_empty()
            || (!route.env_key.is_empty()
                && std::env::var(&route.env_key).is_ok_and(|s| !s.is_empty()))
            || crate::model_runtime::credential(&app, &id, &route.provider)
                .await?
                .is_some();
        result.insert(id, configured);
    }
    if !entries.is_empty() {
        let request_id = format!("provider-status-{:032x}", rand::random::<u128>());
        let statuses = crate::model_runtime::run_host(
            &app,
            &request_id,
            "",
            "",
            json!({"operation":"status_all","entries":entries}),
        )
        .await?;
        if let Some(statuses) = statuses.as_object() {
            for (id, value) in statuses {
                result.insert(id.clone(), value.as_bool().unwrap_or(false));
            }
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn model_provider_logout(app: AppHandle, id: String) -> Result<(), String> {
    let profile_lock = crate::model_runtime::profile_lock(&id)?;
    let _profile_lock = profile_lock.lock().await;
    let _lock = WRITE.lock().await;
    let mut routes = read(&app).await?;
    let route = routes.get_mut(&id).ok_or("提供商已删除")?;
    crate::model_runtime::store_credential(&app, &id, &route.provider, Value::Null).await?;
    route.encrypted_key.clear();
    write(&app, &routes).await
}
pub async fn runtime_registration(app: &AppHandle, id: &str) -> Result<Value, String> {
    let route = read(app).await?.remove(id).ok_or("提供商已删除")?;
    if !route.runtime {
        return Err("提供商未启用本地认证运行时，请重新保存模型设置".into());
    }
    let key = if !route.encrypted_key.is_empty() {
        crypto::decrypt_secret(route.encrypted_key)?
    } else {
        std::env::var(route.env_key).unwrap_or_default()
    };
    Ok(
        json!({"provider":route.provider,"baseUrl":route.base_url,"models":route.models,"credential":if key.is_empty(){Value::Null}else{json!({"type":"api_key","key":key})}}),
    )
}
fn scoped_url(base: &str, requested: &str) -> Result<(), String> {
    let base = valid_base(base)?;
    let target = Url::parse(requested).map_err(|_| "请求地址无效")?;
    let prefix = base.path().trim_end_matches('/');
    if target.origin() != base.origin()
        || !target.username().is_empty()
        || target.password().is_some()
        || !(target.path() == prefix || target.path().starts_with(&format!("{prefix}/")))
    {
        return Err("请求地址与已保存的提供商不匹配，请重新保存接口配置".into());
    }
    Ok(())
}
fn route_headers(
    route: &Route,
    mut headers: HeaderMap,
    override_key: Option<&str>,
) -> Result<HeaderMap, String> {
    for name in [
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "x-dsh-auth-token",
        "host",
    ] {
        headers.remove(name);
    }
    let key = match override_key.filter(|s| !s.trim().is_empty()) {
        Some(key) => key.trim().to_string(),
        None if !route.encrypted_key.is_empty() => {
            crypto::decrypt_secret(route.encrypted_key.clone())?
        }
        None => std::env::var(&route.env_key).unwrap_or_default(),
    };
    if !key.is_empty() {
        let (name, key) = match route.protocol.as_str() {
            "anthropic-messages" => ("x-api-key", key),
            "google-generative-ai" => ("x-goog-api-key", key),
            _ => ("authorization", format!("Bearer {key}")),
        };
        let mut value = HeaderValue::from_str(&key).map_err(|_| "API 密钥格式无效")?;
        value.set_sensitive(true);
        headers.insert(name, value);
    }
    if route.protocol == "anthropic-messages" {
        headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    }
    Ok(headers)
}
pub async fn headers(
    app: &AppHandle,
    id: &str,
    url: &str,
    headers: HeaderMap,
    protocol: Option<&str>,
) -> Result<HeaderMap, String> {
    let routes = read(app).await?;
    let route = routes
        .get(id)
        .ok_or("模型提供商未保存，请在设置中重新保存")?;
    scoped_headers(route, url, headers, protocol)
}
fn scoped_headers(
    route: &Route,
    url: &str,
    headers: HeaderMap,
    protocol: Option<&str>,
) -> Result<HeaderMap, String> {
    let protocol = protocol.unwrap_or(&route.protocol);
    if protocol != route.protocol || scoped_url(&route.base_url, url).is_err() {
        let endpoint = route
            .routes
            .iter()
            .find(|e| e.protocol == protocol && scoped_url(&e.base_url, url).is_ok())
            .ok_or("模型端点或协议与已保存配置不匹配，请重新保存提供商")?;
        let mut selected = route.clone();
        selected.protocol = endpoint.protocol.clone();
        return route_headers(&selected, headers, None);
    }
    route_headers(route, headers, None)
}
#[tauri::command]
pub async fn model_provider_discover(
    app: AppHandle,
    input: ProviderInput,
) -> Result<Value, String> {
    valid_base(&input.base_url)?;
    if !protocol_valid(&input.protocol) {
        return Err("不支持的模型协议".into());
    }
    let routes = read(&app).await?;
    let old = routes.get(&input.id);
    let route = Route {
        base_url: input.base_url,
        protocol: input.protocol,
        env_key: input.env_key.unwrap_or_default(),
        encrypted_key: old.map(|r| r.encrypted_key.clone()).unwrap_or_default(),
        routes: Vec::new(),
        ..Default::default()
    };
    // Unsaved endpoint changes may only use the key explicitly supplied in this form.
    let mut route = route;
    if old.is_some_and(|r| r.base_url.trim_end_matches('/') != route.base_url.trim_end_matches('/'))
    {
        route.encrypted_key.clear();
    }
    let base = route.base_url.trim_end_matches('/');
    let url = match route.protocol.as_str() {
        "anthropic-messages" => format!(
            "{}/v1/models?limit=1000",
            base.strip_suffix("/v1").unwrap_or(base)
        ),
        "google-generative-ai" => format!("{base}/models?pageSize=1000"),
        "bedrock-converse" => {
            return Err("Bedrock 不提供此模型列表接口，请使用内置目录或手动添加模型。".into())
        }
        _ => format!("{base}/models"),
    };
    let mut response = ACCOUNT_HTTP
        .get(&url)
        .headers(route_headers(
            &route,
            HeaderMap::new(),
            input.api_key.as_deref(),
        )?)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "获取模型列表失败，请检查网络和接口地址")?;
    if !response.status().is_success() {
        return Err(format!(
            "获取模型列表 HTTP {}，可检查密钥或手动填写模型 ID",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取模型列表失败")? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("模型列表响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| "模型列表不是有效 JSON")?;
    let rows: Vec<(Option<String>, Value)> = if let Some(data) = body["data"].as_array() {
        data.iter().map(|v| (None, v.clone())).collect()
    } else if let Some(data) = body["models"].as_array() {
        data.iter().map(|v| (None, v.clone())).collect()
    } else if let Some(data) = body["models"].as_object() {
        data.iter()
            .map(|(k, v)| (Some(k.clone()), v.clone()))
            .collect()
    } else {
        return Err("接口未返回模型列表，请手动填写模型 ID".into());
    };
    let mut seen = std::collections::HashSet::new();
    let models: Vec<Value> = rows
        .into_iter()
        .filter_map(|(alias, row)| {
            let id = alias.filter(|s| !s.is_empty()).or_else(|| {
                row["id"]
                    .as_str()
                    .or_else(|| row["name"].as_str())
                    .map(|s| s.trim_start_matches("models/").to_string())
            })?;
            if id.is_empty() || !seen.insert(id.clone()) {
                return None;
            }
            let name = row["displayName"]
                .as_str()
                .or_else(|| row["display_name"].as_str())
                .or_else(|| row["name"].as_str())
                .unwrap_or(&id);
            Some(json!({"id":id,"name":name,"ownedBy":null}))
        })
        .take(10000)
        .collect();
    Ok(json!(models))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mixed_protocol_routes_use_only_registered_endpoint_and_header() {
        let route = Route {
            base_url: "https://gateway.example/api/v1".into(),
            protocol: "openai-chat-completions".into(),
            routes: vec![Endpoint {
                base_url: "https://gateway.example/api".into(),
                protocol: "anthropic-messages".into(),
            }],
            ..Default::default()
        };
        let open = scoped_headers(
            &route,
            "https://gateway.example/api/v1/chat/completions",
            HeaderMap::new(),
            Some("openai-chat-completions"),
        )
        .unwrap();
        assert!(!open.contains_key("anthropic-version"));
        let anthropic = scoped_headers(
            &route,
            "https://gateway.example/api/v1/messages",
            HeaderMap::new(),
            Some("anthropic-messages"),
        )
        .unwrap();
        assert_eq!(anthropic["anthropic-version"], "2023-06-01");
        assert!(scoped_headers(
            &route,
            "https://gateway.example/outside/messages",
            HeaderMap::new(),
            Some("anthropic-messages")
        )
        .is_err());
        assert!(scoped_headers(
            &route,
            "https://elsewhere.example/api/v1/messages",
            HeaderMap::new(),
            Some("anthropic-messages")
        )
        .is_err());
        assert!(scoped_headers(
            &route,
            "https://gateway.example/api/v1/messages",
            HeaderMap::new(),
            Some("google-generative-ai")
        )
        .is_err());
    }
    #[test]
    fn routes_bind_credentials_to_origin_and_prefix() {
        assert!(scoped_url(
            "https://gateway.example/prefix/v1",
            "https://gateway.example/prefix/v1/chat/completions"
        )
        .is_ok());
        for bad in [
            "https://other.example/prefix/v1/models",
            "https://gateway.example/prefix/v10/models",
            "https://gateway.example/prefix/v1/../../secret",
            "https://user@ gateway.example/",
        ] {
            assert!(scoped_url("https://gateway.example/prefix/v1", bad).is_err());
        }
        let route = Route {
            protocol: "anthropic-messages".into(),
            ..Default::default()
        };
        let h = route_headers(&route, HeaderMap::new(), Some("fixture-key")).unwrap();
        assert_eq!(h["x-api-key"], "fixture-key");
        assert!(h["x-api-key"].is_sensitive());
        assert!(!format!("{h:?}").contains("fixture-key"));
        assert!(!h.contains_key("x-dsh-auth-token"));
    }
}
