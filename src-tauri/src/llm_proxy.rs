use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

const DEFAULT_TIMEOUT_SECS: u64 = 120;
const MAX_TIMEOUT_SECS: u64 = 300;

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

    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|err| format!("Failed to build LLM proxy client: {err}"))?;

    let mut builder = match method.as_str() {
        "GET" => client.get(url),
        _ => client.post(url),
    }
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
