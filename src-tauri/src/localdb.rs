//! 本地元数据库（0.3.0 起）：AI 描述 / 回收站 / 文件版本 / 分析任务 存于
//! app_data_dir/localdb.sqlite3（rusqlite bundled，WAL 模式），不再用 *.json 整读整写。
//! 迁移幂等（PRAGMA user_version）；首次启动自动导入旧 JSON 并把源文件改名 *.imported。

use std::path::Path;

use rusqlite::{params, Connection};

use crate::ai::DescRecord;
use crate::config::read_json;
use crate::localfs::{LocalVersion, TrashItem};

/// 旧版整 JSON 文件（一次性导入后即改名，不再读写）。
const LEGACY_FILES: [(&str, &str); 3] = [
    ("ai_descriptions.json", "imported_ai_json"),
    ("trash.json", "imported_trash_json"),
    ("versions.json", "imported_versions_json"),
];

/// 打开（或创建）本地元数据库，执行幂等迁移与一次性旧数据导入。
pub fn open_and_migrate(data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(data_dir.join("localdb.sqlite3")).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("启用 WAL 失败: {e}"))?;

    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS schema_meta(
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS ai_descriptions(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               root_id TEXT NOT NULL,
               path TEXT NOT NULL,
               name TEXT NOT NULL DEFAULT '',
               kind TEXT NOT NULL DEFAULT '',
               text TEXT NOT NULL DEFAULT '',
               model TEXT NOT NULL DEFAULT '',
               created_at INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL DEFAULT 0,
               embedding BLOB NOT NULL DEFAULT x'',
               UNIQUE(root_id, path)
             );
             CREATE TABLE IF NOT EXISTS trash_items(
               trash_id TEXT PRIMARY KEY,
               root_id TEXT NOT NULL,
               rel_path TEXT NOT NULL,
               name TEXT NOT NULL DEFAULT '',
               is_dir INTEGER NOT NULL DEFAULT 0,
               size INTEGER NOT NULL DEFAULT 0,
               deleted_at INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS file_versions(
               id TEXT PRIMARY KEY,
               root_id TEXT NOT NULL,
               path TEXT NOT NULL,
               version_no INTEGER NOT NULL DEFAULT 0,
               size INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS analysis_tasks(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               kind TEXT NOT NULL,
               root_id TEXT NOT NULL DEFAULT '',
               path TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'pending',
               detail TEXT NOT NULL DEFAULT '',
               created_at INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_ai_desc_updated ON ai_descriptions(updated_at);
             CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash_items(deleted_at);
             CREATE INDEX IF NOT EXISTS idx_versions_root_path ON file_versions(root_id, path);
             CREATE INDEX IF NOT EXISTS idx_analysis_status ON analysis_tasks(status);
             PRAGMA user_version = 1;
             COMMIT;",
        )
        .map_err(|e| format!("本地数据库迁移失败: {e}"))?;
    }
    // 0.3.2 上传账本（需求清单第 2 条）：目录上传"断点恢复 + 重启续传"的本地侧
    // 持久事实源。upload_groups 一条=一个目录上传组（gid=transfer.ts 组任务 id），
    // upload_items 一条=组内一个文件的传输规格与终态。
    if version < 2 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS upload_groups(
               gid TEXT PRIMARY KEY,
               label TEXT NOT NULL DEFAULT '',
               server_id TEXT NOT NULL DEFAULT '',
               root_id TEXT NOT NULL DEFAULT '',
               local_abs TEXT NOT NULL DEFAULT '',
               remote_prefix TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'active',
               total_files INTEGER NOT NULL DEFAULT 0,
               done_files INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS upload_items(
               gid TEXT NOT NULL,
               rel_path TEXT NOT NULL,
               name TEXT NOT NULL DEFAULT '',
               local_path TEXT NOT NULL DEFAULT '',
               remote_path TEXT NOT NULL DEFAULT '',
               size INTEGER NOT NULL DEFAULT 0,
               mtime_ms INTEGER NOT NULL DEFAULT 0,
               sha TEXT NOT NULL DEFAULT '',
               session_id TEXT NOT NULL DEFAULT '',
               state TEXT NOT NULL DEFAULT 'pending',
               PRIMARY KEY(gid, rel_path)
             );
             CREATE INDEX IF NOT EXISTS idx_upload_items_gid ON upload_items(gid);
             PRAGMA user_version = 2;
             COMMIT;",
        )
        .map_err(|e| format!("本地数据库迁移失败: {e}"))?;
    }

    // 一次性导入旧 JSON（尽力而为；失败则下次启动重试，导入用 INSERT OR REPLACE 幂等）
    import_legacy(&conn, data_dir);
    Ok(conn)
}

