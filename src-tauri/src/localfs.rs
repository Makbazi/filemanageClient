//! 本地目录管理模式：客户端不依赖服务端即可独立部署。
//! 所有操作被限制在用户配置的本地目录内（req: 只允许管理配置的目录）。

use std::fs;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::config::{state, read_json, write_json, AppState};

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
    let root_c = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut clean = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                clean.pop();
            }
            Component::Normal(s) => clean.push(s),
            other => clean = other.as_os_str().into(),
        }
    }
    if !clean.starts_with(&root_c) && !clean.starts_with(root) {
        return Err("路径不允许越出所管理的目录".into());
    }
    Ok(p)
}

pub(crate) fn kind_of(name: &str, is_dir: bool) -> String {
    if is_dir {
        return "dir".into();
    }
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "heic" | "tiff" => "image",
        "mp4" | "mkv" | "avi" | "mov" | "webm" | "flv" | "wmv" => "video",
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

fn load_trash(st: &AppState) -> Vec<TrashItem> {
    read_json(&st.trash_index(), Vec::new())
}

fn save_trash(st: &AppState, items: &[TrashItem]) -> Result<(), String> {
    write_json(&st.trash_index(), items)
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

/// 按文件名递归搜索（限深限数）。
#[tauri::command]
pub async fn fs_search(app: AppHandle, root_id: String, query: String) -> Result<Vec<FsEntry>, String> {
    let st = state(&app);
    let root = st.root_path(&root_id)?;
    let mut out = Vec::new();
    let lq = query.to_lowercase();
    fn walk(
        root: &Path,
        dir: &Path,
        lq: &str,
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
            if name.to_lowercase().contains(lq) {
                if let Ok(md) = de.metadata() {
                    out.push(entry_from(root, &p, &md));
                }
            }
            if p.is_dir() {
                walk(root, &p, lq, depth + 1, out);
            }
        }
    }
    walk(&root, &root, &lq, 0, &mut out);
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

/// 把文件保存到本地磁盘任意位置（下载目标路径由前端给出，不受根目录限制——
/// 这是"导出到本机"，与管理范围无关）。
#[tauri::command]
pub async fn fs_write_bytes_b64(
    app: AppHandle,
    dest_path: String,
    data_b64: String,
) -> Result<(), String> {
    let _ = state(&app);
    let p = PathBuf::from(&dest_path);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let b = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    fs::write(&p, b).map_err(|e| e.to_string())
}

/// 读取本机任意文件为 base64（用于把本机文件上传到服务端）。
#[tauri::command]
pub async fn fs_read_bytes_b64(path: String) -> Result<String, String> {
    let b = fs::read(&path).map_err(|e| e.to_string())?;
    if b.len() > 100 << 20 {
        return Err("文件超过 100MB，暂不支持".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&b))
}
