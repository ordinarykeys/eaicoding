use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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

    for candidate in [r"D:\e", r"C:\e", r"D:\Program Files\e", r"C:\Program Files (x86)\e"] {
        let path = PathBuf::from(candidate);
        if path.join("e.exe").exists() || path.join("lib").exists() {
            return path;
        }
    }

    PathBuf::from(r"D:\e")
}

fn count_matching_files(root: &Path, wanted_ext: &[&str]) -> usize {
    let mut count = 0usize;
    let mut stack = vec![root.to_path_buf()];

    while let Some(path) = stack.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
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

    count
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
pub fn scan_easy_language_env(root_path: Option<String>) -> Result<EasyLanguageEnvScan, String> {
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

    Ok(EasyLanguageEnvScan {
        root: path_string(&root),
        exists,
        is_compile_ready,
        e_exe: root.join("e.exe").exists().then(|| path_string(&root.join("e.exe"))),
        el_exe: root.join("el.exe").exists().then(|| path_string(&root.join("el.exe"))),
        help_dir: help_dir.exists().then(|| path_string(&help_dir)),
        lib_dir: lib_dir.exists().then(|| path_string(&lib_dir)),
        ecom_dir: ecom_dir.exists().then(|| path_string(&ecom_dir)),
        sdk_dir: sdk_dir.exists().then(|| path_string(&sdk_dir)),
        tools_dir: tools_dir.exists().then(|| path_string(&tools_dir)),
        linker_dir: linker_dir.exists().then(|| path_string(&linker_dir)),
        static_lib_dir: static_lib_dir.exists().then(|| path_string(&static_lib_dir)),
        counts: EasyLanguageEnvCounts {
            support_library_files: support_libraries.len(),
            module_files: modules.len(),
            sample_e_files: count_matching_files(&root, &["e"]),
            help_html_files: if help_dir.exists() {
                count_matching_files(&help_dir, &["htm", "html"])
            } else {
                0
            },
        },
        tools,
        support_libraries,
        modules,
        warnings,
    })
}
