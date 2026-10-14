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
//! 0.3.6（修 H.265 无法播放）：新增 `video_codec_probe`/`probe_video_codec`——
//! 以 `ffmpeg -i` 窥首轨真实编码（旧实现只看容器后缀，HEVC-in-mp4 被放行给
//! webview 必失败）；ffmpeg 档短路前先探测，system 档查看器探测到 HEVC 自动转码
//! 或直出引导面板（FileViewer 侧编排），不再撞一次必然失败的解码。
//! 转码是本机 CPU 行为，**不产生任何 fm-transfer 事件**（需求1：查看不触发传输）。
//!
//! 0.3.7（需求1 修"转码无进度/无法取消/重开误报 ffmpeg 不可用" + 需求3 四档）：
//! - 转码作业治理：产物改 `<key>.ffmpeg.mp4.part` 暂存 + 成功后原子 rename——旧实现
//!   `metadata(len>0)` 即复用半成品（`+faststart` 的 moov 在正常退出时才写，中断产物
//!   永不可播却永被当成品），重开秒回坏文件 → 解码失败循环报"不可用"；`.part` 后缀
//!   天然进 cachemgr 孤儿碎片回收（24h），半成品不再毒化缓存。
//! - `kill_on_drop(true)` + 作业注册表（key→取消标志+Notify）+ `ffmpeg_cancel` 命令：
//!   `-progress pipe:1` 逐行驱动 `fm-ffmpeg` 进度事件（out_time_ms/时长→百分比），
//!   前端转圈面板显示百分比并给 [取消]；查看器卸载即取消，退出钩子清空全部作业——
//!   不再留孤儿 ffmpeg 跨会话续写产物（Windows 句柄占用致 `-y` 重开输出失败的
//!   "ffmpeg 不可用"假象随之消失）。
//! - 每 key single-flight（对齐 srv_media_ensure 的 MEDIA_FLIGHT 纪律）：并发调用
//!   排队复用，不再双起 ffmpeg 互踩同一 `-y` 输出。
//! - `probe_video_info`：`ffmpeg -i` 一次窥探（编码/时长/音轨），正向缓存；
//!   `video_media_info` 供前端渲染档取用。
//! - 需求3 第 4 档 `render`（自定义 ffmpeg 解码 + 原生渲染）：`ffmpeg_frame`
//!   按需解单帧 JPEG（`-ss` 输入侧定位 + mjpeg 管道，逐帧不落盘），
//!   `ffmpeg_audio_track` 抽音轨为 `<key>.audio.m4a`（同样 .part 暂存）——前端
//!   canvas/img 上帧 + `<audio>` 对时，无音轨自动退化静音时钟。产物/管线全本地，
//!   仍零 fm-transfer。

use crate::config;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::Notify;

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
fn no_window(c: &mut TokioCommand) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn no_window(_c: &mut TokioCommand) {}

/// WebView 大概率可直放的容器/流扩展名（0.3.6 起不再盲信容器——先窥编码再决定
/// 短路，HEVC-in-mp4 会在此被识别并转码，见 probe_video_info）。
const WEBVIEW_DIRECT_EXT: &[&str] = &["mp4", "m4v", "mov", "webm", "m4a", "mp3", "ogg", "ogv"];

/// WebView 系统解码器普遍不支持的帧内编码（探测命中即走 ffmpeg 转码）。
pub fn is_webview_unfriendly_codec(codec: &str) -> bool {
    matches!(codec, "hevc" | "hvc1" | "hev1")
}

/// `ffmpeg -i` 一次窥探的结果（0.3.7：编码/时长/音轨三合一，替代 0.3.6 的
/// 只取编码——转码进度总时长与渲染档时间轴同源于此，一处探测三处复用）。
#[derive(Clone, Debug, Default)]
struct VideoInfo {
    /// 首条视频轨编码名（小写）；空=判不了（ffmpeg 缺失/无视频轨/畸形）
    codec: String,
    /// 时长（秒）；0=未知
    duration: f64,
    /// 是否有音轨
    audio: bool,
}

