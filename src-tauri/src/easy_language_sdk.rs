use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

static ENV_SCAN: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasyLanguageLibraryInfo {
    pub name: String,
    pub fne_path: String,
    pub help_dir: Option<String>,
    pub command_doc_count: usize,
    pub has_const_doc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasyLanguageModuleInfo {
    pub name: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasyLanguageToolInfo {
    pub name: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasyLanguageEnvCounts {
    pub support_library_files: usize,
    pub module_files: usize,
    pub sample_e_files: usize,
    pub help_html_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EasyLanguageEnvScan {
    pub root: String,
    pub exists: bool,
    pub is_compile_ready: bool,
    pub e_exe: Option<String>,
    pub el_exe: Option<String>,
    pub help_dir: Option<String>,
    pub lib_dir: Option<String>,
    pub ecom_dir: Option<String>,
    pub sdk_dir: Option<String>,
    pub tools_dir: Option<String>,
    pub linker_dir: Option<String>,
    pub static_lib_dir: Option<String>,
    pub tools: Vec<EasyLanguageToolInfo>,
    pub support_libraries: Vec<EasyLanguageLibraryInfo>,
    pub modules: Vec<EasyLanguageModuleInfo>,
    pub counts: EasyLanguageEnvCounts,
    pub counts_complete: bool,
    pub warnings: Vec<String>,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn pick_root(root_path: Option<String>) -> PathBuf {
    if let Some(input) = root_path {
        let trimmed = input.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    for candidate in [
        r"D:\e",
        r"C:\e",
        r"D:\Program Files\e",
        r"C:\Program Files (x86)\e",
    ] {
        let path = PathBuf::from(candidate);
        if path.join("e.exe").exists() || path.join("lib").exists() {
            return path;
        }
    }

    PathBuf::from(r"D:\e")
}

// Do not follow links/junctions: an installation may link back to its parent.
fn is_directory_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true; // FILE_ATTRIBUTE_REPARSE_POINT (includes junctions)
        }
    }
    metadata.file_type().is_symlink()
}

fn count_matching_files(
    root: &Path,
    wanted_ext: &[&str],
    max_entries: usize,
    max_duration: Duration,
) -> (usize, bool) {
    let mut count = 0usize;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    let mut complete = true;
    let started = Instant::now();

    while let Some((path, depth)) = stack.pop() {
        if started.elapsed() >= max_duration {
            return (count, false);
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            complete = false;
            continue;
        };
        if is_directory_link(&metadata) {
            complete = false;
            continue;
        }
        let Ok(entries) = fs::read_dir(&path) else {
            complete = false;
            continue;
        };
        for entry in entries {
            if visited >= max_entries || started.elapsed() >= max_duration {
                return (count, false);
            }
            visited += 1;
            let Ok(entry) = entry else {
                complete = false;
                continue;
            };
            let p = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&p) else {
                complete = false;
                continue;
            };
            if is_directory_link(&metadata) {
                complete = false;
                continue;
            }
            if metadata.is_dir() {
                if depth < 64 {
                    stack.push((p, depth + 1));
                } else {
                    complete = false;
                }
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let ext = p
                .extension()
                .map(|item| item.to_string_lossy().to_ascii_lowercase());
            if let Some(ext) = ext {
                if wanted_ext.iter().any(|wanted| ext == *wanted) {
                    count += 1;
                }
            }
        }
    }

    (count, complete)
}

fn count_command_docs(root: &Path) -> usize {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return false;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            name.starts_with("cmd") && name.ends_with(".htm")
        })
        .count()
}

fn support_libraries(root: &Path) -> Vec<EasyLanguageLibraryInfo> {
    let lib_dir = root.join("lib");
    let help_dir = root.join("help");
    let Ok(entries) = fs::read_dir(&lib_dir) else {
        return Vec::new();
    };

    let mut libs: Vec<EasyLanguageLibraryInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path
                .extension()
                .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("fne"))
                .unwrap_or(false)
            {
                return None;
            }
            let name = path
                .file_stem()
                .map(|item| item.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let lib_help_dir = help_dir.join(&name);
            Some(EasyLanguageLibraryInfo {
                name,
                fne_path: path_string(&path),
                help_dir: lib_help_dir.exists().then(|| path_string(&lib_help_dir)),
                command_doc_count: if lib_help_dir.exists() {
                    count_command_docs(&lib_help_dir)
                } else {
                    0
                },
                has_const_doc: lib_help_dir.join("const.htm").exists(),
            })
        })
        .collect();
    libs.sort_by(|a, b| a.name.cmp(&b.name));
    libs
}

