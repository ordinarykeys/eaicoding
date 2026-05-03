import { invoke } from "@tauri-apps/api/core";

export interface EasyLanguageLibraryInfo {
  name: string;
  fne_path: string;
  help_dir: string | null;
  command_doc_count: number;
  has_const_doc: boolean;
}

export interface EasyLanguageModuleInfo {
  name: string;
  path: string;
  bytes: number;
}

export interface EasyLanguageToolInfo {
  name: string;
  path: string;
  exists: boolean;
}

export interface EasyLanguageEnvCounts {
  support_library_files: number;
  module_files: number;
  sample_e_files: number;
  help_html_files: number;
}

export interface EasyLanguageEnvScan {
  root: string;
  exists: boolean;
  is_compile_ready: boolean;
  e_exe: string | null;
  el_exe: string | null;
  help_dir: string | null;
  lib_dir: string | null;
  ecom_dir: string | null;
  sdk_dir: string | null;
  tools_dir: string | null;
  linker_dir: string | null;
  static_lib_dir: string | null;
  tools: EasyLanguageToolInfo[];
  support_libraries: EasyLanguageLibraryInfo[];
  modules: EasyLanguageModuleInfo[];
  counts: EasyLanguageEnvCounts;
  warnings: string[];
}

export async function scanEasyLanguageEnv(rootPath?: string | null) {
  return invoke<EasyLanguageEnvScan>("scan_easy_language_env", {
    rootPath: rootPath?.trim() ? rootPath.trim() : null,
  });
}