fn info_cache() -> &'static Mutex<HashMap<String, VideoInfo>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, VideoInfo>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 解析 `-i` 报告 stderr：首条 `Video:` 编码名、`Duration: HH:MM:SS.xx`、`Audio:` 有无。
fn parse_ffmpeg_report(text: &str) -> VideoInfo {
    let mut info = VideoInfo::default();
    if let Some(pos) = text.find("Video:") {
        let rest = &text[pos + "Video:".len()..];
        info.codec = rest
            .trim_start()
            .split(|ch: char| ch == ' ' || ch == '(' || ch == ',')
            .next()
            .unwrap_or("")
            .trim()
            .to_lowercase();
    }
    if let Some(pos) = text.find("Duration:") {
        let rest = &text[pos + "Duration:".len()..];
        let tok: String = rest
            .trim_start()
            .split(|ch: char| ch == ',' || ch == ' ' || ch == '\n')
            .next()
            .unwrap_or("")
            .to_string();
        // "00:01:23.45" → 秒；解析失败保持 0
        let parts: Vec<&str> = tok.split(':').collect();
        if parts.len() == 3 {
            let h: f64 = parts[0].parse().unwrap_or(0.0);
            let m: f64 = parts[1].parse().unwrap_or(0.0);
            let s: f64 = parts[2].parse().unwrap_or(0.0);
            let secs = h * 3600.0 + m * 60.0 + s;
            if secs > 0.0 {
                info.duration = secs;
            }
        }
    }
    info.audio = text.contains("Audio:");
    info
}

/// 媒体窥探（正向结果按路径缓存；codec 判不了不缓存——配好 ffmpeg 后立即可得，
/// 与 0.3.6 video_codec_probe 的缓存纪律一致）。
async fn probe_video_info(st: &config::AppState, src: &str) -> VideoInfo {
    if let Ok(map) = info_cache().lock() {
        if let Some(hit) = map.get(src) {
            return hit.clone();
        }
    }
    let bin = ffmpeg_bin(st);
    let mut c = TokioCommand::new(&bin);
    c.args(["-hide_banner", "-i", src]);
    no_window(&mut c);
    let info = match c.output().await {
        Ok(out) => parse_ffmpeg_report(&String::from_utf8_lossy(&out.stderr)),
        Err(_) => VideoInfo::default(), // ffmpeg 缺失/不可执行：全判不了
    };
    if !info.codec.is_empty() {
        if let Ok(mut map) = info_cache().lock() {
            if map.len() > 512 {
                map.clear(); // 粗粒度回收：探测成本低，整表重置可接受
            }
            map.insert(src.to_string(), info.clone());
        }
    }
    info
}

/// 前端入口（0.3.6，0.3.7 扩信息面）：媒体缓存视频 → {codec, duration, audio}
/// （codec ""=判不了；duration 0=未知）。渲染档时间轴/进度分母取这里。
#[tauri::command]
pub async fn video_media_info(app: AppHandle, path: String) -> Result<serde_json::Value, String> {
    let st = config::state(&app);
    let src = guarded_cache_path(&st, &path)?;
    let info = probe_video_info(&st, &src).await;
    Ok(serde_json::json!({
        "codec": info.codec,
        "duration": info.duration,
        "audio": info.audio,
    }))
}

/// 前端入口（0.3.6）：媒体缓存视频 → 首轨编码名（""=判不了）。
#[tauri::command]
pub async fn video_codec_probe(app: AppHandle, path: String) -> Result<String, String> {
    let st = config::state(&app);
    let src = guarded_cache_path(&st, &path)?;
    Ok(probe_video_info(&st, &src).await.codec)
}