fn modules(root: &Path) -> Vec<EasyLanguageModuleInfo> {
    let ecom_dir = root.join("ecom");
    let Ok(entries) = fs::read_dir(ecom_dir) else {
        return Vec::new();
    };

    let mut modules: Vec<EasyLanguageModuleInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path
                .extension()
                .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("ec"))
                .unwrap_or(false)
            {
                return None;
            }
            let meta = fs::metadata(&path).ok()?;
            Some(EasyLanguageModuleInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path_string(&path),
                bytes: meta.len(),
            })
        })
        .collect();
    modules.sort_by(|a, b| a.name.cmp(&b.name));
    modules
}

fn tool(root: &Path, name: &str, relative: &str) -> EasyLanguageToolInfo {
    let path = root.join(relative);
    EasyLanguageToolInfo {
        name: name.to_string(),
        path: path_string(&path),
        exists: path.exists(),
    }
}

#[tauri::command]
pub async fn scan_easy_language_env(
    root_path: Option<String>,
) -> Result<EasyLanguageEnvScan, String> {
    let permit = ENV_SCAN
        .try_acquire()
        .map_err(|_| "环境正在扫描，请等待当前扫描完成")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        scan_environment(root_path)
    })
    .await
    .map_err(|error| format!("环境扫描失败：{error}"))?
}

