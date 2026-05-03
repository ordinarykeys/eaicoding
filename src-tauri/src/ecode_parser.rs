use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::eagent_tools::detect_eagent_tools;

// ---------------------------------------------------------------------------
// Cross-platform helper: hide the console window on Windows only.
// tokio::process::Command exposes .creation_flags() on Windows when the
// std::os::windows::process::CommandExt trait is in scope, but we wrap it
// here so the rest of the code compiles cleanly on all platforms.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn hide_window(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    cmd.creation_flags(0x08000000) // CREATE_NO_WINDOW
}

#[cfg(not(target_os = "windows"))]
fn hide_window(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    cmd
}

fn decode_tool_output(bytes: &[u8]) -> String {
    decode_tool_output_with_preference(bytes, false)
}

fn decode_tool_output_with_preference(bytes: &[u8], prefer_gbk: bool) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Some(text) = decode_utf16ish_tool_output(bytes) {
        return text;
    }

    if prefer_gbk {
        let (text, _, had_errors) = encoding_rs::GBK.decode(bytes);
        if !had_errors {
            return text.to_string();
        }
    }

    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => text,
        Err(_) => encoding_rs::GBK.decode(bytes).0.to_string(),
    }
}

fn decode_utf16ish_tool_output(bytes: &[u8]) -> Option<String> {
    let (body, little_endian) = if bytes.starts_with(&[0xff, 0xfe]) {
        (&bytes[2..], true)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        (&bytes[2..], false)
    } else {
        let sample_len = bytes.len().min(512);
        if sample_len < 8 {
            return None;
        }
        let even_nuls = bytes[..sample_len]
            .iter()
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count();
        let odd_nuls = bytes[..sample_len]
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count();
        let pairs = sample_len / 2;
        if odd_nuls * 2 > pairs {
            (bytes, true)
        } else if even_nuls * 2 > pairs {
            (bytes, false)
        } else {
            return None;
        }
    };

    let words: Vec<u16> = body
        .chunks_exact(2)
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect();

    String::from_utf16(&words).ok()
}

fn join_non_empty(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("创建目录失败 {}：{}", parent.display(), err))?;
    }
    Ok(())
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|err| format!("创建目录失败 {}：{}", to.display(), err))?;
    for entry in
        fs::read_dir(from).map_err(|err| format!("读取目录失败 {}：{}", from.display(), err))?
    {
        let entry = entry.map_err(|err| format!("读取目录项失败：{}", err))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir_all(&source, &target)?;
        } else {
            fs::copy(&source, &target).map_err(|err| {
                format!(
                    "复制文件失败 {} -> {}：{}",
                    source.display(),
                    target.display(),
                    err
                )
            })?;
        }
    }
    Ok(())
}

fn list_files(root: &Path, limit: usize) -> Vec<String> {
    fn visit(path: &Path, out: &mut Vec<String>, limit: usize) {
        if out.len() >= limit {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit(&path, out, limit);
            } else {
                out.push(path.to_string_lossy().to_string());
            }
            if out.len() >= limit {
                break;
            }
        }
    }

    let mut files = Vec::new();
    visit(root, &mut files, limit);
    files
}

fn wait_for_path(path: &Path, timeout: Duration, poll_interval: Duration) -> bool {
    let started = Instant::now();

    loop {
        if path.exists() {
            return true;
        }

        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return false;
        }

        thread::sleep(poll_interval.min(timeout.saturating_sub(elapsed)));
    }
}

fn stage_module_dependencies(e_root: &Path, module_paths: &[String]) -> Result<Vec<String>, String> {
    if module_paths.is_empty() {
        return Ok(Vec::new());
    }

    let ecom_dir = e_root.join("ecom");
    fs::create_dir_all(&ecom_dir)
        .map_err(|err| format!("创建模块目录失败 {}：{}", ecom_dir.display(), err))?;

    let mut staged = Vec::new();
    for module_path in module_paths {
        let source = PathBuf::from(module_path);
        if !source.exists() {
            return Err(format!("模块文件不存在：{}", source.display()));
        }
        let file_name = source
            .file_name()
            .ok_or_else(|| format!("无法识别模块文件名：{}", source.display()))?;
        let target = ecom_dir.join(file_name);
        fs::copy(&source, &target).map_err(|err| {
            format!(
                "复制模块失败 {} -> {}：{}",
                source.display(),
                target.display(),
                err
            )
        })?;
        staged.push(target.to_string_lossy().to_string());
    }

    Ok(staged)
}

fn module_display_name(source: &Path) -> String {
    let stem = source
        .file_stem()
        .map(|item| item.to_string_lossy().to_string())
        .unwrap_or_else(|| "模块".to_string());

    if stem.contains("精易") {
        "精易模块".to_string()
    } else {
        stem
    }
}

fn escape_json_string(value: &str) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "\"\"".to_string())
        .trim_matches('"')
        .to_string()
}

