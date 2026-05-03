use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteTextResult {
    pub path: String,
    pub bytes: usize,
}

fn should_use_crlf(path: &Path) -> bool {
    let path_text = path.to_string_lossy().to_ascii_lowercase();
    path_text.ends_with(".e.txt") || path_text.ends_with(".epl")
}

fn normalize_line_endings_for_path(path: &Path, content: String) -> String {
    if !should_use_crlf(path) {
        return content;
    }

    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    normalized.replace('\n', "\r\n")
}

#[tauri::command]
pub async fn write_text_file(
    file_path: String,
    content: String,
    encoding: Option<String>,
) -> Result<WriteTextResult, String> {
    let path = PathBuf::from(&file_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("创建目录失败：{}", err))?;
    }

    let content = normalize_line_endings_for_path(&path, content);
    let bytes = match encoding
        .as_deref()
        .unwrap_or("utf8")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "gbk" | "gb18030" => {
            let (encoded, _, _) = encoding_rs::GBK.encode(content.as_str());
            encoded.into_owned()
        }
        _ => content.into_bytes(),
    };

    let byte_count = bytes.len();
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|err| format!("写入文件失败：{}", err))?;

    Ok(WriteTextResult {
        path: path.to_string_lossy().to_string(),
        bytes: byte_count,
    })
}

// ---------------------------------------------------------------------------
// read_text_file_for_agent — 供 Agent 工具读取本地文件内容
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadFileResult {
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub bytes: usize,
    pub truncated: bool,
}

/// Read a local file and return its content as UTF-8 string.
/// Automatically tries UTF-8 first, falls back to GBK (common for 易语言 files).
/// Truncates at `max_chars` (default 12000) to protect context window.
#[tauri::command]
pub async fn read_text_file_for_agent(
    file_path: String,
    max_chars: Option<usize>,
) -> Result<ReadFileResult, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在：{}", file_path));
    }

    let raw = tokio::fs::read(&path)
        .await
        .map_err(|err| format!("读取文件失败：{}", err))?;

    let byte_count = raw.len();
    let (content, detected_encoding) = match String::from_utf8(raw.clone()) {
        Ok(s) => (s, "UTF-8".to_string()),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::GBK.decode(&raw);
            (decoded.to_string(), "GBK".to_string())
        }
    };

    let limit = max_chars.unwrap_or(12000);
    let truncated = content.chars().count() > limit;
    let content = if truncated {
        content.chars().take(limit).collect::<String>()
            + &format!("\n\n... [已截断，原始文件 {} 字节] ...", byte_count)
    } else {
        content
    };

    Ok(ReadFileResult {
        path: path.to_string_lossy().to_string(),
        content,
        encoding: detected_encoding,
        bytes: byte_count,
        truncated,
    })
}