fn has_imported(conn: &Connection, marker: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM schema_meta WHERE key = ?1",
        params![marker],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn mark_imported(conn: &Connection, marker: &str, rows: usize) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?1, ?2)",
        params![marker, format!("v1:{rows}").as_str()],
    );
}

/// 扫描旧 JSON 文件并逐个导入；导入后把源文件改名为 `<name>.imported`（不删除）。
fn import_legacy(conn: &Connection, data_dir: &Path) {
    for (fname, marker) in LEGACY_FILES {
        if has_imported(conn, marker) {
            continue;
        }
        let src = data_dir.join(fname);
        let rows = if src.exists() {
            let n = match fname {
                "ai_descriptions.json" => import_descs(conn, &src),
                "trash.json" => import_trash(conn, &src),
                _ => import_versions(conn, &src),
            };
            match n {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("导入 {fname} 失败（下次启动重试）: {e}");
                    continue;
                }
            }
        } else {
            0
        };
        if src.exists() {
            let dst = data_dir.join(format!("{fname}.imported"));
            if let Err(e) = std::fs::rename(&src, &dst) {
                eprintln!("改名 {fname} -> {fname}.imported 失败: {e}");
            }
        }
        mark_imported(conn, marker, rows);
    }
}

fn import_descs(conn: &Connection, src: &Path) -> Result<usize, String> {
    let descs: Vec<DescRecord> = read_json(src, Vec::new());
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO ai_descriptions
                 (root_id, path, name, kind, text, model, created_at, updated_at, embedding)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|e| e.to_string())?;
        for d in &descs {
            stmt.execute(params![
                d.root_id, d.path, d.name, d.kind, d.text, d.model,
                d.created_at, d.updated_at, d.embedding,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(descs.len())
}

fn import_trash(conn: &Connection, src: &Path) -> Result<usize, String> {
    let items: Vec<TrashItem> = read_json(src, Vec::new());
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO trash_items
                 (trash_id, root_id, rel_path, name, is_dir, size, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;
        for i in &items {
            stmt.execute(params![
                i.trash_id, i.root_id, i.rel_path, i.name,
                i.is_dir as i64, i.size, i.deleted_at,
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(items.len())
}

fn import_versions(conn: &Connection, src: &Path) -> Result<usize, String> {
    let vers: Vec<LocalVersion> = read_json(src, Vec::new());
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO file_versions
                 (id, root_id, path, version_no, size, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| e.to_string())?;
        for v in &vers {
            stmt.execute(params![v.id, v.root_id, v.path, v.version_no, v.size, v.created_at])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(vers.len())
}

// ---------- 上传账本（0.3.2，需求清单第 2 条：目录上传兜底） ----------
//
// 事实源分工：服务端上传会话（staging 分片）负责"字节级续传"；本账本负责
// "任务级续传"——进程/整机重启后仍能知道：这个目录组要传哪些文件、各自
// 规格（size/mtime/sha）、服务端会话 id、终态。TransfersView 据此呈现
// "未完成的上传组 → 继续/放弃"，upload_inner 在关键节点回写条目状态。

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalGroup {
    pub gid: String,
    pub label: String,
    pub server_id: String,
    pub root_id: String,
    pub local_abs: String,
    pub remote_prefix: String,
    /// active | paused | done | canceled
    pub status: String,
    pub total_files: i64,
    pub done_files: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalItem {
    pub rel_path: String,
    pub name: String,
    pub local_path: String,
    pub remote_path: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub sha: String,
    pub session_id: String,
    /// pending | done | failed | canceled | skipped
    pub state: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalItemIn {
    pub rel_path: String,
    pub name: String,
    pub local_path: String,
    pub remote_path: String,
    pub size: i64,
    pub mtime_ms: i64,
    #[serde(default)]
    pub sha: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn journal_new_group(
    conn: &Connection,
    gid: &str,
    label: &str,
    server_id: &str,
    root_id: &str,
    local_abs: &str,
    remote_prefix: &str,
    total: i64,
) -> Result<(), String> {
    // 重复登记（同 gid 重跑/续跑）：规格字段刷新，done_files 保留、状态回 active
    conn.execute(
        "INSERT INTO upload_groups(gid,label,server_id,root_id,local_abs,remote_prefix,status,total_files,done_files,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,'active',?7,0,?8,?8)
         ON CONFLICT(gid) DO UPDATE SET
           label=excluded.label, server_id=excluded.server_id, root_id=excluded.root_id,
           local_abs=excluded.local_abs, remote_prefix=excluded.remote_prefix,
           status='active', total_files=excluded.total_files, updated_at=excluded.updated_at",
        params![gid, label, server_id, root_id, local_abs, remote_prefix, total, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn journal_set_children(conn: &Connection, gid: &str, items: &[JournalItemIn]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR IGNORE INTO upload_items(gid,rel_path,name,local_path,remote_path,size,mtime_ms,sha,session_id,state)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'','pending')",
            )
            .map_err(|e| e.to_string())?;
        for it in items {
            stmt.execute(params![
                gid, it.rel_path, it.name, it.local_path, it.remote_path,
                it.size, it.mtime_ms, it.sha.clone().unwrap_or_default(),
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn journal_set_session(conn: &Connection, gid: &str, rel: &str, session_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE upload_items SET session_id=?3 WHERE gid=?1 AND rel_path=?2",
        params![gid, rel, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 条目终态；state=done 时同步刷新组行 done_files（按 COUNT 重算，幂等）。
pub fn journal_item_state(conn: &Connection, gid: &str, rel: &str, state: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE upload_items SET state=?3 WHERE gid=?1 AND rel_path=?2",
        params![gid, rel, state],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE upload_groups SET done_files=(SELECT COUNT(*) FROM upload_items WHERE gid=?1 AND state='done'), updated_at=?2 WHERE gid=?1",
        params![gid, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn journal_group_status(conn: &Connection, gid: &str, status: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE upload_groups SET status=?2, updated_at=?3 WHERE gid=?1",
        params![gid, status, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn row_group(r: &rusqlite::Row) -> rusqlite::Result<JournalGroup> {
    Ok(JournalGroup {
        gid: r.get(0)?,
        label: r.get(1)?,
        server_id: r.get(2)?,
        root_id: r.get(3)?,
        local_abs: r.get(4)?,
        remote_prefix: r.get(5)?,
        status: r.get(6)?,
        total_files: r.get(7)?,
        done_files: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

const GROUP_COLS: &str = "gid,label,server_id,root_id,local_abs,remote_prefix,status,total_files,done_files,created_at,updated_at";

pub fn journal_list_pending(conn: &Connection) -> Result<Vec<JournalGroup>, String> {
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {GROUP_COLS} FROM upload_groups WHERE status IN ('active','paused') ORDER BY updated_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_group).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn journal_group_items(conn: &Connection, gid: &str) -> Result<Vec<JournalItem>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT rel_path,name,local_path,remote_path,size,mtime_ms,sha,session_id,state
             FROM upload_items WHERE gid=?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![gid], |r| {
            Ok(JournalItem {
                rel_path: r.get(0)?,
                name: r.get(1)?,
                local_path: r.get(2)?,
                remote_path: r.get(3)?,
                size: r.get(4)?,
                mtime_ms: r.get(5)?,
                sha: r.get(6)?,
                session_id: r.get(7)?,
                state: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 清理终态超期的账本条目（done/canceled 组及其实例）：账本只服务"续传"，
/// 完成即历史；保留 7 天便于回溯，防 sqlite 无限增长。启动时调用。
pub fn journal_prune(conn: &Connection) -> Result<usize, String> {
    let cutoff = now_ms() - 7 * 24 * 3600 * 1000;
    let n = conn
        .execute(
            "DELETE FROM upload_items WHERE gid IN (
               SELECT gid FROM upload_groups WHERE status IN ('done','canceled') AND updated_at < ?1
             )",
            params![cutoff],
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM upload_groups WHERE status IN ('done','canceled') AND updated_at < ?1",
        params![cutoff],
    )
    .map_err(|e| e.to_string())?;
    Ok(n)
}

// ---------- 账本 Tauri 命令（TS 侧接线用；内部写点由 serverapi 直接调函数） ----------

#[tauri::command]
fn with_db<T>(app: &tauri::AppHandle, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let st = crate::config::state(app);
    let db = st.db.lock().map_err(|_| "数据库忙".to_string())?;
    f(&db)
}

#[tauri::command]
pub fn lg_new_group(
    app: tauri::AppHandle,
    gid: String,
    label: String,
    server_id: String,
    root_id: String,
    local_abs: String,
    remote_prefix: String,
    total: i64,
) -> Result<(), String> {
    with_db(&app, |c| journal_new_group(c, &gid, &label, &server_id, &root_id, &local_abs, &remote_prefix, total))
}

#[tauri::command]
pub fn lg_set_children(app: tauri::AppHandle, gid: String, items: Vec<JournalItemIn>) -> Result<(), String> {
    with_db(&app, |c| journal_set_children(c, &gid, &items))
}

#[tauri::command]
pub fn lg_list_pending(app: tauri::AppHandle) -> Result<Vec<JournalGroup>, String> {
    with_db(&app, journal_list_pending)
}

#[tauri::command]
pub fn lg_group_items(app: tauri::AppHandle, gid: String) -> Result<Vec<JournalItem>, String> {
    with_db(&app, |c| journal_group_items(c, &gid))
}

#[tauri::command]
pub fn lg_group_status(app: tauri::AppHandle, gid: String, status: String) -> Result<(), String> {
    with_db(&app, |c| journal_group_status(c, &gid, &status))
}

// ---------- 整表读写（与旧版 JSON 整读整写语义 1:1） ----------

pub fn load_descs(conn: &Connection) -> Vec<DescRecord> {
    let mut out: Vec<DescRecord> = Vec::new();
    let _ = (|| -> Result<(), String> {
        let mut stmt = conn
            .prepare_cached(
                "SELECT root_id, path, name, kind, text, model, created_at, updated_at, embedding
                 FROM ai_descriptions ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(DescRecord {
                    root_id: r.get(0)?,
                    path: r.get(1)?,
                    name: r.get(2)?,
                    kind: r.get(3)?,
                    text: r.get(4)?,
                    model: r.get(5)?,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                    embedding: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            out.push(row);
        }
        Ok(())
    })();
    out
}

pub fn save_descs(conn: &Connection, rows: &[DescRecord]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("DELETE FROM ai_descriptions")
        .map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare_cached(
            "INSERT OR REPLACE INTO ai_descriptions
             (root_id, path, name, kind, text, model, created_at, updated_at, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .map_err(|e| e.to_string())?;
    for d in rows {
        stmt.execute(params![
            d.root_id, d.path, d.name, d.kind, d.text, d.model,
            d.created_at, d.updated_at, d.embedding,
        ])
        .map_err(|e| e.to_string())?;
    }
    drop(stmt);
    tx.commit().map_err(|e| e.to_string())
}

pub fn load_trash(conn: &Connection) -> Vec<TrashItem> {
    let mut out: Vec<TrashItem> = Vec::new();
    let _ = (|| -> Result<(), String> {
        let mut stmt = conn
            .prepare_cached(
                "SELECT trash_id, root_id, rel_path, name, is_dir, size, deleted_at
                 FROM trash_items ORDER BY deleted_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TrashItem {
                    trash_id: r.get(0)?,
                    root_id: r.get(1)?,
                    rel_path: r.get(2)?,
                    name: r.get(3)?,
                    is_dir: r.get::<_, i64>(4)? != 0,
                    size: r.get(5)?,
                    deleted_at: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            out.push(row);
        }
        Ok(())
    })();
    out
}

pub fn save_trash(conn: &Connection, rows: &[TrashItem]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("DELETE FROM trash_items")
        .map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare_cached(
            "INSERT OR REPLACE INTO trash_items
             (trash_id, root_id, rel_path, name, is_dir, size, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(|e| e.to_string())?;
    for i in rows {
        stmt.execute(params![
            i.trash_id, i.root_id, i.rel_path, i.name,
            i.is_dir as i64, i.size, i.deleted_at,
        ])
        .map_err(|e| e.to_string())?;
    }
    drop(stmt);
    tx.commit().map_err(|e| e.to_string())
}

pub fn load_versions(conn: &Connection) -> Vec<LocalVersion> {
    let mut out: Vec<LocalVersion> = Vec::new();
    let _ = (|| -> Result<(), String> {
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, root_id, path, version_no, size, created_at
                 FROM file_versions ORDER BY created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(LocalVersion {
                    id: r.get(0)?,
                    root_id: r.get(1)?,
                    path: r.get(2)?,
                    version_no: r.get(3)?,
                    size: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            out.push(row);
        }
        Ok(())
    })();
    out
}

pub fn save_versions(conn: &Connection, rows: &[LocalVersion]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("DELETE FROM file_versions")
        .map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare_cached(
            "INSERT OR REPLACE INTO file_versions
             (id, root_id, path, version_no, size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(|e| e.to_string())?;
    for v in rows {
        stmt.execute(params![v.id, v.root_id, v.path, v.version_no, v.size, v.created_at])
            .map_err(|e| e.to_string())?;
    }
    drop(stmt);
    tx.commit().map_err(|e| e.to_string())
}
