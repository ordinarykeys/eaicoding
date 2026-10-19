//! Bundled Node host for the same complete pi-ai auth/provider stack as Harness.
//! Only native stdin receives grants; webview events contain interaction/status.
use crate::{crypto, model_providers, task_cancel};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Arc, LazyLock, Mutex as StdMutex},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::Mutex,
};

type InputPipe = Arc<Mutex<ChildStdin>>;
static LOCKS: LazyLock<StdMutex<HashMap<String, Arc<Mutex<()>>>>> = LazyLock::new(Default::default);
static INPUTS: LazyLock<StdMutex<HashMap<String, InputPipe>>> = LazyLock::new(Default::default);
pub fn profile_lock(id: &str) -> Result<Arc<Mutex<()>>, String> {
    let mut locks = LOCKS.lock().map_err(|_| "无法锁定模型配置")?;
    Ok(locks.entry(id.to_string()).or_default().clone())
}
struct InputGuard(String);
impl Drop for InputGuard {
    fn drop(&mut self) {
        if let Ok(mut inputs) = INPUTS.lock() {
            inputs.remove(&self.0);
        }
    }
}
async fn send(pipe: &InputPipe, value: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "无法编码认证请求")?;
    bytes.push(b'\n');
    pipe.lock()
        .await
        .write_all(&bytes)
        .await
        .map_err(|_| "模型运行时已退出".into())
}
fn grant_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "无法访问凭据目录")?
        .join("model-grants-v1.json"))
}
static GRANTS_WRITE: Mutex<()> = Mutex::const_new(());
async fn grants(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    match tokio::fs::read(grant_path(app)?).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "模型授权凭据文件损坏".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(_) => Err("无法读取模型授权凭据".into()),
    }
}
pub async fn credential(
    app: &AppHandle,
    id: &str,
    provider: &str,
) -> Result<Option<Value>, String> {
    let Some(encrypted) = grants(app).await?.remove(id) else {
        return Ok(None);
    };
    let record: Value = serde_json::from_str(&crypto::decrypt_secret(encrypted)?)
        .map_err(|_| "模型授权凭据损坏")?;
    if record["provider"].as_str() != Some(provider) {
        return Err("授权凭据与提供商不匹配，请重新登录".into());
    }
    Ok(Some(record["credential"].clone()))
}
pub async fn store_credential(
    app: &AppHandle,
    id: &str,
    provider: &str,
    value: Value,
) -> Result<(), String> {
    let _lock = GRANTS_WRITE.lock().await;
    let mut stored = grants(app).await?;
    if value.is_null() {
        stored.remove(id);
    } else {
        let encrypted =
            crypto::encrypt_secret(json!({"provider":provider,"credential":value}).to_string())?;
        stored.insert(id.to_string(), encrypted);
    }
    let path = grant_path(app)?;
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .map_err(|_| "无法创建授权凭据目录")?;
    let temp = path.with_extension("tmp");
    tokio::fs::write(
        &temp,
        serde_json::to_vec(&stored).map_err(|_| "无法编码授权凭据")?,
    )
    .await
    .map_err(|_| "无法保存授权凭据")?;
    tokio::fs::rename(temp, path)
        .await
        .map_err(|_| "无法替换授权凭据文件".into())
}

#[tauri::command]
pub async fn model_runtime_reply(
    request_id: String,
    prompt_id: String,
    value: String,
) -> Result<(), String> {
    if value.len() > 65536 {
        return Err("输入内容过长".into());
    }
    let pipe = INPUTS
        .lock()
        .map_err(|_| "认证会话不可用")?
        .get(&request_id)
        .cloned()
        .ok_or("认证会话已结束")?;
    send(
        &pipe,
        json!({"type":"prompt_reply","promptId":prompt_id,"value":value}),
    )
    .await
}

