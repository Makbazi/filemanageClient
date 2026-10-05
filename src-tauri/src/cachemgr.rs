//! 媒体/缩略图磁盘缓存配额与淘汰（0.3.2 需求3/4/5）。
//!
//! 目录：`<cache_dir>/media`（asset 协议唯一授权目录；缩略图 `.thumb.jpg`、
//! RAW 内嵌预览 `.jpg`、查看/预览整文件条目、`.part`/`.raw-src` 中间态）。
//! 策略：
//!  - **上限**：config.cache.max_disk_mb（默认 10GB），原子字节计数 + 全量扫描校准；
//!  - **LRU**：命中即 touch mtime（本地模式 hard_link 条目 nlink>1 跳过——
//!    绝不动用户源文件的 mtime）；超限按 mtime 升序淘汰至 90%（留出突发余量）；
//!  - **碎片**：`*.part`/`*.raw-src` 是断点续传中间态，mtime 超 24h 视为孤儿回收；
//!  - **跨退出保留**：本模块从不"退出即清空"（用户决策），淘汰只按配额/新鲜度；
//!    设置页提供"清空缓存"手动入口（cache_clear）。
//! 内存层（≤2GB 缩略图 blob）在前端 lib/thumbcache.ts 执行，预算同读 cache.max_mem_mb。

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::AppHandle;

use crate::config::{state, AppState};

/// 媒体目录当前占用字节（近似计数：启动扫描初始化，写/删/淘汰增量维护）。
static MEDIA_BYTES: AtomicU64 = AtomicU64::new(0);

const STALE_SCRATCH_AGE_MS: u64 = 24 * 3600 * 1000; // .part/.raw-src 孤儿判定
const SWEEP_INTERVAL_SECS: u64 = 300; // 周期巡检

pub fn limit_bytes(st: &AppState) -> u64 {
    st.config().cache.max_disk_mb.saturating_mul(1 << 20)
}

/// 启动：全量扫描初始化计数（一次目录遍历，条目量级 ≤ 数万，成本可忽略）。
pub fn init_counter(st: &AppState) {
    let dir = st.media_cache_dir();
    let mut total = 0u64;
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    total += m.len();
                }
            }
        }
    }
    MEDIA_BYTES.store(total, Ordering::Relaxed);
}

/// 新写入缓存文件后调用（thumb/媒体条目落盘处）。
pub fn note_new_file(len: u64) {
    MEDIA_BYTES.fetch_add(len, Ordering::Relaxed);
}

/// 命中复用后调用：touch mtime 作为 LRU 访问标记。
/// **调用点纪律**：仅限本进程自有的拷贝（`.thumb.jpg`、RAW 提取 `.jpg`、
/// 服务端模式下载条目）——本地模式 hard_link 的整文件条目与用户源文件同
/// inode，绝不可 touch（会改用户文件的 mtime）；那些路径只在写入时获得
/// 新鲜 mtime，淘汰按创建序（可接受：unlink 只断链接不伤源文件）。
pub fn touch(path: &Path) {
    if let Ok(f) = OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
}

/// 超限检查：计数逼近上限时立即同步淘汰（写路径热调用，毫秒级）。
pub fn maybe_enforce(st: &AppState) {
    if MEDIA_BYTES.load(Ordering::Relaxed) >= limit_bytes(st) {
        enforce(st);
    }
}

