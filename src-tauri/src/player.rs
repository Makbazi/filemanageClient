//! 外部播放器通路（0.3.0 需求1）：视频优先由 WebView `<video>` 走**系统解码器**
//! （Windows WebView2→Media Foundation / Linux webkitgtk→GStreamer，H.265 需系统
//! HEVC 组件）；缺组件/容器不受支持时，查看器与预览弹窗给出一键"外部播放器"兜底，
//! 且可在设置里配置为始终外部播放。打开的都是媒体缓存目录里已落盘的完整文件
//! （`fs_media_cache`/`srv_media_cache` 的返回路径），Rust 侧不持文件锁，外部只读播放安全。

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
