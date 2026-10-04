//! 本地目录管理模式：客户端不依赖服务端即可独立部署。
//! 所有操作被限制在用户配置的本地目录内（req: 只允许管理配置的目录）。

use std::fs;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config::{state, AppState};
use crate::localdb;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String, // 相对根目录，正斜杠
    pub is_dir: bool,
    pub size: i64,
    pub mtime: i64, // epoch 毫秒
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub trash_id: String,
    pub root_id: String,
    pub rel_path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: i64,
    pub deleted_at: i64,
}

/// 把相对路径安全地映射进根目录，拒绝 .. 逃逸与绝对路径。
pub(crate) fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut p = root.to_path_buf();
    let normalized = rel.replace('\\', "/");
    for seg in normalized.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err("路径不允许越出所管理的目录".into()),
            s => {
                if s.contains('\0') {
                    return Err("非法路径".into());
                }
                p.push(s);
            }
        }
    }
    // 双保险：确保结果仍在根目录内
    let root_c = canonical_base(root.canonicalize().unwrap_or_else(|_| root.to_path_buf()));
    let mut clean = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                clean.pop();
            }
            // Windows 盘符前缀（C:）与根分隔符（\）必须直接拼接：
            // 整体赋值会丢盘符，push 又会把 "\" 当绝对路径清空已有内容
            Component::Prefix(_) | Component::RootDir => {
                let mut raw = clean.as_os_str().to_os_string();
                raw.push(c.as_os_str());
                clean = PathBuf::from(raw);
            }
            other => clean.push(other.as_os_str()),
        }
    }
    if !clean.starts_with(&root_c) && !clean.starts_with(root) {
        return Err("路径不允许越出所管理的目录".into());
    }
    Ok(p)
}

/// Windows 上 canonicalize 返回 \\?\ 前缀的 verbatim 路径，与配置中的普通
/// 盘符路径做 starts_with 比对前须归一（非 Windows 为恒等变换）。
#[cfg(windows)]
fn canonical_base(p: PathBuf) -> PathBuf {
    let s = p.as_os_str().to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

#[cfg(not(windows))]
fn canonical_base(p: PathBuf) -> PathBuf {
    p
}

pub(crate) fn kind_of(name: &str, is_dir: bool) -> String {
    if is_dir {
        return "dir".into();
    }
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "heic" | "tiff" => "image",
        // 0.3.0 需求1：H.264/H.265 常见容器/裸流并入 video（不含 ts——撞 TypeScript；
        // 与前端 preview.ts VIDEO_EXT / player.rs VIDEO_EXT 同集合）
        "mp4" | "m4v" | "mkv" | "mov" | "webm" | "avi" | "flv" | "wmv" | "ogv" | "ogm" | "m2ts"
        | "mts" | "mpg" | "mpeg" | "mpe" | "3gp" | "vob" | "hevc" | "h265" | "h264" => "video",
        "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" | "opus" => "audio",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "rtf" | "epub" => "document",
        "zip" | "tar" | "gz" | "bz2" | "7z" | "rar" | "xz" => "archive",
        "go" | "py" | "js" | "ts" | "tsx" | "jsx" | "rs" | "java" | "c" | "cpp" | "h" | "css"
        | "html" | "json" | "yaml" | "yml" | "toml" | "sh" | "sql" => "code",
        _ => "other",
    }
    .into()
}

fn entry_from(root: &Path, abs: &Path, md: &fs::Metadata) -> FsEntry {
    let rel = abs
        .strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let name = abs.file_name().map(|n| n.to_string_lossy().into()).unwrap_or_default();
    FsEntry {
        name,
        path: rel,
        is_dir: md.is_dir(),
        size: if md.is_dir() { 0 } else { md.len() as i64 },
        mtime: md
            .modified()
            .ok()
            .map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0)
            })
            .unwrap_or(0),
        kind: kind_of(&abs.to_string_lossy(), md.is_dir()),
    }
}

// ---------- commands ----------

