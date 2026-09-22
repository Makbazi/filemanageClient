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