fn write_ecode_module_refs(ecode_dir: &Path, module_paths: &[String]) -> Result<Vec<String>, String> {
    if module_paths.is_empty() {
        return Ok(Vec::new());
    }

    let module_dir = ecode_dir.join("模块");
    fs::create_dir_all(&module_dir)
        .map_err(|err| format!("创建模块引用目录失败 {}：{}", module_dir.display(), err))?;

    let mut refs = Vec::new();
    for module_path in module_paths {
        let source = PathBuf::from(module_path);
        if !source.exists() {
            return Err(format!("模块文件不存在：{}", source.display()));
        }

        let display_name = module_display_name(&source);
        let desc_path = module_dir.join(format!("{}.desc.json", display_name));
        let content = format!(
            "{{\n    \"Source\": \"{}\"\n}}\n",
            escape_json_string(&source.to_string_lossy())
        );
        fs::write(&desc_path, content)
            .map_err(|err| format!("写入模块引用失败 {}：{}", desc_path.display(), err))?;
        refs.push(desc_path.to_string_lossy().to_string());
    }

    Ok(refs)
}

fn stage_local_ecom_modules(e_root: &Path, easy_language_root: Option<&str>) -> Result<Vec<String>, String> {
    let Some(root) = easy_language_root.map(str::trim).filter(|item| !item.is_empty()) else {
        return Ok(Vec::new());
    };
    let source_ecom = PathBuf::from(root).join("ecom");
    if !source_ecom.exists() {
        return Ok(Vec::new());
    }

    let target_ecom = e_root.join("ecom");
    fs::create_dir_all(&target_ecom)
        .map_err(|err| format!("创建模块目录失败 {}：{}", target_ecom.display(), err))?;

    let source_canonical = source_ecom.canonicalize().ok();
    let target_canonical = target_ecom.canonicalize().ok();
    if source_canonical.is_some() && source_canonical == target_canonical {
        return Ok(Vec::new());
    }

    let mut staged = Vec::new();
    for entry in fs::read_dir(&source_ecom)
        .map_err(|err| format!("读取本机模块目录失败 {}：{}", source_ecom.display(), err))?
        .flatten()
    {
        let source = entry.path();
        if !source
            .extension()
            .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("ec"))
            .unwrap_or(false)
        {
            continue;
        }
        let target = target_ecom.join(entry.file_name());
        fs::copy(&source, &target).map_err(|err| {
            format!(
                "同步本机模块失败 {} -> {}：{}",
                source.display(),
                target.display(),
                err
            )
        })?;
        staged.push(target.to_string_lossy().to_string());
    }

    Ok(staged)
}

fn normalize_e_code_for_template(code: &str) -> String {
    let trimmed = code.trim();
    if trimmed.contains(".版本") && trimmed.contains(".程序集") {
        return trimmed.to_string();
    }

    let body = trimmed
        .lines()
        .map(|line| {
            if line.trim().is_empty() {
                String::new()
            } else {
                format!("    {}", line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        ".版本 2\n\n.程序集 程序集1\n\n.子程序 _启动子程序, 整数型, , 本子程序在程序启动后最先执行\n\n{}\n\n    返回 (0)",
        body
    )
}

fn default_generated_efile_path(app: &AppHandle, timestamp: u128) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败：{}", err))?
        .join("auto-runs")
        .join(format!("run-{}", timestamp))
        .join("generated.e"))
}

fn default_exported_ecode_dir(app: &AppHandle, source: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("系统时间异常：{}", err))?
        .as_millis();
    let stem = source
        .file_stem()
        .map(|item| item.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());

    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败：{}", err))?
        .join("ecode")
        .join(format!("{}-{}", stem, timestamp)))
}

// ---------------------------------------------------------------------------
// parse_efile
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct ParseResult {
    pub success: bool,
    pub output: String,
    pub summary: Option<serde_json::Value>,
    pub error: Option<String>,
}

