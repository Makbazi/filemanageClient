//! 外部播放器通路（0.3.0 需求1）+ ffmpeg 转码通路（0.3.3 需求3）：视频优先由
//! WebView `<video>` 走**系统解码器**（Windows WebView2→Media Foundation / Linux
//! webkitgtk→GStreamer，H.265 需系统 HEVC 组件）；缺组件/容器不受支持时，查看器
//! 与预览弹窗给出一键"外部播放器"兜底，且可在设置里配置为始终外部播放。打开的
//! 都是媒体缓存目录里已落盘的完整文件（`fs_media_cache`/`srv_media_cache` 的
//! 返回路径），Rust 侧不持文件锁，外部只读播放安全。
//!
//! 0.3.3：`ui.videoDecoder` 新增 "ffmpeg" 档 + `ui.ffmpegPath` 配置（空=PATH 探测
//! "ffmpeg"，不内嵌）——`ffmpeg_playable` 把 WebView 不能直放的媒体缓存条目转码成
//! H.264/AAC MP4（`<hash>.ffmpeg.mp4`，入媒体缓存、受磁盘 LRU、产物复用）；系统
//! 解码失败面板同样提供一键转码。`ffmpeg_probe` 供设置页探测可用性。
//! 转码是本机 CPU 行为，**不产生任何 fm-transfer 事件**（需求1：查看不触发传输）。

use crate::config;
use std::path::PathBuf;
use tauri::AppHandle;

/// 与 localfs kind_of / 前端 preview.ts VIDEO_EXT 同集合（不含 ts：撞 TypeScript）。
const VIDEO_EXT: &[&str] = &[
    "mp4", "m4v", "mkv", "mov", "webm", "avi", "flv", "wmv", "ogv", "ogm", "m2ts", "mts", "mpg",
    "mpeg", "mpe", "3gp", "vob", "hevc", "h265", "h264",
];

/// 仅允许打开媒体缓存目录内的文件（本命令不经 capabilities 门控，纵深防御）。
fn guarded_cache_path(st: &config::AppState, path: &str) -> Result<String, String> {
    let p = PathBuf::from(path);
    let p = std::fs::canonicalize(&p).map_err(|e| format!("文件不可访问: {e}"))?;
    if !p.is_file() {
        return Err("不是文件".into());
    }
    let dir = std::fs::canonicalize(st.media_cache_dir())
        .map_err(|e| format!("媒体缓存目录不可用: {e}"))?;
    if !p.starts_with(&dir) {
        return Err("仅允许打开媒体缓存内的文件".into());
    }
    Ok(p.to_string_lossy().into_owned())
}

