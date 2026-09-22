//! FileManage 客户端 Rust 侧入口：
//! config（配置）/ localdb（本地元数据 sqlite）/ localfs（本地目录+版本+媒体缓存）/
//! serverapi（分片传输+会话续期）/ ai（本地 AI）。

mod ai;
mod config;
mod localdb;
mod localfs;
mod secret;
mod serverapi;

use config::AppConfig;
use tauri::{AppHandle, Manager};

#[tauri::command]
fn get_config(app: AppHandle) -> AppConfig {
    config::state(&app).config()
}

/// 前端保存配置。0.6.0（需求1/8）：**服务端令牌与已记住账户索引是 Rust 侧
/// 独占的权威状态**（srv_login/try_refresh/srv_logout/cred_forget 维护，事件
/// fm-config-changed 广播同步）；本命令忽略前端快照携带的 token/refreshToken/
/// credentials——否则前端 800ms 防抖保存会把已轮换作废的旧令牌写回内存与
/// keyring，造成"选择远程后一直刷新/登录框反复弹出"。
#[tauri::command]
fn save_config(app: AppHandle, mut config: AppConfig) -> Result<AppConfig, String> {
    let st = config::state(&app);
    st.update(&app, move |c| {
        for s in config.servers.iter_mut() {
            if let Some(old) = c.servers.iter().find(|o| o.id == s.id) {
                s.token = old.token.clone();
                s.refresh_token = old.refresh_token.clone();
                if s.username.is_none() {
                    s.username = old.username.clone();
                }
            }
        }
        config.credentials = c.credentials.clone();
        *c = config;
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let cache = app.path().app_cache_dir()?;
            std::fs::create_dir_all(&dir).ok();
            std::fs::create_dir_all(&cache).ok();
            let st = std::sync::Arc::new(config::AppState::load(dir, cache)?);
            // 本地回收站过期自动清理（0.4.0，需求：30 天，与服务端各自独立；启动时执行一次）
            localfs::purge_expired_trash(&st);
            app.manage(st);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            // 本地目录
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
            localfs::fs_import,
            localfs::fs_export,
            localfs::fs_media_cache,
            // 本地版本管理（需求13）
            localfs::fs_versions_list,
            localfs::fs_versions_rollback,
            localfs::fs_versions_remove,
            // 服务端（分片传输/会话续期/预览缓存，需求3/11/22）
            serverapi::srv_login,
            serverapi::srv_logout,
            serverapi::srv_change_password,
            serverapi::srv_call,
            serverapi::srv_download,
            serverapi::srv_upload,
            serverapi::srv_media_cache,
            serverapi::srv_preview_data,
            serverapi::srv_thumb,
            serverapi::transfer_cancel,
            // 记住的服务端账户密码（0.6.0 需求3）
            serverapi::cred_take,
            serverapi::cred_forget,
            // 本地 AI
            ai::ai_describe_local,
            ai::ai_list_local,
            ai::ai_search_local
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