/// Parse an .e or .ec file using eparser32.exe + ECodeParser.dll
///
/// Usage: `eparser32.exe <ECodeParser.dll> <eroot> <input.e|.ec> <output.txt>`
#[tauri::command]
pub async fn parse_efile(app: AppHandle, file_path: String) -> Result<ParseResult, String> {
    let detected = detect_eagent_tools(app);
    let exe = detected
        .eparser_exe
        .path
        .ok_or_else(|| "内置 eparser32.exe 缺失，请重新安装应用".to_string())?;
    let dll = detected
        .eparser_dll
        .path
        .ok_or_else(|| "内置 ECodeParser.dll 缺失，请重新安装应用".to_string())?;
    let root = detected
        .e_root
        .path
        .ok_or_else(|| "内置易语言运行环境缺失或解压失败，请重新安装应用".to_string())?;

    let input = PathBuf::from(&file_path);
    if !input.exists() {
        return Err(format!("Input file not found: {}", file_path));
    }

    // Write parsed output to a sibling file, e.g. foo.parse_output.txt
    let output_path = input.with_extension("parse_output.txt");
    let output_str = output_path.to_string_lossy().to_string();

    let mut cmd = tokio::process::Command::new(&exe);
    cmd.args([&dll, &root, &file_path, &output_str]);
    let result = hide_window(&mut cmd)
        .output()
        .await
        .map_err(|e| format!("Failed to run eparser32: {}", e))?;

    let stdout = decode_tool_output(&result.stdout);
    let stderr = decode_tool_output(&result.stderr);

    if !result.status.success() {
        return Ok(ParseResult {
            success: false,
            output: stdout,
            summary: None,
            error: Some(stderr),
        });
    }

    // Read the output file produced by eparser32; fall back to stdout
    let output_content = if output_path.exists() {
        let bytes = tokio::fs::read(&output_path)
            .await
            .map_err(|e| format!("Failed to read parser output: {}", e))?;
        // Prefer valid UTF-8; fall back to GBK (common for 易语言 tooling)
        match String::from_utf8(bytes.clone()) {
            Ok(s) => s,
            Err(_) => encoding_rs::GBK.decode(&bytes).0.to_string(),
        }
    } else {
        stdout.clone()
    };

    // Optionally load a summary.json sidecar produced by the parser
    let summary_path = input.with_extension("summary.json");
    let summary: Option<serde_json::Value> = if summary_path.exists() {
        tokio::fs::read(&summary_path)
            .await
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
    } else {
        None
    };

    Ok(ParseResult {
        success: true,
        output: output_content,
        summary,
        error: if stderr.is_empty() {
            None
        } else {
            Some(stderr)
        },
    })
}

// ---------------------------------------------------------------------------
// compile_efile
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct CompileResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub output_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ECodeProjectResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub source_path: Option<String>,
    pub ecode_dir: Option<String>,
    pub output_path: Option<String>,
    pub files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ECodeSubprogramSummary {
    pub name: String,
    pub signature: String,
    pub line: usize,
    pub line_count: usize,
    pub locals: Vec<String>,
    pub calls: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ECodeSourceFileSummary {
    pub path: String,
    pub relative_path: String,
    pub kind: String,
    pub chars: usize,
    pub lines: usize,
    pub support_libraries: Vec<String>,
    pub assembly: Option<String>,
    pub assembly_variables: Vec<String>,
    pub subprograms: Vec<ECodeSubprogramSummary>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ECodeProjectMapResult {
    pub success: bool,
    pub ecode_dir: String,
    pub source_file_count: usize,
    pub skipped_module_file_count: usize,
    pub support_libraries: Vec<String>,
    pub assemblies: Vec<String>,
    pub entrypoints: Vec<String>,
    pub recommended_read_order: Vec<String>,
    pub source_files: Vec<ECodeSourceFileSummary>,
    pub summary: String,
}

fn decode_text_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|err| format!("读取文件失败 {}：{}", path.display(), err))?;
    match String::from_utf8(bytes.clone()) {
        Ok(text) => Ok(text),
        Err(_) => Ok(encoding_rs::GBK.decode(&bytes).0.to_string()),
    }
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('/', "\\")
}

fn is_module_dir(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy() == "模块")
        .unwrap_or(false)
}

fn is_ecode_source_file(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().ends_with(".e.txt"))
        .unwrap_or(false)
}

fn count_source_files(path: &Path) -> usize {
    if path.is_file() {
        return usize::from(is_ecode_source_file(path));
    }

    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };

    entries
        .flatten()
        .map(|entry| count_source_files(&entry.path()))
        .sum()
}

fn collect_ecode_source_files(
    path: &Path,
    include_modules: bool,
    out: &mut Vec<PathBuf>,
    skipped_module_file_count: &mut usize,
) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            if !include_modules && is_module_dir(&entry_path) {
                *skipped_module_file_count += count_source_files(&entry_path);
                continue;
            }
            collect_ecode_source_files(
                &entry_path,
                include_modules,
                out,
                skipped_module_file_count,
            );
        } else if is_ecode_source_file(&entry_path) {
            out.push(entry_path);
        }
    }
}

fn ecode_file_kind(path: &Path) -> String {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();

    if file_name.ends_with(".form.e.txt") {
        "窗口程序集".to_string()
    } else if file_name.ends_with(".class.e.txt") {
        "类模块".to_string()
    } else if file_name.ends_with(".static.e.txt") {
        "程序集".to_string()
    } else if file_name == "全局变量.e.txt" {
        "全局变量".to_string()
    } else if file_name == "常量.e.txt" {
        "常量".to_string()
    } else if file_name == "自定义类型.e.txt" {
        "自定义类型".to_string()
    } else {
        "源码".to_string()
    }
}

fn ecode_read_rank(relative_path: &str) -> usize {
    let normalized = relative_path.replace('/', "\\");
    if normalized == "全局变量.e.txt" || normalized.ends_with("\\全局变量.e.txt") {
        return 0;
    }
    if normalized.contains("\\代码\\") && normalized.ends_with(".form.e.txt") {
        return 1;
    }
    if normalized.contains("\\代码\\") && normalized.ends_with(".class.e.txt") {
        return 2;
    }
    if normalized.contains("\\代码\\") && normalized.ends_with(".static.e.txt") {
        return 3;
    }
    9
}