/// 全量淘汰：先回收过期 scratch，再按 mtime 升序 unlink 至 ≤90% 上限。
pub fn enforce(st: &AppState) -> (usize, u64) {
    let dir = st.media_cache_dir();
    let limit = limit_bytes(st);
    let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let Ok(m) = e.metadata() else { continue };
            if !m.is_file() {
                continue;
            }
            files.push((m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len(), p));
        }
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    let mut removed = 0usize;
    let mut removed_bytes = 0u64;
    // 1) 过期断点碎片（.part/.raw-src mtime>24h = 无在途续传引用，孤儿）
    files.retain(|(mt, len, p)| {
        let age_ms = now_ms.saturating_sub(
            mt.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        );
        let scratch = matches!(p.file_name().and_then(|n| n.to_str()), Some(n) if
            n.ends_with(".part") || n.ends_with(".raw-src") || n.ends_with(".thumb.jpg.tmp"));
        if scratch && age_ms > STALE_SCRATCH_AGE_MS {
            if fs::remove_file(p).is_ok() {
                removed += 1;
                removed_bytes += *len;
                total = total.saturating_sub(*len);
                return false;
            }
        }
        true
    });
    // 2) 超限：按 mtime 升序（最久未访问先走）淘汰至 90%（硬链条目 unlink
    //    仅断开链接，用户源文件无恙）
    if total > limit {
        files.sort_by_key(|(mt, _, _)| *mt);
        let target = limit / 10 * 9;
        for (_, len, p) in files {
            if total <= target {
                break;
            }
            if fs::remove_file(&p).is_ok() {
                removed += 1;
                removed_bytes += len;
                total = total.saturating_sub(len);
            }
        }
    }
    if removed > 0 {
        MEDIA_BYTES.fetch_sub(removed_bytes, Ordering::Relaxed);
        // 计数漂移自愈：扫描实际值兜底
        MEDIA_BYTES.store(total, Ordering::Relaxed);
    } else {
        MEDIA_BYTES.store(total, Ordering::Relaxed); // 校准漂移
    }
    (removed, removed_bytes)
}

/// 周期巡检任务（lib.rs setup 挂 tauri::async_runtime）：
/// 每 SWEEP_INTERVAL_SECS 全量 enforce（回收过期 scratch + 配额淘汰）。
pub fn spawn_sweeper(app: &AppHandle) {
    let st = state(app);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SWEEP_INTERVAL_SECS)).await;
            let (n, _) = enforce(&st);
            if n > 0 {
                eprintln!("媒体缓存巡检：淘汰 {n} 个条目");
            }
        }
    });
}

/// 设置页用量（0.3.2 需求4：清理与更新机制的可见入口）。
#[tauri::command]
pub fn cache_stats(app: AppHandle) -> Result<serde_json::Value, String> {
    let st = state(&app);
    let (n, bytes) = media_dir_size(&st.media_cache_dir());
    Ok(json!({ "files": n, "bytes": bytes, "limitBytes": limit_bytes(&st) }))
}

fn media_dir_size(dir: &Path) -> (usize, u64) {
    let mut n = 0usize;
    let mut bytes = 0u64;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    n += 1;
                    bytes += m.len();
                }
            }
        }
    }
    (n, bytes)
}

/// 手动清空媒体缓存（在途下载/续传会被打断并按需重建——显式用户操作，可接受）。
#[tauri::command]
pub fn cache_clear(app: AppHandle) -> Result<u64, String> {
    let st = state(&app);
    let dir = st.media_cache_dir();
    let mut removed = 0u64;
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    if fs::remove_file(e.path()).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
    }
    MEDIA_BYTES.store(0, Ordering::Relaxed);
    Ok(removed)
}

/// 缩略图内存缓存的取字节通道（0.3.2）：前端对本模块写入的缓存文件读原始字节
/// 建 Blob（≤2GB 预算在 JS 侧 LRU），**不走** fetch(convertFileSrc)——CSP
/// connect-src 不含 asset 协议，且 Windows/Linux asset URL 形态不一。
/// 纵深防御同 player::open_media：canonicalize + 前缀必须命中媒体缓存目录
/// （命令不经 capabilities 门控的路径校验面）。
/// 返回 tauri::ipc::Response 原始字节（ArrayBuffer 直达前端，无 base64 膨胀）。
#[tauri::command]
pub fn media_read_bytes(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let st = state(&app);
    let dir = st.media_cache_dir();
    let abs = fs::canonicalize(&path).map_err(|e| format!("读取缓存失败: {e}"))?;
    let base = fs::canonicalize(&dir).map_err(|_| "缓存目录不存在".to_string())?;
    if !abs.starts_with(&base) {
        return Err("路径不在媒体缓存目录内".into());
    }
    let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("不是文件".into());
    }
    // 读即访问：仅缩略图条目刷新 LRU 标记（回退原路径可能来自本地 hard_link，
    // 不动 mtime——调用点纪律见 touch 注释）
    if abs.file_name().and_then(|n| n.to_str()).map(|n| n.ends_with(".thumb.jpg")).unwrap_or(false) {
        touch(&abs);
    }
    let bytes = fs::read(&abs).map_err(|e| format!("读取缓存失败: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}
