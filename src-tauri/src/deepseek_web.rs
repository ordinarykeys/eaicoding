//! Direct Search / Fetch protocol adapted from Harness 0.2.1-rc.2 (MIT).
use crate::{deepseek_account, task_cancel};
use reqwest::header::HeaderMap;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::AppHandle;

const BASE: &str = "https://api.deepseek.com/v1/tools";
const MAX_BODY: usize = 4 * 1024 * 1024;

fn request_body(
    operation: &str,
    input: &str,
    count: Option<u32>,
    question: Option<&str>,
) -> Result<Value, String> {
    if input.trim().is_empty() || input.len() > 8192 {
        return Err("搜索词或网址为空或过长。".into());
    }
    match operation {
        "search" => {
            let count = count.unwrap_or(10);
            if !(1..=50).contains(&count) {
                return Err("搜索数量必须为 1–50。".into());
            }
            let mut body = json!({ "query": input, "count": count, "need_content": false });
            if let Some(question) = question {
                let question = question
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(128)
                    .collect::<String>();
                if !question.is_empty() {
                    body["ori_question"] = json!(question);
                }
            }
            Ok(body)
        }
        "fetch" => {
            let url = reqwest::Url::parse(input).map_err(|_| "网页地址无效。")?;
            if !matches!(url.scheme(), "https" | "http")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("只支持不带账号密码的 HTTP/HTTPS 网页地址。".into());
            }
            Ok(json!({ "url": input }))
        }
        _ => Err("未知网页操作。".into()),
    }
}

fn project_response(operation: &str, input: &str, value: Value) -> Result<Value, String> {
    let invalid = || "DeepSeek 网页接口返回格式无效，请重试。".to_string();
    if operation == "search" {
        let results = value["results"].as_array().ok_or_else(invalid)?;
        let mut sources = Vec::new();
        for item in results {
            let url = item["url"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?;
            let title = item["title"].as_str().ok_or_else(invalid)?;
            let snippet = item["snippet"].as_str().ok_or_else(invalid)?;
            if !item
                .get("date")
                .is_some_and(|d| d.is_null() || d.is_string())
            {
                return Err(invalid());
            }
            sources.push(json!({ "url": url, "title": title, "snippet": snippet, "publishedAt": item["date"] }));
        }
        Ok(json!({ "sources": sources, "truncated": false }))
    } else {
        let content = value["content"].as_str().ok_or_else(invalid)?;
        let truncated = content.chars().count() > 60000;
        Ok(
            json!({ "url": input, "content": content.chars().take(60000).collect::<String>(), "truncated": truncated }),
        )
    }
}

async fn dispatch(endpoint: &str, headers: HeaderMap, body: Value) -> Result<(u16, Value), String> {
    let mut response = deepseek_account::ACCOUNT_HTTP
        .post(endpoint)
        .headers(headers)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .header("user-agent", "EAiCoding")
        .json(&body)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|_| "DeepSeek 网页请求失败，请检查网络或稍后重试。")?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Ok((status, Value::Null));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "网页响应读取失败。")? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err("网页响应过大，请缩小搜索范围或更换页面。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((
        status,
        serde_json::from_slice(&bytes).map_err(|_| "DeepSeek 网页接口返回无效 JSON。")?,
    ))
}

#[tauri::command]
pub async fn deepseek_web_request(
    app: AppHandle,
    operation: String,
    input: String,
    count: Option<u32>,
    original_question: Option<String>,
    request_id: Option<String>,
) -> Result<Value, String> {
    task_cancel::cancellable(request_id, async {
        let body = request_body(&operation, &input, count, original_question.as_deref())?;
        let endpoint = format!("{BASE}/{operation}");
        let (headers, token) =
            deepseek_account::inference_headers(&app, &endpoint, HeaderMap::new()).await?;
        let (status, value) = dispatch(&endpoint, headers, body).await?;
        if status == 401 {
            deepseek_account::expire(&app, &token).await;
            return Err("DeepSeek 网页接口拒绝当前登录，请重新授权登录。".into());
        }
        if !(200..300).contains(&status) {
            return Err(format!(
                "DeepSeek 网页接口 HTTP {status}，请稍后重试；不要反复尝试同一失败请求。"
            ));
        }
        project_response(&operation, &input, value)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_and_projection() {
        let body = request_body("search", "易语言", Some(4), Some(&"中 ".repeat(200))).unwrap();
        assert_eq!(body["count"], 4);
        assert_eq!(body["need_content"], false);
        assert_eq!(body["ori_question"].as_str().unwrap().chars().count(), 128);
        assert!(request_body("search", "x", Some(51), None).is_err());
        assert!(request_body("fetch", "file:///c:/secret", None, None).is_err());
        assert!(request_body("fetch", "https://user:pass@example.com", None, None).is_err());
        assert!(request_body("unknown", "x", None, None).is_err());
        assert!(project_response(
            "search",
            "x",
            json!({"results":[{"url":"https://example.com","title":"t","snippet":"s","date":null}]})
        )
        .is_ok());
        assert!(project_response("search", "x", json!({"results":[{"url":"x"}]})).is_err());
        let result = project_response(
            "fetch",
            "https://example.com",
            json!({"content":"中".repeat(60001)}),
        )
        .unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["content"].as_str().unwrap().chars().count(), 60000);
    }
}