fn after_prefix<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let trimmed = line.trim_start();
    trimmed.strip_prefix(prefix).map(str::trim)
}

fn split_e_signature_name(signature_tail: &str) -> String {
    signature_tail
        .split([',', '，'])
        .next()
        .unwrap_or(signature_tail)
        .trim()
        .to_string()
}

fn push_limited_unique(items: &mut Vec<String>, value: String, limit: usize) {
    if value.trim().is_empty() || items.iter().any(|item| item == &value) || items.len() >= limit {
        return;
    }
    items.push(value);
}

fn collect_line_calls(line: &str, calls: &mut Vec<String>) {
    for marker in [" (", "（"] {
        let mut start = 0;
        while let Some(offset) = line[start..].find(marker) {
            let marker_index = start + offset;
            let before = line[..marker_index].trim_end();
            let candidate = before
                .split(|ch: char| ch.is_whitespace() || ch == '＝' || ch == '=' || ch == '+' || ch == '＋')
                .filter(|item| !item.trim().is_empty())
                .last()
                .unwrap_or("")
                .trim()
                .trim_matches(['.', ':', '：', '(', '（']);

            if !candidate.is_empty()
                && !candidate.starts_with('.')
                && candidate.chars().count() <= 40
                && (candidate.contains('_')
                    || candidate.contains('.')
                    || candidate.chars().any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch)))
            {
                push_limited_unique(calls, candidate.to_string(), 16);
            }

            start = marker_index + marker.len();
        }
    }
}

fn summarize_ecode_source_file(root: &Path, path: &Path) -> Result<ECodeSourceFileSummary, String> {
    let content = decode_text_file(path)?;
    let mut support_libraries = Vec::new();
    let mut assembly = None;
    let mut assembly_variables = Vec::new();
    let mut subprograms: Vec<ECodeSubprogramSummary> = Vec::new();
    let mut current_subprogram: Option<usize> = None;
    let lines: Vec<&str> = content.lines().collect();

    for (index, line) in lines.iter().enumerate() {
        if let Some(name) = after_prefix(line, ".支持库") {
            push_limited_unique(&mut support_libraries, name.to_string(), 80);
            continue;
        }

        if let Some(name) = after_prefix(line, ".程序集变量") {
            push_limited_unique(&mut assembly_variables, name.to_string(), 80);
            continue;
        }

        if let Some(name) = after_prefix(line, ".程序集") {
            if !line.trim_start().starts_with(".程序集变量") {
                assembly = Some(split_e_signature_name(name));
            }
            continue;
        }

        if let Some(signature_tail) = after_prefix(line, ".子程序") {
            let signature = line.trim().to_string();
            subprograms.push(ECodeSubprogramSummary {
                name: split_e_signature_name(signature_tail),
                signature,
                line: index + 1,
                line_count: 0,
                locals: Vec::new(),
                calls: Vec::new(),
            });
            current_subprogram = Some(subprograms.len() - 1);
            continue;
        }

        if let Some(local) = after_prefix(line, ".局部变量") {
            if let Some(current) = current_subprogram {
                push_limited_unique(&mut subprograms[current].locals, local.to_string(), 40);
            }
            continue;
        }

        if let Some(current) = current_subprogram {
            collect_line_calls(line, &mut subprograms[current].calls);
        }
    }

    for index in 0..subprograms.len() {
        let start = subprograms[index].line;
        let end = subprograms
            .get(index + 1)
            .map(|item| item.line.saturating_sub(1))
            .unwrap_or(lines.len());
        subprograms[index].line_count = end.saturating_sub(start).saturating_add(1);
    }

    Ok(ECodeSourceFileSummary {
        path: path.to_string_lossy().to_string(),
        relative_path: relative_path(root, path),
        kind: ecode_file_kind(path),
        chars: content.chars().count(),
        lines: lines.len(),
        support_libraries,
        assembly_variables,
        assembly,
        subprograms,
    })
}

