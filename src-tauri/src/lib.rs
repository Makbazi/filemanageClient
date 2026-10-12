//! FileManage 客户端 Rust 侧入口：
//! config（配置）/ localdb（本地元数据 sqlite + 上传账本）/ localfs（本地目录+版本+媒体缓存）/
//! serverapi（分片传输+会话续期）/ ai（本地 AI）/ thumb（缩略图与 RAW 内嵌预览提取）/
//! cachemgr（媒体缓存磁盘配额 LRU，0.3.2）。

mod ai;
mod cachemgr;
mod config;
mod localdb;
mod localfs;
mod player;
mod secret;
mod serverapi;
mod thumb;

use config::AppConfig;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

/// 托盘可用性（0.3.0 需求2）：构建失败（无 AppIndicator 宿主环境等）→ 关闭按钮
/// 自动退回"退出"行为，绝不把用户关进无窗口的黑盒。
static TRAY_OK: AtomicBool = AtomicBool::new(false);
/// 正在主动退出程序（托盘菜单「退出」）：不再按 tray 配置拦截 CloseRequested。
static QUITTING: AtomicBool = AtomicBool::new(false);

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 系统托盘（需求2）：菜单 = 显示主窗口 / 退出；右键出菜单，左键单击/双击仅唤醒
/// 已隐藏的窗口（tauri 源码注明 Linux appindicator 不派发点击事件——Linux 上
/// 恢复窗口的主路径就是菜单项）。图标复用应用默认窗口图标。
fn build_tray(app: &mut tauri::App) -> Result<(), String> {
    let icon = app.default_window_icon().cloned().ok_or("无默认窗口图标")?;
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = PredefinedMenuItem::quit(app, Some("退出 FileManage")).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &sep, &quit]).map_err(|e| e.to_string())?;
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("FileManage · 文件管理")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| {
            if e.id() == "show" {
                show_main(app);
            } else if e.id() == "quit" {
                QUITTING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, e| {
            let hit = matches!(
                e,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick { .. }
            );
            if !hit {
                return;
            }
            // 只负责唤醒（隐藏态恢复），不做左键隐藏——隐藏入口恒为窗口关闭按钮
            let app = tray.app_handle();
            if let Some(w) = app.get_webview_window("main") {
                if !w.is_visible().unwrap_or(true) {
                    show_main(app);
                }
            }
        })
        .build(app)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config(app: AppHandle) -> AppConfig {
    config::state(&app).config()
}

/// 前端保存配置。需求1/8：**服务端令牌与已记住账户索引是 Rust 侧
/// 独占的权威状态**（srv_login/try_autologin/srv_logout/cred_forget 维护，事件
/// fm-config-changed 广播同步）；本命令忽略前端快照携带的 token/credentials——
/// 否则前端 800ms 防抖保存会把已作废的旧令牌写回内存与 keyring，造成
/// "选择远程后一直刷新/登录框反复弹出"。
#[tauri::command]
fn save_config(app: AppHandle, mut config: AppConfig) -> Result<AppConfig, String> {
    let st = config::state(&app);
    st.update(&app, move |c| {
        for s in config.servers.iter_mut() {
            if let Some(old) = c.servers.iter().find(|o| o.id == s.id) {
                s.token = old.token.clone();
                if s.username.is_none() {
                    s.username = old.username.clone();
                }
            }
        }
        config.credentials = c.credentials.clone();
        // 0.3.6：客户端唯一标识同样是 Rust 侧权威状态——前端快照缺失/为空时
        // 绝不把本机标识清空（清空=下次启动换标识=全部绑定会话作废）。
        if config.client_id.is_empty() {
            config.client_id = c.client_id.clone();
        }
        *c = config;
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // 单实例（0.3.0 需求2 配套）：托盘常驻后重复启动不再开第二个实例，只唤醒已有窗口
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let cache = app.path().app_cache_dir()?;
            std::fs::create_dir_all(&dir).ok();
            std::fs::create_dir_all(&cache).ok();
            let st = std::sync::Arc::new(config::AppState::load(dir, cache)?);
            // 本地回收站过期自动清理（需求：30 天，与服务端各自独立；启动时执行一次）
            localfs::purge_expired_trash(&st);
            // 0.3.2：上传账本清理（终态超 7 天的组/条目回收）+ 媒体缓存计数初始化
            // 与一次配额淘汰（上次退出遗留的孤儿 .part/.raw-src 也在此回收）
            {
                let guard = st.db.lock();
                if let Ok(db) = guard {
                    let _ = localdb::journal_prune(&db);
                }
            }
            cachemgr::init_counter(&st);
            cachemgr::enforce(&st);
            app.manage(st);
            // 媒体缓存周期巡检（300s：过期断点碎片 + 超限 LRU 淘汰）
            cachemgr::spawn_sweeper(&app.handle().clone());
            // 托盘常驻（需求2）：托盘不可用绝不使启动失败——关闭按钮按配置直接退出
            match build_tray(app) {
                Ok(()) => TRAY_OK.store(true, Ordering::SeqCst),
                Err(e) => eprintln!("托盘不可用（关闭按钮将按配置直接退出）: {e}"),
            }
            Ok(())
        })
        // 关闭按钮(X)拦截（需求2）：closeAction=tray 且托盘可用且非主动退出 →
        // 阻止关闭并隐藏（先退全屏，避免隐藏态残留全屏）；否则放行，末窗口关闭进程自然退出。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let to_tray = !QUITTING.load(Ordering::SeqCst)
                    && TRAY_OK.load(Ordering::SeqCst)
                    && config::state(window.app_handle()).config().ui.close_action == "tray";
                if to_tray {
                    api.prevent_close();
                    if window.is_fullscreen().unwrap_or(false) {
                        let _ = window.set_fullscreen(false);
                    }
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            // 本地目录
            localfs::fs_list,
            localfs::fs_walk,
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
            localfs::fs_thumb,
            // 0.3.2：目录重传校验（本地哈希）+ 缓存体系（字节读/用量/清空）
            localfs::fs_file_hashes,
            cachemgr::media_read_bytes,
            cachemgr::cache_stats,
            cachemgr::cache_clear,
            // 0.3.2：上传账本（重启续传兜底）
            localdb::lg_new_group,
            localdb::lg_set_children,
            localdb::lg_list_pending,
            localdb::lg_group_items,
            localdb::lg_group_status,
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
            // 外部播放器（0.3.0 需求1：系统解码失败兜底 / 可配置播放器 / 设置页测试）
            player::open_media,
            player::test_player_command,
            // ffmpeg 转码播放（0.3.3 需求3：ffmpeg 档位 + 设置页探测；不内嵌 ffmpeg）
            player::ffmpeg_probe,
            player::ffmpeg_playable,
            // 0.3.6：视频编码探测（H.265 自动转码编排；ffmpeg -i 窥首轨编码）
            player::video_codec_probe,
            // 记住的服务端账户密码（需求3）
            serverapi::cred_take,
            serverapi::cred_forget,
            // 本地 AI
            ai::ai_describe_local,
            ai::ai_list_local,
            ai::ai_search_local
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 0.3.6（配套 Server 0.2.4 单凭证契约）：正常退出前尽力撤销各服务端
            // 登录凭证——"客户端退出即需重新登录"由下一次启动的自动重登承接；
            // 异常退出走不到这里，由服务端闲置 1h 滑动过期兜底。
            if let tauri::RunEvent::ExitRequested { .. } = event {
                serverapi::logout_all_for_exit(app);
            }
        });
}
