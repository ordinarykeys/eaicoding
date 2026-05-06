use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;

const OPENAI_PROVIDER: &str = "openai";
const ANTHROPIC_PROVIDER: &str = "anthropic";
const ANTHROPIC_PROVIDER_ALIAS: &str = "provider";
const GEMINI_PROVIDER: &str = "gemini";

const FETCH_TIMEOUT_SECS: u64 = 15;
const ERROR_BODY_MAX_CHARS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchModelsResponse {
    pub provider: String,
    pub url: String,
    pub models: Vec<FetchedModel>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HeaderStrategy {
    Bearer,
    AnthropicKey,
    GeminiKey,
}

impl HeaderStrategy {
    fn label(self) -> &'static str {
        match self {
            HeaderStrategy::Bearer => "bearer",
            HeaderStrategy::AnthropicKey => "anthropic-key",
            HeaderStrategy::GeminiKey => "gemini-key",
        }
    }
}

fn normalize_provider(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        OPENAI_PROVIDER => Some(OPENAI_PROVIDER),
        ANTHROPIC_PROVIDER | ANTHROPIC_PROVIDER_ALIAS => Some(ANTHROPIC_PROVIDER),
        GEMINI_PROVIDER => Some(GEMINI_PROVIDER),
        _ => None,
    }
}

fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

fn provider_default_base_url(provider: &str) -> &'static str {
    match provider {
        ANTHROPIC_PROVIDER => "https://api.anthropic.com/v1",
        GEMINI_PROVIDER => "https://generativelanguage.googleapis.com",
        _ => "https://api.openai.com",
    }
}

fn truncate_body(body: String) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= ERROR_BODY_MAX_CHARS {
        trimmed.to_string()
    } else {
        let mut short: String = trimmed.chars().take(ERROR_BODY_MAX_CHARS).collect();
        short.push_str("...");
        short
    }
}

fn is_likely_full_url(provider: &str, base_url: &str) -> bool {
    let lowered = base_url.to_ascii_lowercase();
    match provider {
        OPENAI_PROVIDER => {
            lowered.contains("/chat/completions")
                || lowered.contains("/responses")
                || lowered.contains("/completions")
        }
        ANTHROPIC_PROVIDER => lowered.contains("/messages"),
        GEMINI_PROVIDER => {
            lowered.contains(":generatecontent")
                || lowered.contains(":streamgeneratecontent")
                || lowered.contains("/models/")
        }
        _ => false,
    }
}

fn derive_openai_compat_model_url_from_full_url(url: &str) -> Option<String> {
    let normalized = normalize_base_url(url);

    if let Some(index) = normalized.find("/v1/") {
        return Some(format!("{}/v1/models", &normalized[..index]));
    }

    if let Some(index) = normalized.find("/models/") {
        let prefix = &normalized[..index];
        if prefix.ends_with("/v1") {
            return Some(format!("{prefix}/models"));
        }
    }

    if let Some(index) = normalized.rfind('/') {
        let root = &normalized[..index];
        if root.contains("://") && root.len() > root.find("://").unwrap_or(0) + 3 {
            if root.ends_with("/v1") {
                return Some(format!("{root}/models"));
            } else {
                return Some(format!("{root}/v1/models"));
            }
        }
    }

    None
}

fn build_openai_compatible_model_url(base_url: &str) -> Result<String, String> {
    let normalized = normalize_base_url(base_url);
    if normalized.is_empty() {
        return Err("Please provide a base URL".to_string());
    }

    if normalized.ends_with("/models") {
        return Ok(normalized);
    }

    if is_likely_full_url(OPENAI_PROVIDER, &normalized)
        || is_likely_full_url(ANTHROPIC_PROVIDER, &normalized)
    {
        if let Some(derived) = derive_openai_compat_model_url_from_full_url(&normalized) {
            return Ok(derived);
        }
    }

    if normalized.ends_with("/v1") {
        Ok(format!("{normalized}/models"))
    } else {
        Ok(format!("{normalized}/v1/models"))
    }
}