#[tauri::command]
pub async fn summarize_ecode_project_for_agent(
    ecode_dir: String,
    include_modules: Option<bool>,
    max_files: Option<usize>,
) -> Result<ECodeProjectMapResult, String> {
    let root = PathBuf::from(&ecode_dir);
    if !root.exists() {
        return Err(format!("文本工程目录不存在：{}", root.display()));
    }

    let include_modules = include_modules.unwrap_or(false);
    let max_files = max_files.unwrap_or(40).clamp(1, 120);
    let mut source_paths = Vec::new();
    let mut skipped_module_file_count = 0;
    collect_ecode_source_files(
        &root,
        include_modules,
        &mut source_paths,
        &mut skipped_module_file_count,
    );

    source_paths.sort_by(|left, right| {
        let left_rel = relative_path(&root, left);
        let right_rel = relative_path(&root, right);
        ecode_read_rank(&left_rel)
            .cmp(&ecode_read_rank(&right_rel))
            .then_with(|| left_rel.cmp(&right_rel))
    });

    let source_file_count = source_paths.len();
    let mut support_libraries = BTreeSet::new();
    let mut assemblies = BTreeSet::new();
    let mut entrypoints = Vec::new();
    let mut source_files = Vec::new();

    for path in source_paths.iter().take(max_files) {
        let summary = summarize_ecode_source_file(&root, path)?;
        for item in &summary.support_libraries {
            support_libraries.insert(item.clone());
        }
        if let Some(assembly) = &summary.assembly {
            assemblies.insert(assembly.clone());
        }
        for subprogram in &summary.subprograms {
            if subprogram.name.starts_with('_')
                || subprogram.name.contains("创建完毕")
                || subprogram.name.contains("被单击")
                || subprogram.name.contains("周期事件")
            {
                push_limited_unique(
                    &mut entrypoints,
                    format!(
                        "{}:{} {}",
                        summary.relative_path, subprogram.line, subprogram.name
                    ),
                    40,
                );
            }
        }
        source_files.push(summary);
    }

    let recommended_read_order = source_files
        .iter()
        .take(12)
        .map(|item| item.path.clone())
        .collect::<Vec<_>>();
    let subprogram_count = source_files
        .iter()
        .map(|item| item.subprograms.len())
        .sum::<usize>();
    let summary = format!(
        "发现主工程源码文件 {} 个，本次摘要返回 {} 个，跳过模块源码 {} 个；程序集 {} 个，子程序 {} 个，支持库 {} 个。",
        source_file_count,
        source_files.len(),
        skipped_module_file_count,
        assemblies.len(),
        subprogram_count,
        support_libraries.len(),
    );

    Ok(ECodeProjectMapResult {
        success: true,
        ecode_dir: root.to_string_lossy().to_string(),
        source_file_count,
        skipped_module_file_count,
        support_libraries: support_libraries.into_iter().collect(),
        assemblies: assemblies.into_iter().collect(),
        entrypoints,
        recommended_read_order,
        source_files,
        summary,
    })
}

fn e2txt_base_args() -> Vec<String> {
    vec![
        "-log".to_string(),
        "-enc".to_string(),
        "UTF-8".to_string(),
        "-ns".to_string(),
        "2".to_string(),
        "-e".to_string(),
    ]
}

fn validate_ecode_project_before_generate(ecode_dir: &Path) -> Result<(), String> {
    let mut findings = Vec::new();
    validate_ecode_source_declarations(ecode_dir, ecode_dir, &mut findings)?;

    if findings.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "文本工程源码预检查失败：\n{}\n\n修复建议：.全局变量/.程序集变量/.局部变量 只能声明名称、类型、数组和备注等字段，不要在声明行写默认值；请在启动子程序或窗口创建完毕事件中赋值，然后重新 build_ecode_project。",
            findings.join("\n")
        ))
    }
}

fn normalize_ecode_project_text_files(ecode_dir: &Path) -> Result<(), String> {
    normalize_ecode_text_file_line_endings(ecode_dir)?;
    Ok(())
}

fn normalize_ecode_text_file_line_endings(dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("读取目录失败 {}：{}", dir.display(), err))? {
        let entry = entry.map_err(|err| format!("读取目录项失败：{}", err))?;
        let path = entry.path();
        if path.is_dir() {
            normalize_ecode_text_file_line_endings(&path)?;
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|item| item.to_str()) else {
            continue;
        };
        if !(file_name.ends_with(".e.txt")
            || file_name.ends_with(".config.json")
            || file_name.ends_with(".desc.json")
            || file_name.ends_with(".list.txt"))
        {
            continue;
        }

        let bytes = fs::read(&path).map_err(|err| format!("读取文件失败 {}：{}", path.display(), err))?;
        if !bytes.windows(1).any(|item| item == b"\n") {
            continue;
        }
        let text = decode_tool_output(&bytes);
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n");
        fs::write(&path, normalized.as_bytes())
            .map_err(|err| format!("写入规范化文本失败 {}：{}", path.display(), err))?;
    }
    Ok(())
}

fn validate_ecode_source_declarations(
    root: &Path,
    dir: &Path,
    findings: &mut Vec<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("读取目录失败 {}：{}", dir.display(), err))? {
        let entry = entry.map_err(|err| format!("读取目录项失败：{}", err))?;
        let path = entry.path();
        if path.is_dir() {
            validate_ecode_source_declarations(root, &path, findings)?;
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|item| item.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".e.txt") {
            continue;
        }

        let text = fs::read_to_string(&path)
            .map_err(|err| format!("读取文本源码失败 {}：{}", path.display(), err))?;
        for (index, line) in text.lines().enumerate() {
            let trimmed = line.trim_start_matches('\u{feff}').trim();
            if declaration_line_has_initializer(trimmed) {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                findings.push(format!(
                    "{}:{} 声明行包含默认值：{}",
                    relative,
                    index + 1,
                    trimmed
                ));
            }
        }
    }
    Ok(())
}