/// 设置页"探测 ffmpeg"（0.3.3 需求3）：跑 `-version` 返回首行版本串。
#[tauri::command]
pub async fn ffmpeg_probe(app: AppHandle) -> Result<String, String> {
    let bin = ffmpeg_bin(&config::state(&app));
    let mut c = TokioCommand::new(&bin);
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

// ---------- 转码作业治理（0.3.7 需求1） ----------

/// 进行中的 ffmpeg 作业：取消标志 + Notify（select 等待即时打断）；key=产物哈希串。
struct FfmpegJob {
    cancel: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

fn ffmpeg_jobs() -> &'static Mutex<HashMap<String, Arc<FfmpegJob>>> {
    static JOBS: std::sync::OnceLock<Mutex<HashMap<String, Arc<FfmpegJob>>>> =
        std::sync::OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 每 key single-flight（对齐 srv_media_ensure 的 MEDIA_FLIGHT 纪律）：同产物并发
/// 调用排队执行，第二个进来等第一个完成走"存在即复用"，不再双起 ffmpeg 互踩。
fn ffmpeg_flights() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static FLIGHTS: std::sync::OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        std::sync::OnceLock::new();
    FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn flight_for(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut m = ffmpeg_flights().lock().unwrap();
    if m.len() > 256 {
        m.retain(|_, f| f.try_lock().is_err()); // 只清无人在飞的（粗粒度回收）
    }
    m.entry(key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 转码产物的稳定 key（媒体缓存目录内 `<key>.ffmpeg.mp4`）。
fn ffmpeg_key(src: &str) -> String {
    format!("{:x}", crate::serverapi::simple_hash(&format!("ffmpeg|{src}")))
}

/// 进度/终态事件：path=规范化路径，**orig=调用方传入的原路径**——前端媒体缓存
/// 路径与 canonicalize 结果可能因符号链接/大小写不一致，按 orig 过滤才稳。
fn emit_progress(app: &AppHandle, key: &str, src: &str, orig: &str, status: &str, secs: f64, total: f64, pct: i32) {
    let _ = app.emit(
        "fm-ffmpeg",
        serde_json::json!({
            "key": key, "path": src, "orig": orig, "status": status,
            "secs": secs, "total": total, "pct": pct,
        }),
    );
}

/// 起 ffmpeg 转码到 `part` 路径（.part 暂存，成功后由调用方 rename）。
/// `-progress pipe:1` 逐块输出 `out_time_ms=`（µs）驱动 `fm-ffmpeg` 进度事件；
/// 取消标志经注册表置位 + Notify 唤醒 select → start_kill + 清 .part。
/// 返回 Err 即产物作废（.part 已尽力删除），绝不留下"半成品=成品"的复用毒源。
async fn transcode_run(
    app: &AppHandle,
    st: &config::AppState,
    key: &str,
    src: &str,
    orig: &str,
    total_secs: f64,
    part: &std::path::Path,
) -> Result<(), String> {
    let bin = ffmpeg_bin(st);
    let job = Arc::new(FfmpegJob {
        cancel: Arc::new(AtomicBool::new(false)),
        notify: Arc::new(Notify::new()),
    });
    ffmpeg_jobs().lock().unwrap().insert(key.to_string(), job.clone());
    // 进入即清同名陈旧 .part（上次异常崩溃/取消留下的碎片；被在跑进程占用则删失败
    // 也无碍——本进程会 -y 覆写）
    let _ = tokio::fs::remove_file(part).await;

    let mut c = TokioCommand::new(&bin);
    c.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-progress",
        "pipe:1",
        "-i",
        src,
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
        "-f",
        "mp4",
    ])
    .arg(part)
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    // 关键（0.3.7 需求1）：任务 future 被丢弃（应用退出/异常拆栈）即杀子进程——
    // tokio 默认 kill_on_drop=false 会让 ffmpeg 跨会话续写产物，正是"关闭重开误报
    // ffmpeg 不可用"的孤儿进程根因。
    .kill_on_drop(true);
    no_window(&mut c);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => {
            ffmpeg_jobs().lock().unwrap().remove(key);
            return Err(format!(
                "ffmpeg 启动失败（{bin}）：{e}——请在「设置→外观→视频播放」检查 ffmpeg 路径"
            ));
        }
    };

    // stdout/stderr 在 builder 上已 piped，take() 必为 Some
    let mut so = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut se = BufReader::new(child.stderr.take().expect("piped stderr"));
    let mut sline = String::new();
    let mut eline = String::new();
    let mut err_lines: Vec<String> = Vec::new();
    let mut cancelled = false;
    let mut so_eof = false;
    let mut se_eof = false;
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);

    let cancel_wait = job.notify.notified();
    tokio::pin!(cancel_wait);
    // 立刻注册唤醒（覆盖 spawn 到首次 select 轮询之间的取消窗口——此窗口内
    // notify_waiters 若先于注册到达，enable 后的 waiter 仍能收到）
    cancel_wait.as_mut().enable();

    while !(so_eof && se_eof) && !cancelled {
        if job.cancel.load(Ordering::SeqCst) {
            let _ = child.start_kill();
            cancelled = true;
            break;
        }
        tokio::select! {
            r = so.read_line(&mut sline), if !so_eof => {
                match r {
                    Ok(0) => so_eof = true,
                    Ok(_) => {
                        let l = sline.trim_end();
                        if let Some(v) = l.strip_prefix("out_time_ms=") {
                            if let Ok(us) = v.trim().parse::<f64>() {
                                let secs = us / 1_000_000.0;
                                let pct = if total_secs > 0.0 {
                                    ((secs / total_secs) * 100.0).min(99.0).max(0.0) as i32
                                } else { 0 };
                                if last_emit.elapsed().as_millis() >= 300 {
                                    last_emit = std::time::Instant::now();
                                    emit_progress(app, key, src, orig, "progress", secs, total_secs, pct);
                                }
                            }
                        }
                        sline.clear();
                    }
                    Err(_) => so_eof = true,
                }
            }
            r = se.read_line(&mut eline), if !se_eof => {
                match r {
                    Ok(0) => se_eof = true,
                    Ok(_) => {
                        if err_lines.len() < 40 {
                            err_lines.push(eline.trim_end().to_string());
                        }
                        eline.clear();
                    }
                    Err(_) => se_eof = true,
                }
            }
            _ = &mut cancel_wait => {
                let job2 = ffmpeg_jobs().lock().unwrap().get(key).cloned();
                if job2.map(|j| j.cancel.load(Ordering::SeqCst)).unwrap_or(true) {
                    let _ = child.start_kill();
                    cancelled = true;
                }
            }
        }
    }
    // 兜底：select 循环外取消标志已被置位（如 break 前最后一瞬）
    if !cancelled && job.cancel.load(Ordering::SeqCst) {
        let _ = child.start_kill();
        cancelled = true;
    }
    let status = child.wait().await;
    ffmpeg_jobs().lock().unwrap().remove(key);

    if cancelled {
        let _ = tokio::fs::remove_file(part).await;
        emit_progress(app, key, src, orig, "cancelled", 0.0, total_secs, 0);
        return Err("转码已取消".into());
    }
    let ok = status.map(|s| s.success()).unwrap_or(false);
    if !ok {
        let _ = tokio::fs::remove_file(part).await;
        let full = err_lines.join("\n").trim().to_string();
        // 按字符（非字节）截尾，避免中文报错在 UTF-8 边界上 panic
        let err: String = if full.chars().count() > 400 {
            let n = full.chars().count() - 400;
            full.chars().skip(n).collect()
        } else {
            full
        };
        emit_progress(app, key, src, orig, "error", 0.0, total_secs, 0);
        return Err(format!("ffmpeg 转码失败: {err}"));
    }
    if tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = tokio::fs::remove_file(part).await;
        return Err("ffmpeg 转码产物为空（源文件可能损坏）".into());
    }
    Ok(())
}

