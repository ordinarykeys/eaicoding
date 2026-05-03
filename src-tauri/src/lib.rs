mod crypto;
mod eagent_tools;
mod ecode_parser;
mod easy_language_sdk;
mod llm_models;
mod llm_proxy;
mod local_files;
mod mobile_bridge;
mod window_effects;

use crypto::{decrypt_secret, encrypt_secret};
use eagent_tools::detect_eagent_tools;
use ecode_parser::{
    compile_efile, export_efile_to_ecode, generate_efile_from_code, generate_efile_from_ecode,
    parse_efile, summarize_ecode_project_for_agent,
};
use easy_language_sdk::scan_easy_language_env;
use llm_models::fetch_llm_models;
use llm_proxy::llm_proxy_request;
use local_files::{read_text_file_for_agent, write_text_file};
use mobile_bridge::{
    get_mobile_bridge_state, poll_mobile_actions, publish_mobile_snapshot, start_mobile_bridge,
    stop_mobile_bridge, MobileBridgeState,
};
use tauri::Manager;
use window_effects::setup_window_effects;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MobileBridgeState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            setup_window_effects(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_efile,
            export_efile_to_ecode,
            summarize_ecode_project_for_agent,
            generate_efile_from_ecode,
            generate_efile_from_code,
            compile_efile,
            encrypt_secret,
            decrypt_secret,
            detect_eagent_tools,
            scan_easy_language_env,
            fetch_llm_models,
            llm_proxy_request,
            start_mobile_bridge,
            stop_mobile_bridge,
            get_mobile_bridge_state,
            poll_mobile_actions,
            publish_mobile_snapshot,
            write_text_file,
            read_text_file_for_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