fn declaration_line_has_initializer(line: &str) -> bool {
    if !(line.starts_with(".全局变量 ")
        || line.starts_with(".程序集变量 ")
        || line.starts_with(".局部变量 "))
    {
        return false;
    }

    let comma_count = line.matches(',').count();
    comma_count >= 4 && (line.contains('"') || line.contains('“') || line.contains('”'))
}

async fn run_e2txt(
    e2txt: &str,
    args: Vec<String>,
    current_dir: Option<&Path>,
) -> Result<(bool, String, String), String> {
    let mut cmd = tokio::process::Command::new(e2txt);
    cmd.args(&args);
    if let Some(current_dir) = current_dir {
        cmd.current_dir(current_dir);
    }

    let output = hide_window(&mut cmd)
        .output()
        .await
        .map_err(|err| format!("启动 e2txt 失败：{}", err))?;
    let stdout = decode_tool_output(&output.stdout);
    let stderr = decode_tool_output(&output.stderr);
    let success = output.status.success() && (stdout.contains("SUCC:") || stderr.contains("SUCC:"));
    Ok((success, stdout, stderr))
}

#[tauri::command]
pub async fn export_efile_to_ecode(
    app: AppHandle,
    source_path: String,
    output_dir: Option<String>,
) -> Result<ECodeProjectResult, String> {
    let detected = detect_eagent_tools(app.clone());
    let e2txt = detected
        .e2txt_exe
        .path
        .ok_or_else(|| "内置 e2txt.exe 缺失，请重新安装应用".to_string())?;

    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let ecode_dir = match output_dir {
        Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => default_exported_ecode_dir(&app, &source)?,
    };
    fs::create_dir_all(&ecode_dir)
        .map_err(|err| format!("创建文本工程目录失败 {}：{}", ecode_dir.display(), err))?;

    let mut args = e2txt_base_args();
    args.extend([
        "-src".to_string(),
        source.to_string_lossy().to_string(),
        "-dst".to_string(),
        ecode_dir.to_string_lossy().to_string(),
        "-mode".to_string(),
        "e2t".to_string(),
    ]);

    let current_dir = PathBuf::from(&e2txt)
        .parent()
        .map(|path| path.to_path_buf());
    let (success, stdout, stderr) = run_e2txt(&e2txt, args, current_dir.as_deref()).await?;

    Ok(ECodeProjectResult {
        success,
        stdout,
        stderr,
        source_path: Some(source.to_string_lossy().to_string()),
        ecode_dir: Some(ecode_dir.to_string_lossy().to_string()),
        output_path: None,
        files: list_files(&ecode_dir, 200),
    })
}

#[tauri::command]
pub async fn generate_efile_from_ecode(
    app: AppHandle,
    ecode_dir: String,
    output_path: String,
) -> Result<ECodeProjectResult, String> {
    let detected = detect_eagent_tools(app.clone());
    let e2txt = detected
        .e2txt_exe
        .path
        .ok_or_else(|| "内置 e2txt.exe 缺失，请重新安装应用".to_string())?;

    let ecode_dir = PathBuf::from(&ecode_dir);
    if !ecode_dir.exists() {
        return Err(format!("文本工程目录不存在：{}", ecode_dir.display()));
    }
    if let Err(err) = validate_ecode_project_before_generate(&ecode_dir) {
        return Ok(ECodeProjectResult {
            success: false,
            stdout: String::new(),
            stderr: err,
            source_path: None,
            ecode_dir: Some(ecode_dir.to_string_lossy().to_string()),
            output_path: None,
            files: list_files(&ecode_dir, 200),
        });
    }
    if let Err(err) = normalize_ecode_project_text_files(&ecode_dir) {
        return Ok(ECodeProjectResult {
            success: false,
            stdout: String::new(),
            stderr: err,
            source_path: None,
            ecode_dir: Some(ecode_dir.to_string_lossy().to_string()),
            output_path: None,
            files: list_files(&ecode_dir, 200),
        });
    }

    let output = if output_path.trim().is_empty() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| format!("系统时间异常：{}", err))?
            .as_millis();
        default_generated_efile_path(&app, timestamp)?
    } else {
        PathBuf::from(&output_path)
    };
    ensure_parent_dir(&output)?;

    let mut args = e2txt_base_args();
    args.extend([
        "-src".to_string(),
        ecode_dir.to_string_lossy().to_string(),
        "-dst".to_string(),
        output.to_string_lossy().to_string(),
        "-mode".to_string(),
        "t2e".to_string(),
    ]);

    let current_dir = PathBuf::from(&e2txt)
        .parent()
        .map(|path| path.to_path_buf());
    let (success, stdout, stderr) = run_e2txt(&e2txt, args, current_dir.as_deref()).await?;
    let output_ready = wait_for_path(
        &output,
        Duration::from_secs(10),
        Duration::from_millis(100),
    );
    let stderr = if success && !output_ready {
        if stderr.trim().is_empty() {
            "e2txt 已返回成功，但目标 .e 文件在等待 10 秒后仍未出现。".to_string()
        } else {
            format!(
                "{}\n{}",
                stderr,
                "e2txt 已返回成功，但目标 .e 文件在等待 10 秒后仍未出现。"
            )
        }
    } else {
        stderr
    };

    Ok(ECodeProjectResult {
        success: success && output_ready,
        stdout,
        stderr,
        source_path: None,
        ecode_dir: Some(ecode_dir.to_string_lossy().to_string()),
        output_path: Some(output.to_string_lossy().to_string()),
        files: list_files(&ecode_dir, 200),
    })
}