/// 按用户配置的命令 argv 启动外部播放器：仅按双引号分词、**不经 shell**（因此
/// `&&`/管道等刻意不支持）；含 `{file}` 的参数位替换为文件路径，否则路径追加末位。
fn spawn_player_cmd(cmd: &str, path: &str) -> Result<(), String> {
    let mut toks = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    for ch in cmd.chars() {
        match ch {
            '"' => in_q = !in_q,
            c if c.is_whitespace() && !in_q => {
                if !cur.is_empty() {
                    toks.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        toks.push(cur);
    }
    if toks.is_empty() {
        return Err("播放器命令为空".into());
    }
    let prog = toks.remove(0);
    let mut args: Vec<String> = Vec::new();
    let mut used_ph = false;
    for t in toks {
        if t == "{file}" {
            args.push(path.into());
            used_ph = true;
        } else {
            args.push(t);
        }
    }
    if !used_ph {
        args.push(path.into());
    }
    let mut c = std::process::Command::new(&prog);
    c.args(&args);
    #[cfg(windows)]
    {
        // 控制台子系统播放器不闪黑窗（GUI 播放器不受影响）
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let child = c.spawn().map_err(|e| format!("启动外部播放器失败（{prog}）: {e}"))?;
    drop(child); // 分离运行：播放器生命周期独立于应用
    Ok(())
}

/// 前端入口：打开媒体缓存中的视频文件——按配置用外部播放器或系统关联播放器。
#[tauri::command]
pub fn open_media(app: AppHandle, path: String) -> Result<(), String> {
    let st = config::state(&app);
    let p = guarded_cache_path(&st, &path)?;
    let cmd = st.config().ui.video_player_cmd.clone().unwrap_or_default();
    if cmd.trim().is_empty() {
        // 系统关联播放器（opener 插件：unix=xdg-open / Windows=ShellExecute）
        tauri_plugin_opener::open_path(&p, None::<&str>).map_err(|e| format!("打开失败: {e}"))
    } else {
        spawn_player_cmd(&cmd, &p)
    }
}

/// ffmpeg 可执行文件（0.3.3 需求3）：配置路径优先，空=PATH 探测 "ffmpeg"。
fn ffmpeg_bin(st: &config::AppState) -> String {
    let t = st.config().ui.ffmpeg_path.clone().unwrap_or_default();
    let t = t.trim();
    if t.is_empty() {
        "ffmpeg".to_string()
    } else {
        t.to_string()
    }
}

/// Windows：控制台子系统 ffmpeg 不闪黑窗（GUI 无影响）。
#[cfg(windows)]
fn no_window(c: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn no_window(_c: &mut tokio::process::Command) {}

/// WebView 大概率可直放的容器/流扩展名（只看容器——无法窥编码，HEVC-in-mp4
/// 仍会系统解码失败，由失败面板"用 ffmpeg 转码播放"force 兜底）。
const WEBVIEW_DIRECT_EXT: &[&str] = &["mp4", "m4v", "mov", "webm", "m4a", "mp3", "ogg", "ogv"];

/// 设置页"探测 ffmpeg"（0.3.3 需求3）：跑 `-version` 返回首行版本串。
#[tauri::command]
pub async fn ffmpeg_probe(app: AppHandle) -> Result<String, String> {
    let bin = ffmpeg_bin(&config::state(&app));
    let mut c = tokio::process::Command::new(&bin);
    c.arg("-hide_banner").arg("-version");
    no_window(&mut c);
    let out = c.output().await.map_err(|e| {
        format!(
            "未找到 ffmpeg（{bin}）：{e}——请安装 ffmpeg，并在「设置→外观→视频播放」填写其路径（或留空走 PATH）"
        )
    })?;
    if !out.status.success() {
        return Err(format!(
            "ffmpeg -version 异常退出：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    Ok(text.lines().next().unwrap_or("").trim().to_string())
}

/// 媒体缓存视频 → 窗口内可播路径（0.3.3 需求3）。
///  - `force=false` 且容器已 WebView 友好 → 原路径直返（mp4/webm/...）；
///  - 否则转码 `<hash>.ffmpeg.mp4`（libx264/yuv420p/aac + faststart，入媒体缓存、
///    受磁盘 LRU、跨查看复用）；产物存在即 touch 返回。
///  - 转码失败清理半成品并报错（含 ffmpeg stderr 尾）——查看器据此给外部播放器
///    兜底入口。**全程不发 fm-transfer 事件**（需求1）。
#[tauri::command]
pub async fn ffmpeg_playable(app: AppHandle, path: String, force: Option<bool>) -> Result<String, String> {
    let st = config::state(&app);
    let src = guarded_cache_path(&st, &path)?;
    let ext = std::path::Path::new(&src)
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !force.unwrap_or(false) && WEBVIEW_DIRECT_EXT.contains(&ext.as_str()) {
        return Ok(src);
    }
    let key = crate::serverapi::simple_hash(&format!("ffmpeg|{src}"));
    let out = st.media_cache_dir().join(format!("{key:x}.ffmpeg.mp4"));
    if let Ok(m) = tokio::fs::metadata(&out).await {
        if m.len() > 0 {
            crate::cachemgr::touch(&out);
            return Ok(out.to_string_lossy().into_owned());
        }
        let _ = tokio::fs::remove_file(&out).await;
    }
    let bin = ffmpeg_bin(&st);
    let mut c = tokio::process::Command::new(&bin);
    c.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        &src,
        "-map_metadata",
        "-1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
    ])
    .arg(&out);
    no_window(&mut c);
    let out_status = c.output().await.map_err(|e| {
        format!("ffmpeg 启动失败（{bin}）：{e}——请在「设置→外观→视频播放」检查 ffmpeg 路径")
    })?;
    if !out_status.status.success() {
        let _ = tokio::fs::remove_file(&out).await;
        let full = String::from_utf8_lossy(&out_status.stderr).trim().to_string();
        // 按字符（非字节）截尾，避免中文报错在 UTF-8 边界上 panic
        let err: String = if full.chars().count() > 400 {
            let n = full.chars().count() - 400;
            full.chars().skip(n).collect()
        } else {
            full
        };
        return Err(format!("ffmpeg 转码失败: {err}"));
    }
    if tokio::fs::metadata(&out).await.map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = tokio::fs::remove_file(&out).await;
        return Err("ffmpeg 转码产物为空（源文件可能损坏）".into());
    }
    crate::serverapi::note_media_write(&st, &out);
    Ok(out.to_string_lossy().into_owned())
}

/// 设置页"测试外部播放器"：argv 启动指定命令并返回实际打开的探测文件路径。
/// 未显式给样本时取媒体缓存里最新的视频缓存条目；再没有则写 0 字节探测文件
/// （播放器报"无法解码"属正常——本测试仅验证启动与参数链路）。
#[tauri::command]
pub fn test_player_command(app: AppHandle, command: String) -> Result<String, String> {
    if command.trim().is_empty() {
        return Err("播放器命令为空".into());
    }
    let st = config::state(&app);
    let dir = st.media_cache_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let ep = ent.path();
            let ext = ep
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !VIDEO_EXT.contains(&ext.as_str()) {
                continue;
            }
            let t = ent
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            let better = match &best {
                Some((bt, _)) => t > *bt,
                None => true,
            };
            if better {
                best = Some((t, ep));
            }
        }
    }
    let probe = match best {
        Some((_, p)) => p.to_string_lossy().into_owned(),
        None => {
            let f = dir.join("fmc-selftest.mp4");
            if !f.exists() {
                std::fs::write(&f, []).map_err(|e| e.to_string())?;
            }
            f.to_string_lossy().into_owned()
        }
    };
    spawn_player_cmd(&command, &probe)?;
    Ok(probe)
}