/// 媒体缓存视频 → 窗口内可播路径（0.3.3 需求3；0.3.7 治理重写）。
///  - `force=false` 且容器已 WebView 友好 → 原路径直返（mp4/webm/...）；
///  - 否则转码 `<key>.ffmpeg.mp4`（libx264/yuv420p/aac + faststart，入媒体缓存、
///    受磁盘 LRU、跨查看复用）；**成品存在**即 touch 返回——`.part` 暂存 +
///    成功 rename 保证"存在=完整"，中断碎片 24h 内被 cachemgr 顺带回收；
///  - 同 key 并发排队复用（single-flight）；进度经 `fm-ffmpeg` 事件透出，
///    `ffmpeg_cancel` 可中途打断；
///  - 转码失败清理半成品并报错（含 ffmpeg stderr 尾）——查看器据此给外部播放器
///    兜底入口。**全程不发 fm-transfer 事件**（需求1）。
#[tauri::command]
pub async fn ffmpeg_playable(app: AppHandle, path: String, force: Option<bool>) -> Result<String, String> {
    let st = config::state(&app);
    let orig = path.clone();
    let src = guarded_cache_path(&st, &path)?;
    let ext = std::path::Path::new(&src)
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase();
    // 0.3.6：容器直放短路前先窥编码——HEVC-in-mp4 不再短路、直接转码
    // （修"H.265 依旧无法播放"的容器盲区）；判不了（ffmpeg 缺失等）维持
    // 旧行为原路返回，由查看器系统解码失败面板兜底。
    if !force.unwrap_or(false) && WEBVIEW_DIRECT_EXT.contains(&ext.as_str()) {
        let info = probe_video_info(&st, &src).await;
        if !is_webview_unfriendly_codec(&info.codec) {
            return Ok(src);
        }
    }
    let key = ffmpeg_key(&src);
    let out = st.media_cache_dir().join(format!("{key}.ffmpeg.mp4"));
    if let Ok(m) = tokio::fs::metadata(&out).await {
        if m.len() > 0 {
            crate::cachemgr::touch(&out);
            return Ok(out.to_string_lossy().into_owned());
        }
        let _ = tokio::fs::remove_file(&out).await;
    }
    // single-flight：排队者醒来先看成品，没有再转（防双 ffmpeg 互踩 -y 输出）
    let flight = flight_for(&key);
    let _guard = flight.lock().await;
    if let Ok(m) = tokio::fs::metadata(&out).await {
        if m.len() > 0 {
            crate::cachemgr::touch(&out);
            return Ok(out.to_string_lossy().into_owned());
        }
        let _ = tokio::fs::remove_file(&out).await;
    }
    let total = probe_video_info(&st, &src).await.duration;
    let part = st.media_cache_dir().join(format!("{key}.ffmpeg.mp4.part"));
    transcode_run(&app, &st, &key, &src, &orig, total, &part).await?;
    if tokio::fs::rename(&part, &out).await.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("转码产物落盘失败（媒体缓存目录写入异常）".into());
    }
    crate::cachemgr::touch(&out);
    crate::serverapi::note_media_write(&st, &out);
    emit_progress(&app, &key, &src, &orig, "done", total, total, 100);
    Ok(out.to_string_lossy().into_owned())
}