#[tauri::command]
pub async fn generate_efile_from_code(
    app: AppHandle,
    code: String,
    output_path: String,
    module_paths: Option<Vec<String>>,
) -> Result<ECodeProjectResult, String> {
    let detected = detect_eagent_tools(app.clone());
    let template_dir = detected
        .ecode_template_dir
        .path
        .ok_or_else(|| "内置文本工程模板缺失，请重新安装应用".to_string())?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("系统时间异常：{}", err))?
        .as_millis();
    let work_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败：{}", err))?
        .join("generated-ecode")
        .join(format!("project-{}", timestamp));

    copy_dir_all(Path::new(&template_dir), &work_dir)?;
    let module_refs = write_ecode_module_refs(
        &work_dir,
        module_paths.as_deref().unwrap_or(&[]),
    )?;

    let code_file = work_dir.join("代码").join("程序集1.static.e.txt");
    fs::write(&code_file, normalize_e_code_for_template(&code))
        .map_err(|err| format!("写入文本源码失败 {}：{}", code_file.display(), err))?;

    let output_path = if output_path.trim().is_empty() {
        default_generated_efile_path(&app, timestamp)?
            .to_string_lossy()
            .to_string()
    } else {
        output_path
    };

    let mut result =
        generate_efile_from_ecode(app, work_dir.to_string_lossy().to_string(), output_path).await?;
    if !module_refs.is_empty() {
        result.stdout = format!(
            "已写入模块引用：\n{}\n\n{}",
            module_refs.join("\n"),
            result.stdout
        );
    }
    Ok(result)
}