#[tauri::command]
pub async fn model_runtime_run(
    app: AppHandle,
    request_id: String,
    profile_id: String,
    mut input: Value,
) -> Result<Value, String> {
    if !matches!(
        input["operation"].as_str(),
        Some("login" | "stream" | "discover" | "status")
    ) {
        return Err("未知模型运行操作".into());
    }
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("无效模型请求标识".into());
    }
    task_cancel::cancellable(Some(request_id.clone()), async {
        let lock = profile_lock(&profile_id)?;
        let _guard = lock.lock().await;
        let registration = model_providers::runtime_registration(&app, &profile_id).await?;
        let provider = registration["provider"]
            .as_str()
            .ok_or("提供商配置缺失")?
            .to_string();
        // Discard all credential/endpoint/model metadata supplied by a webview.
        input["provider"] = registration["provider"].clone();
        input["models"] = registration["models"].clone();
        input["baseUrl"] = registration["baseUrl"].clone();
        input["credential"] = credential(&app, &profile_id, &provider)
            .await?
            .unwrap_or(registration["credential"].clone());
        run_host(&app, &request_id, &profile_id, &provider, input).await
    })
    .await
}

pub async fn run_host(
    app: &AppHandle,
    request_id: &str,
    profile_id: &str,
    provider: &str,
    input: Value,
) -> Result<Value, String> {
    let runtime = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/model-runtime")
    } else {
        app.path()
            .resource_dir()
            .map_err(|_| "无法定位模型运行时")?
            .join("model-runtime")
    };
    let mut command = Command::new(runtime.join("node.exe"));
    command
        .arg(runtime.join("host.cjs"))
        .current_dir(&runtime)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        // A bundled runtime must not load arbitrary global Node hooks/packages.
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动模型运行时，请重新安装完整安装包或运行 npm run prepare:models")?;
    let pipe = Arc::new(Mutex::new(child.stdin.take().ok_or("模型输入管道不可用")?));
    let stdout = child.stdout.take().ok_or("模型输出管道不可用")?;
    {
        let mut inputs = INPUTS.lock().map_err(|_| "模型认证会话不可用")?;
        if inputs.contains_key(request_id) {
            return Err("模型请求标识已在使用".into());
        }
        inputs.insert(request_id.to_string(), pipe.clone());
    }
    let _input_guard = InputGuard(request_id.to_string());
    send(&pipe, input).await?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let size = reader
            .read_line(&mut line)
            .await
            .map_err(|_| "模型运行时响应中断")?;
        if size == 0 {
            return Err("模型运行时提前退出，请检查提供商配置或重新登录".into());
        }
        if size > 32 * 1024 * 1024 {
            return Err("模型运行时响应过大".into());
        }
        let event: Value = serde_json::from_str(&line).map_err(|_| "模型运行时响应格式错误")?;
        match event["type"].as_str() {
            Some("persist") => {
                let saved =
                    store_credential(app, profile_id, provider, event["credential"].clone()).await;
                send(
                    &pipe,
                    json!({"type":"persist_ack","promptId":event["promptId"],"error":saved.err()}),
                )
                .await?;
            }
            Some("result") => {
                let _ = child.wait().await;
                return Ok(event["result"].clone());
            }
            Some("failure") => {
                return Err(event["message"]
                    .as_str()
                    .unwrap_or("模型认证或请求失败")
                    .to_string());
            }
            Some(
                "notice" | "prompt" | "prompt_cancel" | "text_delta" | "thinking_delta" | "done",
            ) => {
                app.emit(
                    "model-runtime-event",
                    json!({"requestId":request_id,"event":event}),
                )
                .map_err(|_| "无法发送模型状态")?;
            }
            _ => return Err("模型运行时返回未知事件".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_locks_serialize_same_profile_and_isolate_other_profiles() {
        let a = profile_lock("lock-a").unwrap();
        assert!(Arc::ptr_eq(&a, &profile_lock("lock-a").unwrap()));
        assert!(!Arc::ptr_eq(&a, &profile_lock("lock-b").unwrap()));
    }
}