fn derive_gemini_model_url_from_full_url(url: &str) -> Option<String> {
    let normalized = normalize_base_url(url);

    if let Some(index) = normalized.find("/models/") {
        let prefix = &normalized[..index];
        if prefix.ends_with("/v1beta") || prefix.ends_with("/v1") {
            return Some(format!("{prefix}/models"));
        }
    }

    if let Some(index) = normalized.find("/v1beta/") {
        return Some(format!("{}/v1beta/models", &normalized[..index]));
    }
    if let Some(index) = normalized.find("/v1/") {
        return Some(format!("{}/v1/models", &normalized[..index]));
    }

    if let Some(index) = normalized.rfind('/') {
        let root = &normalized[..index];
        if root.contains("://") && root.len() > root.find("://").unwrap_or(0) + 3 {
            if root.ends_with("/v1beta") || root.ends_with("/v1") {
                return Some(format!("{root}/models"));
            } else {
                return Some(format!("{root}/v1beta/models"));
            }
        }
    }

    None
}

fn build_gemini_model_url(base_url: &str) -> Result<String, String> {
    let normalized = normalize_base_url(base_url);
    if normalized.is_empty() {
        return Err("Please provide a base URL".to_string());
    }

    if normalized.ends_with("/models") {
        return Ok(normalized);
    }

    if is_likely_full_url(GEMINI_PROVIDER, &normalized) {
        if let Some(derived) = derive_gemini_model_url_from_full_url(&normalized) {
            return Ok(derived);
        }
    }

    if normalized.ends_with("/v1beta") || normalized.ends_with("/v1") {
        Ok(format!("{normalized}/models"))
    } else {
        Ok(format!("{normalized}/v1beta/models"))
    }
}

fn model_list_url(provider: &str, base_url: &str) -> Result<String, String> {
    match provider {
        OPENAI_PROVIDER | ANTHROPIC_PROVIDER => build_openai_compatible_model_url(base_url),
        GEMINI_PROVIDER => build_gemini_model_url(base_url),
        _ => Err("Unsupported LLM provider".to_string()),
    }
}

fn build_headers(api_key: &str, strategy: HeaderStrategy) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    match strategy {
        HeaderStrategy::Bearer => {
            headers.insert(
                "authorization",
                HeaderValue::from_str(&format!("Bearer {api_key}"))
                    .map_err(|_| "API key contains invalid characters".to_string())?,
            );
        }
        HeaderStrategy::AnthropicKey => {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(api_key)
                    .map_err(|_| "API key contains invalid characters".to_string())?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
        HeaderStrategy::GeminiKey => {
            headers.insert(
                "x-goog-api-key",
                HeaderValue::from_str(api_key)
                    .map_err(|_| "API key contains invalid characters".to_string())?,
            );
        }
    }

    Ok(headers)
}

fn header_strategy(provider: &str) -> HeaderStrategy {
    match provider {
        ANTHROPIC_PROVIDER => HeaderStrategy::AnthropicKey,
        GEMINI_PROVIDER => HeaderStrategy::GeminiKey,
        _ => HeaderStrategy::Bearer,
    }
}

fn parse_openai_models(payload: &Value) -> Result<Vec<FetchedModel>, String> {
    let raw_items = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Model list response format is invalid".to_string())?;

    let mut seen = HashSet::new();
    let mut models = Vec::new();

    for item in raw_items {
        let Some(object) = item.as_object() else {
            continue;
        };

        let model_id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if model_id.is_empty() || !seen.insert(model_id.clone()) {
            continue;
        }

        let owned_by = object
            .get("owned_by")
            .or_else(|| object.get("ownedBy"))
            .and_then(Value::as_str)
            .map(str::to_string);

        models.push(FetchedModel {
            id: model_id,
            owned_by,
        });
    }

    Ok(models)
}

fn parse_gemini_models(payload: &Value) -> Result<Vec<FetchedModel>, String> {
    if payload.get("data").and_then(Value::as_array).is_some() {
        return parse_openai_models(payload);
    }

    let raw_items = payload
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "Model list response format is invalid".to_string())?;

    let mut seen = HashSet::new();
    let mut models = Vec::new();

    for item in raw_items {
        let Some(object) = item.as_object() else {
            continue;
        };

        if let Some(methods) = object
            .get("supportedGenerationMethods")
            .and_then(Value::as_array)
        {
            let can_generate = methods.iter().any(|method| {
                matches!(
                    method.as_str(),
                    Some("generateContent") | Some("streamGenerateContent")
                )
            });
            if !can_generate {
                continue;
            }
        }

        let model_id = object
            .get("name")
            .or_else(|| object.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .trim_start_matches("models/")
            .to_string();
        if model_id.is_empty() || !seen.insert(model_id.clone()) {
            continue;
        }

        models.push(FetchedModel {
            id: model_id,
            owned_by: Some("Google".to_string()),
        });
    }

    Ok(models)
}