/// Compile an .e project through ecl.exe. ecl is optional and may be unusable on
/// modern Windows, but this path is explicit and does not drive the GUI IDE.
#[tauri::command]
pub async fn compile_efile(
    app: AppHandle,
    source_path: String,
    output_path: Option<String>,
    static_link: Option<bool>,
    module_paths: Option<Vec<String>>,
    easy_language_root: Option<String>,
) -> Result<CompileResult, String> {
    let detected = detect_eagent_tools(app);
    let ecl_exe = detected
        .ecl_exe
        .path
        .ok_or_else(|| "内置 ecl.exe 缺失，无法执行命令行编译检查".to_string())?;
    let e_root = detected
        .e_root
        .path
        .ok_or_else(|| "内置易语言运行环境缺失或解压失败，请重新安装应用".to_string())?;
    let e_exe = detected
        .e_exe
        .path
        .ok_or_else(|| "内置易语言运行环境缺失或解压失败，请重新安装应用".to_string())?;

    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("Source file not found: {}", source_path));
    }

    let output = output_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| source.with_extension("exe"));
    ensure_parent_dir(&output)?;

    let mut staged_modules = stage_local_ecom_modules(
        Path::new(&e_root),
        easy_language_root.as_deref(),
    )?;
    staged_modules.extend(stage_module_dependencies(
        Path::new(&e_root),
        module_paths.as_deref().unwrap_or(&[]),
    )?);

    let mut args = vec![
        "make".to_string(),
        source.to_string_lossy().to_string(),
        output.to_string_lossy().to_string(),
        "-epath".to_string(),
        e_exe.clone(),
        "-nologo".to_string(),
    ];
    if static_link.unwrap_or(true) {
        args.push("-s".to_string());
    } else {
        args.push("-d".to_string());
    }

    let mut cmd = tokio::process::Command::new(&ecl_exe);
    cmd.args(&args);
    if let Some(parent) = PathBuf::from(&ecl_exe).parent() {
        cmd.current_dir(parent);
    }

    let timeout = if static_link.unwrap_or(true) {
        180
    } else {
        120
    };
    let result = tokio::time::timeout(Duration::from_secs(timeout), hide_window(&mut cmd).output())
        .await
        .map_err(|_| format!("ecl 编译超时（{} 秒）", timeout))?
        .map_err(|err| format!("启动 ecl.exe 失败：{}", err))?;

    let mut stdout = decode_tool_output_with_preference(&result.stdout, true);
    let mut stderr = decode_tool_output_with_preference(&result.stderr, true);
    let exit_code = result.status.code();
    let status_ok = result.status.success() || matches!(exit_code, Some(1));
    let output_exists = output.exists();

    if !staged_modules.is_empty() {
        stdout = format!("已同步/放置依赖模块：\n{}\n\n{}", staged_modules.join("\n"), stdout);
    }

    if !status_ok {
        let detail = join_non_empty(&[stderr.as_str(), stdout.as_str()]);
        stderr = format!(
            "ecl.exe 编译失败，退出码：{}。\n{}",
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "被系统终止".to_string()),
            if detail.is_empty() {
                "没有捕获到编译器输出；请检查生成的 .e 和模块依赖。".to_string()
            } else {
                detail
            }
        );
    }

    if status_ok && !output_exists {
        let detail = [
            stderr.trim(),
            stdout.trim(),
        ]
        .into_iter()
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
        stderr = format!(
            "ecl.exe 未生成目标 EXE：{}\n退出码：{}\n静态链接：{}\n{}",
            output.display(),
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "未知".to_string()),
            static_link.unwrap_or(true),
            if detail.is_empty() {
                "没有捕获到编译器输出；请检查源码是否使用了未引用的模块/支持库，或打开详情查看生成的 .e。".to_string()
            } else {
                format!("编译器输出：\n{}", detail)
            }
        );
    }

    Ok(CompileResult {
        success: status_ok && output_exists,
        stdout,
        stderr,
        output_path: output_exists.then(|| output.to_string_lossy().to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        declaration_line_has_initializer, decode_tool_output_with_preference,
        normalize_ecode_project_text_files, validate_ecode_project_before_generate, wait_for_path,
    };
    use std::fs;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    fn wait_for_path_handles_delayed_file_creation() {
        let temp_root = std::env::temp_dir().join(format!(
            "ecode-parser-wait-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        fs::create_dir_all(&temp_root).expect("create temp dir");
        let delayed_file = temp_root.join("delayed.e");

        let writer_path = delayed_file.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            fs::write(&writer_path, b"ok").expect("write delayed file");
        });

        let observed = wait_for_path(
            &delayed_file,
            Duration::from_secs(2),
            Duration::from_millis(25),
        );
        handle.join().expect("join delayed writer");

        assert!(observed, "wait_for_path should observe the delayed file");

        let _ = fs::remove_file(&delayed_file);
        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn detects_initializer_in_variable_declaration_line() {
        assert!(declaration_line_has_initializer(
            ".全局变量 URL_主站, 文本型, , , \"http://example.com\""
        ));
        assert!(declaration_line_has_initializer(
            ".局部变量 默认值, 文本型, , , “abc”"
        ));
        assert!(!declaration_line_has_initializer(
            ".全局变量 URL_主站, 文本型"
        ));
        assert!(!declaration_line_has_initializer(
            ".程序集变量 浏览器, 队长chrome类"
        ));
    }

    #[test]
    fn precheck_reports_declaration_initializer_with_file_and_line() {
        let temp_root = std::env::temp_dir().join(format!(
            "ecode-parser-precheck-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        fs::create_dir_all(&temp_root).expect("create temp dir");
        fs::write(
            temp_root.join("全局变量.e.txt"),
            ".版本 2\r\n.全局变量 URL_主站, 文本型, , , \"http://example.com\"\r\n",
        )
        .expect("write source");

        let err = validate_ecode_project_before_generate(&temp_root).unwrap_err();
        assert!(err.contains("全局变量.e.txt:2"));
        assert!(err.contains("声明行包含默认值"));

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn normalizes_ecode_text_files_to_crlf() {
        let temp_root = std::env::temp_dir().join(format!(
            "ecode-parser-crlf-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        fs::create_dir_all(temp_root.join("代码")).expect("create temp dir");
        let source = temp_root.join("代码").join("窗口程序集_启动窗口.form.e.txt");
        fs::write(&source, ".版本 2\n.程序集 窗口程序集_启动窗口\n")
            .expect("write source");

        normalize_ecode_project_text_files(&temp_root).expect("normalize");
        let bytes = fs::read(&source).expect("read normalized");
        assert!(bytes.windows(2).any(|item| item == b"\r\n"));
        assert!(!bytes
            .windows(2)
            .any(|item| item[0] != b'\r' && item[1] == b'\n'));

        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn decodes_gbk_ecl_output_when_requested() {
        let (encoded, _, _) = encoding_rs::GBK.encode("错误(10031): 变量指定格式错误");
        let decoded = decode_tool_output_with_preference(&encoded, true);
        assert!(decoded.contains("错误(10031)"));
        assert!(decoded.contains("变量指定格式错误"));
    }

    #[test]
    fn decodes_utf16le_ecl_output_before_gbk_fallback() {
        let mut encoded = vec![0xff, 0xfe];
        for unit in "写出可执行文件成功".encode_utf16() {
            encoded.extend_from_slice(&unit.to_le_bytes());
        }

        let decoded = decode_tool_output_with_preference(&encoded, true);
        assert!(decoded.contains("写出可执行文件成功"));
    }
}