/// 取消进行中的 ffmpeg 转码（0.3.7 需求1）：置标志 + 唤醒 select，ffmpeg 被 kill、
/// `.part` 清除。无在飞作业静默成功（幂等——前端卸载清理路径总调用不判备）。
#[tauri::command]
pub fn ffmpeg_cancel(app: AppHandle, path: String) -> Result<(), String> {
    let st = config::state(&app);
    let src = guarded_cache_path(&st, &path)?;
    let key = ffmpeg_key(&src);
    if let Some(job) = ffmpeg_jobs().lock().unwrap().get(&key) {
        job.cancel.store(true, Ordering::SeqCst);
        job.notify.notify_waiters();
    }
    Ok(())
}

/// 全量取消（退出钩子，lib.rs ExitRequested）：不留任何孤儿 ffmpeg 跨会话续写。
pub fn ffmpeg_cancel_all(app: &AppHandle) {
    let _ = app;
    let mut n = 0;
    if let Ok(map) = ffmpeg_jobs().lock() {
        for job in map.values() {
            job.cancel.store(true, Ordering::SeqCst);
            job.notify.notify_waiters();
            n += 1;
        }
    }
    if n > 0 {
        eprintln!("退出前取消 {n} 个进行中的 ffmpeg 转码作业");
    }
}

// ---------- 渲染档（0.3.7 需求3 第 4 档：ffmpeg 解码 + 原生渲染） ----------