#[tauri::command]
pub async fn fs_list(app: AppHandle, root_id: String, path: String) -> Result<Vec<FsEntry>, String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let abs = resolve_in_root(&root, &path)?;
    let mut out: Vec<FsEntry> = Vec::new();
    let rd = fs::read_dir(&abs).map_err(|e| format!("无法读取目录 {path}: {e}"))?;
    for de in rd.flatten() {
        let md = match de.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(entry_from(&root, &de.path(), &md));
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// 需求41 目录上传：递归枚举本地目录树（一次性返回，带硬上限）。
/// relPath 相对被遍历目录、一律正斜杠拼接（Windows 安全）；符号链接（文件与目录）
/// 不跟随、不上传（防逃逸根/软链成环）；`.fmtrash`（服务端保留名）跳过；
/// 深度/条目数超限置 truncated=true——前端据此整体拒绝，绝不上传半棵树。
/// 中途读目录失败 = 整个遍历报错（确定性失败优于静默缺内容；非 UTF8 文件名走
/// to_string_lossy，与 fs_list 既有口径一致）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64, // 目录为 0
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkResult {
    pub entries: Vec<WalkEntry>, // 不含被遍历目录自身
    pub truncated: bool,
}

const WALK_MAX_ENTRIES: usize = 20_000;
const WALK_MAX_DEPTH: usize = 64;

#[tauri::command]
pub async fn fs_walk(app: AppHandle, root_id: String, path: String) -> Result<WalkResult, String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let abs = resolve_in_root(&root, &path)?;
    if !abs.is_dir() {
        return Err(format!("{path} 不是目录"));
    }
    let mut out: Vec<WalkEntry> = Vec::new();
    let mut truncated = false;
    // 显式栈迭代（不递归——深树无爆栈风险；rel 只由字符串段拼出，不经过 PathBuf 分隔符）
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(abs, String::new(), 0)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        if depth >= WALK_MAX_DEPTH {
            truncated = true;
            continue;
        }
        let rd = fs::read_dir(&dir).map_err(|e| format!("无法读取目录 {}: {e}", if prefix.is_empty() { path.as_str() } else { &prefix }))?;
        for de in rd.flatten() {
            if out.len() >= WALK_MAX_ENTRIES {
                truncated = true;
                continue;
            }
            let name = de.file_name().to_string_lossy().into_owned();
            if name == ".fmtrash" {
                continue;
            }
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let ft = match de.file_type() {
                Ok(f) => f,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                out.push(WalkEntry { name, rel_path: rel.clone(), is_dir: true, size: 0 });
                stack.push((de.path(), rel, depth + 1));
            } else {
                let size = de.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(WalkEntry { name, rel_path: rel, is_dir: false, size });
            }
        }
    }
    Ok(WalkResult { entries: out, truncated })
}

#[tauri::command]
pub async fn fs_mkdir(app: AppHandle, root_id: String, path: String) -> Result<(), String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let abs = resolve_in_root(&root, &path)?;
    fs::create_dir_all(abs).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_rename(
    app: AppHandle,
    root_id: String,
    path: String,
    new_name: String,
) -> Result<(), String> {
    if new_name.contains('/') || new_name.contains('\\') || new_name.is_empty() {
        return Err("名称不能包含路径分隔符".into());
    }
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let abs = resolve_in_root(&root, &path)?;
    let target = abs.with_file_name(new_name);
    fs::rename(&abs, &target).map_err(|e| e.to_string())
}

