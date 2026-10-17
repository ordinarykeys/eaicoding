use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_TIMEOUT_SECS: u64 = 300;

// Shared client: reuses the connection pool / TLS sessions across requests.
// No global total timeout here — non-stream requests set a per-request
// timeout, streaming uses an idle-read timeout per chunk instead.
static HTTP_CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build shared LLM proxy client")
});

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProxyRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<Value>,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProxyResponse {
    pub status: u16,
    pub status_text: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProxyStreamRequest {
    pub request_id: String,
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<Value>,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProxyStreamChunk {
    pub request_id: String,
    pub text: String,
}

fn emit_stream_text(
    app: &AppHandle,
    request_id: &str,
    text: &mut String,
    piece: String,
) -> Result<(), String> {
    if piece.is_empty() {
        return Ok(());
    }
    text.push_str(&piece);
    app.emit(
        "llm-proxy-stream-chunk",
        LlmProxyStreamChunk {
            request_id: request_id.to_string(),
            text: piece,
        },
    )
    .map_err(|err| format!("Failed to emit LLM proxy stream chunk: {err}"))
}

fn emit_available_utf8(
    app: &AppHandle,
    request_id: &str,
    text: &mut String,
    pending: &mut Vec<u8>,
    flush: bool,
) -> Result<(), String> {
    loop {
        if pending.is_empty() {
            return Ok(());
        }

        match std::str::from_utf8(pending) {
            Ok(valid) => {
                let piece = valid.to_string();
                pending.clear();
                return emit_stream_text(app, request_id, text, piece);
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let piece = std::str::from_utf8(&pending[..valid_up_to])
                        .unwrap_or("")
                        .to_string();
                    pending.drain(..valid_up_to);
                    emit_stream_text(app, request_id, text, piece)?;
                    continue;
                }

                if let Some(error_len) = err.error_len() {
                    let invalid: Vec<u8> = pending.drain(..error_len).collect();
                    emit_stream_text(
                        app,
                        request_id,
                        text,
                        String::from_utf8_lossy(&invalid).to_string(),
                    )?;
                    continue;
                }

                if flush {
                    let rest: Vec<u8> = std::mem::take(pending);
                    return emit_stream_text(
                        app,
                        request_id,
                        text,
                        String::from_utf8_lossy(&rest).to_string(),
                    );
                }

                return Ok(());
            }
        }
    }
}

fn build_headers(headers: Option<HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut header_map = HeaderMap::new();

    for (name, value) in headers.unwrap_or_default() {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Invalid request header name: {name}"))?;
        let header_value = HeaderValue::from_str(&value)
            .map_err(|_| format!("Invalid request header value for {name}"))?;
        header_map.insert(header_name, header_value);
    }

    Ok(header_map)
}

#[tauri::command]
pub async fn llm_proxy_request(request: LlmProxyRequest) -> Result<LlmProxyResponse, String> {
    let url = request.url.trim();
    if url.is_empty() {
        return Err("LLM request URL is empty".to_string());
    }

    let method = request
        .method
        .as_deref()
        .unwrap_or("POST")
        .trim()
        .to_ascii_uppercase();
    if method != "POST" && method != "GET" {
        return Err(format!("Unsupported LLM proxy method: {method}"));
    }

    let timeout_secs = request
        .timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);

    let mut builder = match method.as_str() {
        "GET" => HTTP_CLIENT.get(url),
        _ => HTTP_CLIENT.post(url),
    }
    .timeout(Duration::from_secs(timeout_secs))
    .headers(build_headers(request.headers)?);

    if let Some(body) = request.body {
        builder = builder.json(&body);
    }

    let response = builder
        .send()
        .await
        .map_err(|err| format!("LLM proxy request failed: {err}"))?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read LLM proxy response: {err}"))?;

    Ok(LlmProxyResponse {
        status: status.as_u16(),
        status_text,
        text,
    })
}

#[tauri::command]
pub async fn llm_proxy_stream(
    app: AppHandle,
    request: LlmProxyStreamRequest,
    request_id: Option<String>,
) -> Result<LlmProxyResponse, String> {
    let request_id = request_id.unwrap_or_else(|| request.request_id.clone());
    crate::task_cancel::cancellable(Some(request_id), llm_proxy_stream_inner(app, request)).await
}

async fn llm_proxy_stream_inner(
    app: AppHandle,
    request: LlmProxyStreamRequest,
) -> Result<LlmProxyResponse, String> {
    let url = request.url.trim();
    if url.is_empty() {
        return Err("LLM request URL is empty".to_string());
    }

    let method = request
        .method
        .as_deref()
        .unwrap_or("POST")
        .trim()
        .to_ascii_uppercase();
    if method != "POST" && method != "GET" {
        return Err(format!("Unsupported LLM proxy method: {method}"));
    }

    let timeout_secs = request
        .timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);

    let mut builder = match method.as_str() {
        "GET" => HTTP_CLIENT.get(url),
        _ => HTTP_CLIENT.post(url),
    }
    .headers(build_headers(request.headers)?);

    if let Some(body) = request.body {
        builder = builder.json(&body);
    }

    // No total timeout for streaming: a long completion legitimately runs
    // past any fixed deadline. timeout_secs acts as an idle-read timeout on
    // the initial response and each chunk instead.
    let idle_timeout = Duration::from_secs(timeout_secs);
    let mut response = tokio::time::timeout(idle_timeout, builder.send())
        .await
        .map_err(|_| format!("LLM proxy request timed out after {timeout_secs}s"))?
        .map_err(|err| format!("LLM proxy request failed: {err}"))?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();

    if !status.is_success() {
        let text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read LLM proxy response: {err}"))?;
        return Ok(LlmProxyResponse {
            status: status.as_u16(),
            status_text,
            text,
        });
    }

    let mut text = String::new();
    let mut pending_utf8 = Vec::new();
    loop {
        let chunk = tokio::time::timeout(idle_timeout, response.chunk())
            .await
            .map_err(|_| format!("LLM proxy stream idle for more than {timeout_secs}s"))?
            .map_err(|err| format!("Failed to read LLM proxy stream: {err}"))?;
        let Some(chunk) = chunk else { break };
        if chunk.is_empty() {
            continue;
        }
        pending_utf8.extend_from_slice(chunk.as_ref());
        emit_available_utf8(
            &app,
            &request.request_id,
            &mut text,
            &mut pending_utf8,
            false,
        )?;
    }
    emit_available_utf8(
        &app,
        &request.request_id,
        &mut text,
        &mut pending_utf8,
        true,
    )?;

    Ok(LlmProxyResponse {
        status: status.as_u16(),
        status_text,
        text,
    })
}