/// 逐帧解码的小缓存（key=(src, 时间桶, maxh)）：拖动/回看同一时间点免重解。
fn frame_cache() -> &'static Mutex<HashMap<(String, i64, u32), Arc<Vec<u8>>>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<(String, i64, u32), Arc<Vec<u8>>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 按需解一帧（渲染档心跳调用）：`-ss` 输入侧定位（关键帧邻域内精确定位，
/// ffmpeg 默认行为）→ 单帧 mjpeg（高度 ≤maxh、宽按比例）→ stdout 管道字节。
/// **不落盘、不产生任何缓存文件**——"解码+原生渲染"与"转码"的区别即在此：
/// 帧即解即用，前端 canvas 上屏。耗时随源编码/分辨率增大，CPU 行为零传输。
#[tauri::command]
pub async fn ffmpeg_frame(
    app: AppHandle,
    path: String,
    time: f64,
    maxh: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    let st = config::state(&app);
    let src = guarded_cache_path(&st, &path)?;
    let maxh = maxh.unwrap_or(540).clamp(120, 1080);
    let t = if time.is_finite() { time.max(0.0) } else { 0.0 };
    let bucket = (t * 4.0) as i64; // 0.25s 时间桶
    let ck = (src.clone(), bucket, maxh);
    if let Some(hit) = frame_cache().lock().unwrap().get(&ck) {
        return Ok(tauri::ipc::Response::new(hit.as_ref().clone()));
    }
    let bin = ffmpeg_bin(&st);
    let mut c = TokioCommand::new(&bin);
    let vf = format!("scale=w=-2:h='min({maxh},ih)'");
    c.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        &format!("{t:.3}"),
        "-i",
        &src,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-vf",
        &vf,
        "-c:v",
        "mjpeg",
        "-q:v",
        "6",
        "-f",
        "image2",
    ])
    .arg("pipe:1")
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
    no_window(&mut c);
    let out = c.output().await.map_err(|e| {
        format!("ffmpeg 启动失败（{bin}）：{e}——请在「设置→外观→视频播放」检查 ffmpeg 路径")
    })?;
    if !out.status.success() {
        let full = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let err: String = if full.chars().count() > 200 {
            let n = full.chars().count() - 200;
            full.chars().skip(n).collect()
        } else {
            full
        };
        return Err(format!("该时刻解码失败: {err}"));
    }
    if out.stdout.is_empty() {
        return Err("该时刻解码失败（无输出帧，源文件可能损坏）".into());
    }
    let bytes = Arc::new(out.stdout);
    {
        let mut map = frame_cache().lock().unwrap();
        if map.len() > 64 {
            map.clear(); // 粗粒度回收：帧取字节 ~百 KB 级，整表重置内存可控
        }
        map.insert(ck, bytes.clone());
    }
    Ok(tauri::ipc::Response::new(bytes.as_ref().clone()))
}

/// 抽取音轨为 `<key>.audio.m4a`（渲染档对时通道）：aac、faststart、`.part` 暂存
/// + rename（与转码同纪律：存在=完整），产物入媒体缓存受 LRU。无音轨返回
/// Err("无音轨")——前端退化内部时钟（静音播放）。
#[tauri::command]
pub async fn ffmpeg_audio_track(app: AppHandle, path: String) -> Result<String, String> {
    let st = config::state(&app);
    let src = guarded_cache_path(&st, &path)?;
    let info = probe_video_info(&st, &src).await;
    if !info.audio {
        return Err("无音轨".into());
    }
    let key = format!("{:x}", crate::serverapi::simple_hash(&format!("ffmaudio|{src}")));
    let out = st.media_cache_dir().join(format!("{key}.audio.m4a"));
    if let Ok(m) = tokio::fs::metadata(&out).await {
        if m.len() > 0 {
            crate::cachemgr::touch(&out);
            return Ok(out.to_string_lossy().into_owned());
        }
        let _ = tokio::fs::remove_file(&out).await;
    }
    let flight = flight_for(&key);
    let _guard = flight.lock().await;
    if let Ok(m) = tokio::fs::metadata(&out).await {
        if m.len() > 0 {
            crate::cachemgr::touch(&out);
            return Ok(out.to_string_lossy().into_owned());
        }
    }
    let bin = ffmpeg_bin(&st);
    let part = st.media_cache_dir().join(format!("{key}.audio.m4a.part"));
    let _ = tokio::fs::remove_file(&part).await;
    let mut c = TokioCommand::new(&bin);
    c.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        &src,
        "-vn",
        "-map",
        "0:a:0",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
    ])
    .arg(&part)
    .kill_on_drop(true);
    no_window(&mut c);
    let status = c
        .output()
        .await
        .map_err(|e| format!("ffmpeg 启动失败（{bin}）：{e}——请检查 ffmpeg 路径"))?;
    if !status.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        let full = String::from_utf8_lossy(&status.stderr).trim().to_string();
        if full.contains("matches no streams") {
            return Err("无音轨".into());
        }
        let err: String = if full.chars().count() > 200 {
            let n = full.chars().count() - 200;
            full.chars().skip(n).collect()
        } else {
            full
        };
        return Err(format!("音轨提取失败: {err}"));
    }
    if tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("无音轨".into());
    }
    if tokio::fs::rename(&part, &out).await.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("音轨产物落盘失败".into());
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
