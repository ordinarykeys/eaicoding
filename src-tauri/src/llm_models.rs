use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION},
    Client,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, time::Duration};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub owned_by: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FetchModelsResponse {
    pub provider: String,
    pub url: String,
    pub models: Vec<FetchedModel>,
}

fn models_url(base: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base.trim()).map_err(|_| "DeepSeek API 地址无效")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("API 地址必须使用 http 或 https".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    let path = path.strip_suffix("/chat/completions").unwrap_or(&path);
    let path = if path.ends_with("/models") {
        path.to_string()
    } else {
        format!("{}/models", path)
    };
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn parse_models(payload: &Value) -> Result<Vec<FetchedModel>, String> {
    let entries = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or("DeepSeek 模型列表缺少 data 数组")?;
    let mut seen = HashSet::new();
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            Some(FetchedModel {
                id: id.to_string(),
                owned_by: entry
                    .get("owned_by")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn fetch_llm_models(
    provider: String,
    base_url: Option<String>,
    api_key: String,
) -> Result<FetchModelsResponse, String> {
    if provider != "deepseek" {
        return Err("仅支持 DeepSeek".into());
    }
    if api_key.trim().is_empty() {
        return Err("请填写 DeepSeek API Key".into());
    }
    let url = models_url(
        base_url
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("https://api.deepseek.com"),
    )?;
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key.trim()))
            .map_err(|_| "API Key 格式无效")?,
    );
    let response = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("DeepSeek 模型列表请求失败：{}", e))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "DeepSeek HTTP {}：{}",
            status.as_u16(),
            text.chars().take(512).collect::<String>()
        ));
    }
    let payload = serde_json::from_str(&text).map_err(|e| format!("模型列表 JSON 无效：{}", e))?;
    Ok(FetchModelsResponse {
        provider,
        url,
        models: parse_models(&payload)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deepseek_model_urls() {
        for (base, expected) in [
            (
                "https://api.deepseek.com",
                "https://api.deepseek.com/models",
            ),
            (
                "https://api.deepseek.com/v1/",
                "https://api.deepseek.com/v1/models",
            ),
            (
                "https://api.deepseek.com/v1/chat/completions",
                "https://api.deepseek.com/v1/models",
            ),
        ] {
            assert_eq!(models_url(base).unwrap(), expected);
        }
        assert!(models_url("not a url").is_err());
    }
    #[test]
    fn deepseek_models_deduplicate() {
        let models = parse_models(&serde_json::json!({"data":[{"id":"deepseek-chat","owned_by":"deepseek"},{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]})).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].id, "deepseek-reasoner");
    }
}
