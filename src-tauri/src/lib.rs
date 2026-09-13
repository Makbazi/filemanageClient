mod ai;
mod config;
mod localfs;
mod serverapi;

use config::AppConfig;
use tauri::{AppHandle, Manager};

#[tauri::command]
fn get_config(app: AppHandle) -> AppConfig {
    config::state(&app).config()
}

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<AppConfig, String> {
    let st = config::state(&app);
    st.update(&app, |c| *c = config)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir).ok();
            let st = std::sync::Arc::new(config::AppState::load(dir));
            app.manage(st);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            localfs::fs_list,
            localfs::fs_mkdir,
            localfs::fs_rename,
            localfs::fs_move,
            localfs::fs_copy,
            localfs::fs_delete,
            localfs::fs_trash_list,
            localfs::fs_trash_restore,
            localfs::fs_trash_remove,
            localfs::fs_trash_clear,
            localfs::fs_search,
            localfs::fs_preview,
            localfs::fs_write_bytes_b64,
            localfs::fs_read_bytes_b64,
            serverapi::srv_login,
            serverapi::srv_logout,
            serverapi::srv_call,
            serverapi::srv_download,
            serverapi::srv_upload,
            ai::ai_describe_local,
            ai::ai_list_local,
            ai::ai_search_local
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
