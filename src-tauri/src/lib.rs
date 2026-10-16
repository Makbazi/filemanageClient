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

// ---------- 媒体缓存自定义协议 fmc（0.3.8 需求5） ----------
//
// 缓存目录可在设置页改到应用缓存目录之外（旧目录可迁移），asset 协议的静态
// scope（$APPCACHE/**）覆盖不到任意路径；`<img>/<video>/<audio>/<embed>` 一律
// 改走 `fmc://localhost/m?p=<编码绝对路径>`（Windows 形态 `http://fmc.localhost/…`，
// 前端 mediaUrl 按平台分流）。安全纪律**严于放宽 scope**：canonicalize 后必须
// 位于**当前媒体缓存目录**内（同 media_read_bytes/open_media 纪律），否则 404；
// 支持单段 Range（音视频拖拽）。协议响应为同步全字节——视频媒体元素恒带 Range
// 分段拉取，内存占用可控。

/// 极简 percent-decode（`%XX`；非法序列原样保留）。
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn fmc_ctype(p: &std::path::Path) -> &'static str {
    match p
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "mp4" | "m4v" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "mkv" | "mpg" | "mpeg" | "avi" | "hevc" | "h265" | "h264" | "m2ts" | "ogv" => "video/mp4",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn fmc_http_error(code: tauri::http::StatusCode, msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(code)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// 单段 Range 解析："bytes=a-b" | "bytes=a-" | "bytes=-n"（后缀）。
/// 返回 Some((start,end)) 合法；None=无 Range；Some(None)=非法（416）。
fn parse_range(header: &str, total: u64) -> Option<Option<(u64, u64)>> {
    let spec0 = header.trim().strip_prefix("bytes=")?;
    if total == 0 {
        return None; // 空文件不走分段：落全量 200（长度为 0）
    }
    let spec = spec0.split(',').next().unwrap_or("").trim();
    let (a, b) = spec.split_once('-')?;
    let last = total - 1;
    if a.is_empty() {
        let n = b.trim().parse::<u64>().ok()?;
        if n == 0 {
            return Some(None);
        }
        Some(Some((total.saturating_sub(n), last)))
    } else {
        let start = a.trim().parse::<u64>().ok()?;
        if start > last {
            return Some(None);
        }
        let end = if b.trim().is_empty() {
            last
        } else {
            b.trim().parse::<u64>().ok()?.min(last)
        };
        if start > end {
            return Some(None);
        }
        Some(Some((start, end)))
    }
}

fn fmc_protocol(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::http::header;
    let st = config::state(ctx.app_handle());
    let enc = match request.uri().query().unwrap_or("").split('&').find_map(|kv| kv.strip_prefix("p=")) {
        Some(v) => v,
        None => return fmc_http_error(tauri::http::StatusCode::BAD_REQUEST, "missing path"),
    };
    let path = percent_decode(enc);
    let dir = match std::fs::canonicalize(st.media_cache_dir()) {
        Ok(d) => d,
        Err(_) => return fmc_http_error(tauri::http::StatusCode::NOT_FOUND, "cache dir unavailable"),
    };
    let abs = match std::fs::canonicalize(&path) {
        Ok(p) => p,
        Err(_) => return fmc_http_error(tauri::http::StatusCode::NOT_FOUND, "not found"),
    };
    // 守卫：仅当前媒体缓存目录内的文件（越界与默认目录切换后的旧路径一律 404）
    if !abs.starts_with(&dir) || !abs.is_file() {
        return fmc_http_error(tauri::http::StatusCode::NOT_FOUND, "not found");
    }
    let total = match abs.metadata() {
        Ok(m) => m.len(),
        Err(_) => return fmc_http_error(tauri::http::StatusCode::NOT_FOUND, "not found"),
    };
    let ctype = fmc_ctype(&abs).to_string();
    let range_hdr = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let seg = range_hdr.as_deref().and_then(|h| parse_range(h, total));
    if let Some(seg) = seg {
        let (start, end) = match seg {
            Some(p) => p,
            None => {
                return fmc_http_error(tauri::http::StatusCode::RANGE_NOT_SATISFIABLE, "bad range")
            }
        };
        let len = (end - start + 1) as usize;
        let mut f = match std::fs::File::open(&abs) {
            Ok(f) => f,
            Err(_) => return fmc_http_error(tauri::http::StatusCode::NOT_FOUND, "not found"),
        };
        if f.seek(SeekFrom::Start(start)).is_err() {
            return fmc_http_error(tauri::http::StatusCode::INTERNAL_SERVER_ERROR, "seek failed");
        }
        let mut buf = Vec::with_capacity(len.min(64 << 20));
        if f.take(len as u64).read_to_end(&mut buf).is_err() {
            return fmc_http_error(tauri::http::StatusCode::INTERNAL_SERVER_ERROR, "read failed");
        }
        let cr = format!("bytes {}-{}/{}", start, start + buf.len() as u64 - 1, total);
        return tauri::http::Response::builder()
            .status(tauri::http::StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, ctype)
            .header(header::CONTENT_LENGTH, buf.len())
            .header(header::CONTENT_RANGE, cr)
            .header(header::ACCEPT_RANGES, "bytes")
            .body(buf)
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()));
    }
    let buf = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(_) => return fmc_http_error(tauri::http::StatusCode::NOT_FOUND, "not found"),
    };
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CONTENT_LENGTH, buf.len())
        .header(header::ACCEPT_RANGES, "bytes")
        .body(buf)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
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
        // 0.3.8 需求5：媒体缓存出图协议（自定义缓存目录不受 asset 静态 scope 覆盖；
        // 守卫=当前缓存目录内 + Range 支持，见 fmc_protocol 注释）
        .register_uri_scheme_protocol("fmc", fmc_protocol)
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
            // 0.3.7 需求2：账本恢复对账（本地 mtime 判据）
            localfs::fs_mtimes,
            cachemgr::media_read_bytes,
            cachemgr::cache_stats,
            cachemgr::cache_clear,
            // 0.3.8 需求5：缓存目录显示/切换/迁移
            cachemgr::cache_dir_info,
            cachemgr::cache_set_dir,
            // 0.3.2：上传账本（重启续传兜底）
            localdb::lg_new_group,
            localdb::lg_set_children,
            localdb::lg_list_pending,
            localdb::lg_group_items,
            localdb::lg_group_status,
            // 0.3.7 需求2：恢复对账落条目终态（会话 completed//check same → done）
            localdb::lg_item_state,
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
            // 0.3.7 需求1：转码取消（作业注册表 + 进度事件配套 fm-ffmpeg）
            player::ffmpeg_cancel,
            // 0.3.7 需求3 第 4 档：ffmpeg 解码+原生渲染（媒体信息/逐帧解码/音轨提取）
            player::video_media_info,
            player::ffmpeg_frame,
            // 0.3.8 需求2：渲染档批量连续解码（一次进程解 N 帧，帧率对齐源）
            player::ffmpeg_frames,
            player::ffmpeg_audio_track,
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
                // 0.3.7 需求1：先杀全部在飞 ffmpeg 转码作业再登出——异常拆栈场景
                // 由 kill_on_drop 兜底，退出钩子保证不留跨会话孤儿进程续写产物。
                player::ffmpeg_cancel_all(app);
                serverapi::logout_all_for_exit(app);
            }
        });
}