fn copy_path(src: &Path, dst: &Path) -> Result<(), String> {
    let md = fs::metadata(src).map_err(|e| e.to_string())?;
    if md.is_dir() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for de in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            copy_path(&de.path(), &dst.join(de.file_name()))?;
        }
    } else {
        fs::copy(src, dst).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn move_path(src: &Path, dst: &Path) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    copy_path(src, dst)?;
    if fs::metadata(src).map_err(|e| e.to_string())?.is_dir() {
        fs::remove_dir_all(src).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(src).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn is_same_or_child(src: &Path, dst: &Path) -> bool {
    dst == src || dst.starts_with(src)
}

#[tauri::command]
pub async fn fs_move(
    app: AppHandle,
    root_id: String,
    paths: Vec<String>,
    dest: String,
) -> Result<(), String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let dest_abs = resolve_in_root(&root, &dest)?;
    fs::create_dir_all(&dest_abs).map_err(|e| e.to_string())?;
    for p in paths {
        let src = resolve_in_root(&root, &p)?;
        let target = dest_abs.join(src.file_name().ok_or("非法源路径")?);
        if is_same_or_child(&src, &target) || src == target {
            return Err(format!("不能移动到自身内部: {p}"));
        }
        move_path(&src, &target)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_copy(
    app: AppHandle,
    root_id: String,
    paths: Vec<String>,
    dest: String,
) -> Result<(), String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let dest_abs = resolve_in_root(&root, &dest)?;
    for p in paths {
        let src = resolve_in_root(&root, &p)?;
        let target = dest_abs.join(src.file_name().ok_or("非法源路径")?);
        if is_same_or_child(&src, &target) {
            return Err(format!("不能复制到自身内部: {p}"));
        }
        copy_path(&src, &target)?;
    }
    Ok(())
}

// 回收站索引已存 localdb.sqlite3；load/save 维持"整读整写"语义（数据量小）。
fn load_trash(st: &AppState) -> Vec<TrashItem> {
    localdb::load_trash(&st.db.lock().expect("db lock"))
}

fn save_trash(st: &AppState, items: &[TrashItem]) -> Result<(), String> {
    localdb::save_trash(&st.db.lock().expect("db lock"), items)
}

/// 删除 = 移入回收站（真正删除由 restore/remove/clear 决定）。
#[tauri::command]
pub async fn fs_delete(
    app: AppHandle,
    root_id: String,
    paths: Vec<String>,
) -> Result<Vec<TrashItem>, String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let mut items = load_trash(&st);
    let mut removed = Vec::new();
    for p in paths {
        let abs = resolve_in_root(&root, &p)?;
        if abs == root {
            return Err("不能删除根目录本身".into());
        }
        let md = fs::metadata(&abs).map_err(|e| format!("{p}: {e}"))?;
        let trash_id = uuid::Uuid::new_v4().simple().to_string();
        let slot = st.trash_dir(&root_id).join(&trash_id);
        fs::create_dir_all(&slot).map_err(|e| e.to_string())?;
        let file_name = abs.file_name().map(|s| s.to_os_string()).ok_or("非法路径")?;
        move_path(&abs, &slot.join(&file_name))?;
        let item = TrashItem {
            trash_id,
            root_id: root_id.clone(),
            rel_path: p.trim_matches('/').to_string(),
            name: file_name.to_string_lossy().into_owned(),
            is_dir: md.is_dir(),
            size: if md.is_dir() { 0 } else { md.len() as i64 },
            deleted_at: Local::now().timestamp_millis(),
        };
        items.push(item.clone());
        removed.push(item);
    }
    save_trash(&st, &items)?;
    Ok(removed)
}

#[tauri::command]
pub async fn fs_trash_list(app: AppHandle, root_id: Option<String>) -> Result<Vec<TrashItem>, String> {
    let st = state(&app);
    let mut items = load_trash(&st);
    if let Some(rid) = root_id {
        items.retain(|i| i.root_id == rid);
    }
    items.sort_by_key(|a| -a.deleted_at);
    Ok(items)
}

fn dedup_path(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let stem: String = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = p.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    let parent = p.parent().unwrap_or(Path::new("."));
    for i in 1..1000 {
        let cand = parent.join(format!("{stem}({i}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    p.to_path_buf()
}

#[tauri::command]
pub async fn fs_trash_restore(app: AppHandle, trash_id: String) -> Result<String, String> {
    let st = state(&app);
    let mut items = load_trash(&st);
    let idx = items
        .iter()
        .position(|i| i.trash_id == trash_id)
        .ok_or("回收站条目不存在")?;
    let item = items[idx].clone();
    let root = st.root_path(&item.root_id)?;
    let target = resolve_in_root(&root, &item.rel_path)?;
    let slot = st.trash_dir(&item.root_id).join(&item.trash_id);
    let src = slot.join(&item.name);
    let target = dedup_path(&target);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    move_path(&src, &target)?;
    let _ = fs::remove_dir_all(&slot);
    items.remove(idx);
    save_trash(&st, &items)?;
    Ok(target
        .strip_prefix(&root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default())
}

#[tauri::command]
pub async fn fs_trash_remove(app: AppHandle, trash_id: String) -> Result<(), String> {
    let st = state(&app);
    let mut items = load_trash(&st);
    let idx = items
        .iter()
        .position(|i| i.trash_id == trash_id)
        .ok_or("回收站条目不存在")?;
    let item = items[idx].clone();
    let _ = fs::remove_dir_all(st.trash_dir(&item.root_id).join(&item.trash_id));
    items.remove(idx);
    save_trash(&st, &items)
}

#[tauri::command]
pub async fn fs_trash_clear(app: AppHandle, root_id: Option<String>) -> Result<usize, String> {
    let st = state(&app);
    let items = load_trash(&st);
    let mut kept = Vec::new();
    let mut n = 0;
    for i in items {
        let match_root = root_id.as_deref().map_or(true, |r| r == i.root_id);
        if match_root {
            let _ = fs::remove_dir_all(st.trash_dir(&i.root_id).join(&i.trash_id));
            n += 1;
        } else {
            kept.push(i);
        }
    }
    save_trash(&st, &kept)?;
    Ok(n)
}

/// 按条件递归搜索（需求12：名称/类型/大小/修改时间；限深限数）。
#[tauri::command]
pub async fn fs_search(
    app: AppHandle,
    root_id: String,
    query: String,
    kinds: Option<Vec<String>>,
    size_min: Option<i64>,
    size_max: Option<i64>,
    mtime_from: Option<i64>,
    mtime_to: Option<i64>,
) -> Result<Vec<FsEntry>, String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let mut out = Vec::new();
    let lq = query.to_lowercase();
    fn walk(
        root: &Path,
        dir: &Path,
        lq: &str,
        kinds: &Option<Vec<String>>,
        size_min: Option<i64>,
        size_max: Option<i64>,
        mtime_from: Option<i64>,
        mtime_to: Option<i64>,
        depth: usize,
        out: &mut Vec<FsEntry>,
    ) {
        if depth > 8 || out.len() >= 200 {
            return;
        }
        let rd = match fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        for de in rd.flatten() {
            if out.len() >= 200 {
                return;
            }
            let name = de.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let p = de.path();
            let is_dir = p.is_dir();
            if let Ok(md) = de.metadata() {
                let e = entry_from(root, &p, &md);
                let name_ok = lq.is_empty() || name.to_lowercase().contains(lq);
                let kind_ok = kinds.as_ref().map_or(true, |k| k.is_empty() || k.contains(&e.kind));
                let mtime = e.mtime;
                let size_ok = is_dir
                    || (size_min.map_or(true, |m| md.len() as i64 >= m)
                        && size_max.map_or(true, |m| md.len() as i64 <= m));
                let time_ok = is_dir
                    || (mtime_from.map_or(true, |m| mtime >= m)
                        && mtime_to.map_or(true, |m| mtime <= m));
                // 有大小/时间过滤条件时目录本身不作为结果
                let has_filters = size_min.is_some() || size_max.is_some()
                    || mtime_from.is_some() || mtime_to.is_some();
                if name_ok && kind_ok && size_ok && time_ok && !(is_dir && has_filters) {
                    out.push(e);
                }
            }
            if is_dir {
                walk(root, &p, lq, kinds, size_min, size_max, mtime_from, mtime_to, depth + 1, out);
            }
        }
    }
    walk(&root, &root, &lq, &kinds, size_min, size_max, mtime_from, mtime_to, 0, &mut out);
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// 小文件预览（图像等）：返回 data URL，供前端缩略图/预览。
#[tauri::command]
pub async fn fs_preview(app: AppHandle, root_id: String, path: String) -> Result<String, String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let abs = resolve_in_root(&root, &path)?;
    let md = fs::metadata(&abs).map_err(|e| e.to_string())?;
    if md.is_dir() || md.len() > 8 << 20 {
        return Err("文件过大或为目录，无法预览".into());
    }
    let b = fs::read(&abs).map_err(|e| e.to_string())?;
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "txt" | "md" | "log" => "text/plain",
        _ => "application/octet-stream",
    };
    if mime == "text/plain" {
        let text = String::from_utf8_lossy(&b);
        return Ok(format!("data:text/plain;base64,{}", base64::engine::general_purpose::STANDARD.encode(text.as_bytes())));
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&b)
    ))
}

/// 本地回收站过期自动清理（0.4.0；启动时执行，需求：默认保留 30 天，独立于服务端策略）。
/// 过期条目连同暂存实体一并彻底删除；保留天数取 AppConfig.trashRetentionDays（<=0 视为 30）。
pub fn purge_expired_trash(st: &AppState) {
    let days = st.config().trash_retention_days.max(1);
    let cutoff = Local::now().timestamp_millis() - days * 86_400_000;
    let items = load_trash(st);
    if items.is_empty() || items.iter().all(|i| i.deleted_at >= cutoff) {
        return;
    }
    let (expired, kept): (Vec<TrashItem>, Vec<TrashItem>) =
        items.into_iter().partition(|i| i.deleted_at < cutoff);
    for i in &expired {
        let _ = fs::remove_dir_all(st.trash_dir(&i.root_id).join(&i.trash_id));
    }
    if let Err(e) = save_trash(st, &kept) {
        eprintln!("清理过期回收站失败: {e}");
        return;
    }
    eprintln!("本地回收站: 已自动清理过期条目 {} 个（保留 {days} 天）", expired.len());
}

// ---------- 本地导入（流式复制，无大小限制，覆盖前自动存版本） ----------

/// 把本机文件导入当前本地目录（dest_rel 为相对根目录的目标完整路径）。
#[tauri::command]
pub async fn fs_import(
    app: AppHandle,
    root_id: String,
    dest_rel: String,
    local_path: String,
) -> Result<FsEntry, String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let dest = resolve_in_root(&root, &dest_rel)?;
    if fs::metadata(&local_path).map_err(|e| e.to_string())?.is_dir() {
        return Err("目录导入暂不支持".into());
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // 覆盖已有文件前保存版本（需求13）
    snapshot_version(&st, &root_id, dest_rel.trim_matches('/'), &dest)?;
    let tmp = dest.with_extension(format!(
        "{}.tmp",
        dest.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    fs::copy(&local_path, &tmp).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    let md = fs::metadata(&dest).map_err(|e| e.to_string())?;
    Ok(entry_from(&root, &dest, &md))
}

/// 把根目录内文件导出（下载）到本机任意路径（tmp+rename 原子写）。
#[tauri::command]
pub async fn fs_export(
    app: AppHandle,
    root_id: String,
    path: String,
    dest_path: String,
) -> Result<(), String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let abs = resolve_in_root(&root, &path)?;
    if !abs.is_file() {
        return Err("不是文件".into());
    }
    let dest = PathBuf::from(&dest_path);
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let name = dest
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or("非法目标路径")?;
    let tmp = dest.with_file_name(format!(".{name}.fmdownload"));
    fs::copy(&abs, &tmp).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())
}

// ---------- 本地文件版本（需求13：保留最近 10 版，可回滚） ----------

const MAX_LOCAL_VERSIONS: usize = 10;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVersion {
    pub id: String,
    pub root_id: String,
    pub path: String,
    pub version_no: i64,
    pub size: i64,
    pub created_at: i64,
}

// 版本索引已存 localdb.sqlite3（版本内容文件仍在 versions_dir）。
fn load_versions(st: &AppState) -> Vec<LocalVersion> {
    localdb::load_versions(&st.db.lock().expect("db lock"))
}

fn save_versions(st: &AppState, v: &[LocalVersion]) -> Result<(), String> {
    localdb::save_versions(&st.db.lock().expect("db lock"), v)
}

/// 把 abs 当前内容快照为 (root_id, rel) 的一个新版本；文件不存在则跳过。
pub(crate) fn snapshot_version(st: &AppState, root_id: &str, rel: &str, abs: &Path) -> Result<(), String> {
    let md = match fs::metadata(abs) {
        Ok(m) if !m.is_dir() => m,
        _ => return Ok(()),
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = st.versions_dir().join(root_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::copy(abs, dir.join(&id)).map_err(|e| e.to_string())?;
    let mut vers = load_versions(st);
    let no = vers
        .iter()
        .filter(|v| v.root_id == root_id && v.path == rel)
        .map(|v| v.version_no)
        .max()
        .unwrap_or(0)
        + 1;
    vers.push(LocalVersion {
        id,
        root_id: root_id.to_string(),
        path: rel.to_string(),
        version_no: no,
        size: md.len() as i64,
        created_at: Local::now().timestamp_millis(),
    });
    // 修剪：同路径只保留最近 MAX_LOCAL_VERSIONS 版
    vers.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let mut kept: Vec<LocalVersion> = Vec::with_capacity(vers.len());
    let mut group: Vec<LocalVersion> = Vec::new();
    let flush = |group: &mut Vec<LocalVersion>, kept: &mut Vec<LocalVersion>| {
        if group.len() > MAX_LOCAL_VERSIONS {
            let drop_n = group.len() - MAX_LOCAL_VERSIONS;
            for old in group.drain(..drop_n) {
                let _ = fs::remove_file(st.versions_dir().join(&old.root_id).join(&old.id));
            }
        }
        kept.append(group);
    };
    for v in vers {
        if group.first().map_or(false, |g| g.root_id != v.root_id || g.path != v.path) {
            flush(&mut group, &mut kept);
        }
        group.push(v);
    }
    flush(&mut group, &mut kept);
    kept.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    save_versions(st, &kept)
}

#[tauri::command]
pub async fn fs_versions_list(app: AppHandle, root_id: String, path: String) -> Result<Vec<LocalVersion>, String> {
    let st = state(&app);
    let rel = path.trim_matches('/');
    let mut out: Vec<LocalVersion> = load_versions(&st)
        .into_iter()
        .filter(|v| v.root_id == root_id && v.path == rel)
        .collect();
    out.sort_by(|a, b| b.version_no.cmp(&a.version_no));
    Ok(out)
}

/// 回滚到指定版本：当前内容先存为新版本，再用版本内容覆盖（原子替换）。
#[tauri::command]
pub async fn fs_versions_rollback(
    app: AppHandle,
    root_id: String,
    path: String,
    version_id: String,
) -> Result<(), String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let rel = path.trim_matches('/');
    let ver = load_versions(&st)
        .into_iter()
        .find(|v| v.id == version_id && v.root_id == root_id && v.path == rel)
        .ok_or("版本不存在")?;
    let content = st.versions_dir().join(&root_id).join(&ver.id);
    if !content.exists() {
        return Err("版本内容文件缺失".into());
    }
    let abs = resolve_in_root(&root, rel)?;
    snapshot_version(&st, &root_id, rel, &abs)?;
    if let Some(dir) = abs.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = abs.with_extension("fmrollback.tmp");
    fs::copy(&content, &tmp).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &abs).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_versions_remove(app: AppHandle, version_id: String) -> Result<(), String> {
    let st = state(&app);
    let mut vers = load_versions(&st);
    let idx = vers.iter().position(|v| v.id == version_id).ok_or("版本不存在")?;
    let ver = vers.remove(idx);
    let _ = fs::remove_file(st.versions_dir().join(&ver.root_id).join(&ver.id));
    save_versions(&st, &vers)
}

// ---------- 媒体预览缓存（需求11：视频/音频经 asset 协议播放） ----------

fn cache_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// 媒体缓存键（0.1.7 起含 ver 版本串）；fs_media_cache 与 fs_thumb 共用，
/// 保证缩略图条目 `<key_hash>.thumb.jpg` 与媒体条目 `<key_hash>.<ext>` 同源。
fn cache_key(root_id: &str, path: &str, ver: Option<&str>) -> String {
    match ver {
        Some(v) => format!("{root_id}/{path}@{v}"),
        None => format!("{root_id}/{path}"),
    }
}

fn ext_of(path: &str) -> String {
    path.rsplit('.').next().unwrap_or("").to_lowercase()
}

/// 把本地根内文件确保纳入媒体缓存目录，返回缓存绝对路径。
/// asset 协议仅授权缓存目录，避免放开任意路径。
/// 0.1.7：可选 ver 并入缓存键——覆盖写后旧键自然失效重拉（data URL 时代无此问题）。
/// 0.2.1：相机 RAW（NEF/CR2/…）浏览器无法解码——缓存的不再是原始字节，而是
/// 从文件内提取的**最大内嵌 JPEG 预览**（存为 .jpg）；无完整内嵌 JPEG 则报错，
/// 前端回退图标。双击查看/眼睛预览/网格缩略图因此全链路支持 RAW，服务端零改动。
pub(crate) fn media_cache_path(
    st: &AppState,
    root_id: &str,
    path: &str,
    ver: Option<&str>,
) -> Result<PathBuf, String> {
    let root = st.root_path(root_id)?;
    let abs = resolve_in_root(&root, path)?;
    if !abs.is_file() {
        return Err("不是文件".into());
    }
    let ext = ext_of(path);
    let raw = crate::thumb::is_raw_ext(&ext);
    let key = cache_key(root_id, path, ver);
    let name = format!("{:x}.{}", cache_hash(&key), if raw { "jpg" } else { ext.as_str() });
    let dest = st.media_cache_dir().join(&name);
    if dest.exists() {
        return Ok(dest);
    }
    if raw {
        let md = fs::metadata(&abs).map_err(|e| e.to_string())?;
        if md.len() > 512 << 20 {
            return Err("RAW 文件过大（>512MiB），不提取内嵌预览".into());
        }
        let data = fs::read(&abs).map_err(|e| e.to_string())?;
        let jpeg = crate::thumb::extract_preview(&data)
            .ok_or("该 RAW 未找到完整内嵌 JPEG 预览，请下载后用 RAW 软件查看")?;
        fs::write(&dest, &jpeg).map_err(|e| e.to_string())?;
        return Ok(dest);
    }
    let linked = fs::hard_link(&abs, &dest);
    if linked.is_err() {
        fs::copy(&abs, &dest).map_err(|e| e.to_string())?;
    }
    Ok(dest)
}

#[tauri::command]
pub async fn fs_media_cache(
    app: AppHandle,
    root_id: String,
    path: String,
    ver: Option<String>,
) -> Result<String, String> {
    let st = state(&app);
    let p = media_cache_path(&st, &root_id, &path, ver.as_deref())?;
    Ok(p.to_string_lossy().into_owned())
}

/// 网格视图缩略图（0.2.1）：确保媒体缓存条目后，在缓存目录生成/复用
/// ≤512px JPEG（`<key_hash>.thumb.jpg`），返回绝对路径供 convertFileSrc。
/// 无法缩放解码（svg/ico/heic 等）时：原文件 ≤8MiB 直接回传缓存原路径交给
/// 浏览器渲染，否则报错由前端回退类型图标。
#[tauri::command]
pub async fn fs_thumb(
    app: AppHandle,
    root_id: String,
    path: String,
    ver: Option<String>,
) -> Result<String, String> {
    let st = state(&app);
    let src = media_cache_path(&st, &root_id, &path, ver.as_deref())?;
    let key = cache_key(&root_id, &path, ver.as_deref());
    match crate::thumb::ensure_thumb(&st, &key, &src) {
        Ok(t) => Ok(t.to_string_lossy().into_owned()),
        Err(e) => {
            if fs::metadata(&src).map(|m| m.len() <= 8 << 20).unwrap_or(false) {
                Ok(src.to_string_lossy().into_owned())
            } else {
                Err(e)
            }
        }
    }
}