fn parse_model_list(provider: &str, payload: &Value) -> Result<Vec<FetchedModel>, String> {
    match provider {
        GEMINI_PROVIDER => parse_gemini_models(payload),
        _ => parse_openai_models(payload),
    }
}

async fn try_fetch_models_once(
    client: &Client,
    provider: &str,
    url: &str,
    api_key: &str,
    strategy: HeaderStrategy,
) -> Result<Vec<FetchedModel>, String> {
    let response = client
        .get(url)
        .headers(build_headers(api_key, strategy)?)
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|err| {
            if err.is_timeout() {
                "Model list request timed out".to_string()
            } else {
                format!("Model list request failed: {err}")
            }
        })?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read model list response: {err}"))?;

    if !status.is_success() {
        let detail = truncate_body(text);
        return Err(format!(
            "[{}] HTTP {} {}",
            strategy.label(),
            status.as_u16(),
            detail
        ));
    }

    let payload = serde_json::from_str::<Value>(&text)
        .map_err(|err| format!("[{}] JSON {}: {}", strategy.label(), err, truncate_body(text)))?;
    parse_model_list(provider, &payload)
}

#[tauri::command]
pub async fn fetch_llm_models(
    provider: String,
    base_url: Option<String>,
    api_key: String,
) -> Result<FetchModelsResponse, String> {
    let original_provider = provider.trim().to_ascii_lowercase();
    let provider =
        normalize_provider(&original_provider).ok_or_else(|| "Unsupported LLM provider".to_string())?;

    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("Please provide an API key".to_string());
    }

    let base_url = base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| provider_default_base_url(provider));
    let url = model_list_url(provider, base_url)?;
    let strategy = header_strategy(provider);

    let client = Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("Failed to build model list client: {err}"))?;

    match try_fetch_models_once(&client, provider, &url, api_key, strategy).await {
        Ok(models) => Ok(FetchModelsResponse {
            provider: provider.to_string(),
            url,
            models,
        }),
        Err(err) => {
            Err(format!("Model list request failed: {url} -> {err}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn provider_alias_maps_to_anthropic() {
        assert_eq!(normalize_provider("provider"), Some(ANTHROPIC_PROVIDER));
        assert_eq!(normalize_provider("anthropic"), Some(ANTHROPIC_PROVIDER));
        assert_eq!(normalize_provider("openai"), Some(OPENAI_PROVIDER));
    }

    #[test]
    fn openai_candidates_use_v1_models() {
        let url = build_openai_compatible_model_url("https://api.openai.com/v1").unwrap();
        assert_eq!(url, "https://api.openai.com/v1/models");
    }

    #[test]
    fn openai_candidates_from_full_chat_url() {
        let url =
            build_openai_compatible_model_url("https://gateway.example.com/v1/chat/completions")
                .unwrap();
        assert_eq!(url, "https://gateway.example.com/v1/models");
    }

    #[test]
    fn gemini_candidates_default_to_v1beta_models() {
        let url =
            build_gemini_model_url("https://generativelanguage.googleapis.com").unwrap();
        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
    }

    #[test]
    fn gemini_candidates_from_full_generate_url() {
        let url = build_gemini_model_url(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
        )
        .unwrap();
        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
    }

    #[test]
    fn parse_openai_models_response() {
        let payload = json!({
            "data": [
                { "id": "gpt-5.4", "owned_by": "openai" },
                { "id": "gpt-5.4-mini" }
            ]
        });
        let models = parse_model_list(OPENAI_PROVIDER, &payload).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-5.4");
        assert_eq!(models[0].owned_by.as_deref(), Some("openai"));
        assert_eq!(models[1].id, "gpt-5.4-mini");
    }

    #[test]
    fn parse_gemini_models_response() {
        let payload = json!({
            "models": [
                {
                    "name": "models/gemini-2.5-pro",
                    "supportedGenerationMethods": ["generateContent"]
                },
                {
                    "name": "models/text-embedding-004",
                    "supportedGenerationMethods": ["embedContent"]
                }
            ]
        });
        let models = parse_model_list(GEMINI_PROVIDER, &payload).unwrap();
        assert_eq!(
            models,
            vec![FetchedModel {
                id: "gemini-2.5-pro".to_string(),
                owned_by: Some("Google".to_string()),
            }]
        );
    }

}
