use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

static FILE_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn code_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn decode_source(bytes: &[u8]) -> (String, String) {
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => (text, "UTF-8".into()),
        Err(_) => (encoding_rs::GBK.decode(bytes).0.to_string(), "GBK".into()),
    }
}

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
    expected_hash: Option<String>,
) -> Result<WriteTextResult, String> {
    let _lock = FILE_WRITE_LOCK.lock().await;
    if let Some(expected) = expected_hash {
        let current = tokio::fs::read(&file_path)
            .await
            .map_err(|e| e.to_string())?;
        if code_hash(&current) != expected {
            return Err("源码已变化，请重新 read_file 后再写入（code_hash 不匹配）".into());
        }
    }
    write_text_file_inner(file_path, content, encoding).await
}

async fn write_text_file_inner(
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
            let (encoded, _, had_errors) = encoding_rs::GBK.encode(content.as_str());
            if had_errors {
                return Err("源码包含 GBK 无法表示的字符，请使用 UTF-8 编码".into());
            }
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
    pub code_hash: String,
    pub start_char: usize,
    pub returned_chars: usize,
    pub total_chars: usize,
    pub start_line: usize,
    pub total_lines: usize,
    pub next_start_char: Option<usize>,
    pub is_partial: bool,
}

/// Read a local file and return its content as UTF-8 string.
/// Automatically tries UTF-8 first, falls back to GBK (common for 易语言 files).
/// Truncates at `max_chars` (default 12000) to protect context window.
#[tauri::command]
pub async fn read_text_file_for_agent(
    file_path: String,
    max_chars: Option<usize>,
    start_char: Option<usize>,
    start_line: Option<usize>,
    max_lines: Option<usize>,
) -> Result<ReadFileResult, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在：{}", file_path));
    }

    let raw = tokio::fs::read(&path)
        .await
        .map_err(|err| format!("读取文件失败：{}", err))?;

    let byte_count = raw.len();
    let hash = code_hash(&raw);
    let (content, detected_encoding) = decode_source(&raw);
    let page = source_page(&content, max_chars, start_char, start_line, max_lines)?;

    Ok(ReadFileResult {
        path: path.to_string_lossy().to_string(),
        content: page.content,
        encoding: detected_encoding,
        bytes: byte_count,
        truncated: page.next_start_char.is_some(),
        code_hash: hash,
        start_char: page.start_char,
        returned_chars: page.returned_chars,
        total_chars: page.total_chars,
        start_line: page.start_line,
        total_lines: page.total_lines,
        next_start_char: page.next_start_char,
        is_partial: page.start_char > 0 || page.next_start_char.is_some(),
    })
}

struct SourcePage {
    content: String,
    start_char: usize,
    returned_chars: usize,
    total_chars: usize,
    start_line: usize,
    total_lines: usize,
    next_start_char: Option<usize>,
}

fn source_page(
    source: &str,
    max_chars: Option<usize>,
    start_char: Option<usize>,
    start_line: Option<usize>,
    max_lines: Option<usize>,
) -> Result<SourcePage, String> {
    let chars: Vec<char> = source.chars().collect();
    let total_chars = chars.len();
    let start = if let Some(offset) = start_char {
        offset
    } else {
        let wanted = start_line.unwrap_or(1);
        if wanted == 0 {
            return Err("start_line 从 1 开始".into());
        }
        if wanted == 1 {
            0
        } else {
            chars
                .iter()
                .enumerate()
                .filter(|(_, c)| **c == '\n')
                .nth(wanted - 2)
                .map(|(i, _)| i + 1)
                .ok_or("start_line 超出文件范围")?
        }
    };
    if start > total_chars {
        return Err("start_char 超出文件范围".into());
    }
    let mut end = start
        .saturating_add(max_chars.unwrap_or(12000).clamp(1, 8_000_000))
        .min(total_chars);
    if let Some(lines) = max_lines {
        if lines == 0 {
            return Err("max_lines 必须大于 0".into());
        }
        if let Some((i, _)) = chars[start..end]
            .iter()
            .enumerate()
            .filter(|(_, c)| **c == '\n')
            .nth(lines - 1)
        {
            end = start + i + 1;
        }
    }
    Ok(SourcePage {
        content: chars[start..end].iter().collect(),
        start_char: start,
        returned_chars: end - start,
        total_chars,
        start_line: 1 + chars[..start].iter().filter(|c| **c == '\n').count(),
        total_lines: 1 + chars.iter().filter(|c| **c == '\n').count(),
        next_start_char: (end < total_chars).then_some(end),
    })
}

#[derive(Serialize)]
pub struct TextPatchResult {
    path: String,
    changed: bool,
    replacements: usize,
    bytes: usize,
    code_hash: String,
}

fn replace_unique(source: &str, search: &str, replacement: &str) -> Result<String, String> {
    if search.is_empty() {
        return Err("SEARCH 不能为空".into());
    }
    let normalize = |s: &str| s.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalize(source);
    let search = normalize(search);
    if normalized.match_indices(&search).count() != 1 {
        return Err("SEARCH 未匹配或匹配多处，请重新读取并扩大上下文".into());
    }
    let result = normalized.replacen(&search, &normalize(replacement), 1);
    Ok(if source.contains("\r\n") {
        result.replace('\n', "\r\n")
    } else {
        result
    })
}