fn scan_environment(root_path: Option<String>) -> Result<EasyLanguageEnvScan, String> {
    let root = pick_root(root_path);
    let exists = root.exists();

    if !exists {
        return Ok(EasyLanguageEnvScan {
            root: path_string(&root),
            exists,
            is_compile_ready: false,
            e_exe: None,
            el_exe: None,
            help_dir: None,
            lib_dir: None,
            ecom_dir: None,
            sdk_dir: None,
            tools_dir: None,
            linker_dir: None,
            static_lib_dir: None,
            tools: Vec::new(),
            support_libraries: Vec::new(),
            modules: Vec::new(),
            counts: EasyLanguageEnvCounts {
                support_library_files: 0,
                module_files: 0,
                sample_e_files: 0,
                help_html_files: 0,
            },
            counts_complete: true,
            warnings: vec![format!("未找到易语言安装目录：{}", path_string(&root))],
        });
    }

    let help_dir = root.join("help");
    let lib_dir = root.join("lib");
    let ecom_dir = root.join("ecom");
    let sdk_dir = root.join("sdk");
    let tools_dir = root.join("tools");
    let linker_dir = root.join("linker");
    let static_lib_dir = root.join("static_lib");
    let tools = vec![
        tool(&root, "e.exe", "e.exe"),
        tool(&root, "el.exe", "el.exe"),
        tool(&root, "elib.exe", r"tools\elib.exe"),
        tool(&root, "link.dll", r"tools\link.dll"),
        tool(&root, "VC98 link.exe", r"VC98linker\bin\link.exe"),
    ];
    let support_libraries = support_libraries(&root);
    let modules = modules(&root);

    let mut warnings = Vec::new();
    for (path, label) in [
        (&lib_dir, "lib 支持库目录"),
        (&ecom_dir, "ecom 模块目录"),
        (&static_lib_dir, "static_lib 静态库目录"),
    ] {
        if !path.exists() {
            warnings.push(format!("缺少{}", label));
        }
    }

    let is_compile_ready = tools
        .iter()
        .filter(|item| {
            matches!(
                item.name.as_str(),
                "e.exe" | "el.exe" | "link.dll" | "VC98 link.exe"
            )
        })
        .all(|item| item.exists)
        && lib_dir.exists()
        && static_lib_dir.exists();

    let (sample_e_files, samples_complete) =
        count_matching_files(&root, &["e"], 100_000, Duration::from_secs(10));
    let (help_html_files, help_complete) = if help_dir.exists() {
        count_matching_files(
            &help_dir,
            &["htm", "html"],
            100_000,
            Duration::from_secs(10),
        )
    } else {
        (0, true)
    };
    let counts_complete = samples_complete && help_complete;
    if !counts_complete {
        warnings.push("文件统计未完成：已跳过目录链接、不可访问目录或超出扫描预算的文件，显示数量为已扫描部分。".to_string());
    }

    Ok(EasyLanguageEnvScan {
        root: path_string(&root),
        exists,
        is_compile_ready,
        e_exe: root
            .join("e.exe")
            .exists()
            .then(|| path_string(&root.join("e.exe"))),
        el_exe: root
            .join("el.exe")
            .exists()
            .then(|| path_string(&root.join("el.exe"))),
        help_dir: help_dir.exists().then(|| path_string(&help_dir)),
        lib_dir: lib_dir.exists().then(|| path_string(&lib_dir)),
        ecom_dir: ecom_dir.exists().then(|| path_string(&ecom_dir)),
        sdk_dir: sdk_dir.exists().then(|| path_string(&sdk_dir)),
        tools_dir: tools_dir.exists().then(|| path_string(&tools_dir)),
        linker_dir: linker_dir.exists().then(|| path_string(&linker_dir)),
        static_lib_dir: static_lib_dir
            .exists()
            .then(|| path_string(&static_lib_dir)),
        counts: EasyLanguageEnvCounts {
            support_library_files: support_libraries.len(),
            module_files: modules.len(),
            sample_e_files,
            help_html_files,
        },
        counts_complete,
        tools,
        support_libraries,
        modules,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_counts_nested_files_and_reports_partial_walks() {
        let root = std::env::temp_dir().join(format!(
            "eaicoding-env-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(root.join("help/core/nested")).unwrap();
        fs::create_dir_all(root.join("lib")).unwrap();
        fs::create_dir_all(root.join("ecom")).unwrap();
        for name in [
            "example.E",
            "help/core/cmd1.htm",
            "help/core/nested/info.html",
            "lib/core.fne",
            "ecom/sample.ec",
        ] {
            fs::write(root.join(name), b"fixture").unwrap();
        }
        let scan = scan_environment(Some(path_string(&root))).unwrap();
        assert!(scan.counts_complete);
        assert_eq!(scan.counts.sample_e_files, 1);
        assert_eq!(scan.counts.help_html_files, 2);
        assert_eq!(scan.counts.support_library_files, 1);
        assert_eq!(scan.counts.module_files, 1);
        assert_eq!(scan.support_libraries[0].command_doc_count, 1);
        assert!(!count_matching_files(&root, &["e"], 1, Duration::from_secs(1)).1);
        assert!(!count_matching_files(&root, &["e"], 100, Duration::ZERO).1);

        #[cfg(windows)]
        {
            let junction = root.join("help").join("core").join("loop");
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&junction)
                .arg(&root)
                .output()
                .unwrap();
            assert!(
                status.status.success(),
                "{}",
                String::from_utf8_lossy(&status.stderr)
            );
            let linked = scan_environment(Some(path_string(&root))).unwrap();
            assert!(!linked.counts_complete);
            assert_eq!(linked.counts.sample_e_files, 1);
            assert_eq!(linked.counts.help_html_files, 2);
            // Remove the junction itself before cleaning up the fixture.
            fs::remove_dir(junction).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }
}