#[tauri::command]
pub async fn apply_text_patch_for_agent(
    file_path: String,
    search: String,
    replace: String,
    expected_hash: String,
    encoding: Option<String>,
) -> Result<TextPatchResult, String> {
    let _lock = FILE_WRITE_LOCK.lock().await;
    let raw = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("读取源码失败：{e}"))?;
    if code_hash(&raw) != expected_hash {
        return Err("源码已变化，请重新 read_file 后再修改（code_hash 不匹配）".into());
    }
    let (source, detected_encoding) = decode_source(&raw);
    let content = replace_unique(&source, &search, &replace)?;
    let changed = content != source;
    let written =
        write_text_file_inner(file_path, content, encoding.or(Some(detected_encoding))).await?;
    let updated = tokio::fs::read(&written.path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TextPatchResult {
        path: written.path,
        changed,
        replacements: 1,
        bytes: written.bytes,
        code_hash: code_hash(&updated),
    })
}

#[cfg(test)]
mod source_tests {
    use super::*;
    #[test]
    fn paging_preserves_all_chinese_source_and_line_numbers() {
        let source = "首行\r\n".repeat(5000) + "尾部业务\n";
        let mut output = String::new();
        let mut offset = 0;
        loop {
            let page = source_page(&source, Some(137), Some(offset), None, None).unwrap();
            assert_eq!(
                page.start_line,
                1 + output.chars().filter(|c| *c == '\n').count()
            );
            output.push_str(&page.content);
            match page.next_start_char {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(output, source);
        let page = source_page(&source, None, None, Some(5001), Some(1)).unwrap();
        assert_eq!(page.content, "尾部业务\n");
    }
    #[test]
    fn large_file_patch_preserves_unrelated_source_and_crlf() {
        let source = "原有代码\r\n".repeat(5000) + "目标 ＝ 1\r\n";
        let result = replace_unique(&source, "目标 ＝ 1\n", "目标 ＝ 2\n").unwrap();
        assert!(result.ends_with("目标 ＝ 2\r\n"));
        assert_eq!(
            source[..source.find("目标").unwrap()],
            result[..result.find("目标").unwrap()]
        );
        assert!(replace_unique("重复重复", "重复", "修改").is_err());
    }
    #[test]
    fn stale_hash_rejects_patch_and_whole_file_write() {
        tauri::async_runtime::block_on(async {
            let path = std::env::temp_dir()
                .join(format!("eaicoding-cas-{:016x}.txt", rand::random::<u64>()));
            let name = path.to_string_lossy().to_string();
            fs_write(&path, "原始\n目标 ＝ 1");
            let page = read_text_file_for_agent(name.clone(), Some(4), None, None, None)
                .await
                .unwrap();
            fs_write(&path, "外部编辑\n目标 ＝ 1");
            assert!(apply_text_patch_for_agent(
                name.clone(),
                "目标 ＝ 1".into(),
                "目标 ＝ 2".into(),
                page.code_hash.clone(),
                None
            )
            .await
            .is_err());
            assert!(
                write_text_file(name.clone(), "覆盖".into(), None, Some(page.code_hash))
                    .await
                    .is_err()
            );
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                "外部编辑\n目标 ＝ 1"
            );
            std::fs::remove_file(path).unwrap();
        });
    }
    fn fs_write(path: &Path, content: &str) {
        std::fs::write(path, content).unwrap();
    }
}

// ---------------------------------------------------------------------------
// copy_user_module_to_local — 把用户挑选的 .ec 拷贝到 app_local_data，作为
// 用户模块库（settings → 知识库）持久化的真实落盘文件。返回最终路径。
// ---------------------------------------------------------------------------

const USER_MODULE_DIR: &str = "user-modules";

/// Copy a user-selected .ec into `app_local_data/user-modules/<module_id>.ec`.
/// The module library uses this stable path for re-parsing later, even if the
/// user moves or deletes the original.
#[derive(serde::Serialize)]
pub struct CopiedUserModule {
    stored_path: String,
    bytes: u64,
}

#[tauri::command]
pub async fn copy_user_module_to_local(
    app: AppHandle,
    source_path: String,
    module_id: String,
) -> Result<CopiedUserModule, String> {
    let trimmed_id = module_id.trim();
    if trimmed_id.is_empty() {
        return Err("模块 ID 不能为空".to_string());
    }
    if !trimmed_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("模块 ID 仅允许字母、数字、'-'、'_'".to_string());
    }

    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("源文件不存在：{}", source_path));
    }

    let extension = source
        .extension()
        .map(|item| item.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if extension != "ec" {
        return Err(format!(
            "仅支持上传 .ec 模块文件（当前扩展名：{}）",
            if extension.is_empty() {
                "无".to_string()
            } else {
                extension
            }
        ));
    }

    let app_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败：{}", err))?;
    let module_dir = app_dir.join(USER_MODULE_DIR);
    tokio::fs::create_dir_all(&module_dir)
        .await
        .map_err(|err| format!("创建用户模块目录失败：{}", err))?;

    let target = module_dir.join(format!("{}.ec", trimmed_id));
    let bytes = tokio::fs::copy(&source, &target)
        .await
        .map_err(|err| format!("复制 .ec 文件失败：{}", err))?;

    Ok(CopiedUserModule {
        stored_path: target.to_string_lossy().to_string(),
        bytes,
    })
}
