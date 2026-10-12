//! 服务端令牌与"记住的登录密码"的系统凭证库存储：
//! Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service（keyring crate）。
//! 令牌：凭证库不可用时回退 config.json 明文并打日志提示；
//! 密码（需求3）：仅在凭证库可用时支持保存（键 {serverId}/{username}/password，
//! 按 服务端+账户 维度隔离），绝不落盘 config.json。

use keyring::Entry;

const SERVICE: &str = "filemanage-client";

fn entry(server_id: &str, kind: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("{server_id}/{kind}")).map_err(|e| e.to_string())
}

/// 启动时探测一次凭证库可用性（写入/读取/删除测试项）。
pub fn available() -> bool {
    let Ok(e) = entry("__probe__", "token") else {
        return false;
    };
    let ok = e.set_password("1").is_ok() && e.get_password().map(|v| v == "1").unwrap_or(false);
    let _ = e.delete_password();
    ok
}

/// 写入/清除一个服务端登录凭证（0.2.4 单凭证契约；None = 删除）。
/// 顺带清理 ≤0.3.5 时代残留的 refresh 条目（幂等、失败忽略）。
pub fn set_tokens(server_id: &str, token: Option<&str>) -> Result<(), String> {
    let _ = put(server_id, "refresh", None);
    put(server_id, "token", token)
}

fn put(server_id: &str, kind: &str, val: Option<&str>) -> Result<(), String> {
    let e = entry(server_id, kind)?;
    match val {
        Some(v) => e.set_password(v).map_err(|err| err.to_string()),
        None => {
            let _ = e.delete_password();
            Ok(())
        }
    }
}

pub fn get_tokens(server_id: &str) -> Option<String> {
    entry(server_id, "token")
        .ok()
        .and_then(|e| e.get_password().ok().filter(|s| !s.is_empty()))
}

/// 删除服务端配置时连带清理其凭证。
pub fn remove(server_id: &str) {
    let _ = set_tokens(server_id, None);
    let _ = put(server_id, "refresh", None);
}

// ---------- 记住的登录密码（需求3：键含 username，服务端+账户 维度隔离） ----------

fn entry2(server_id: &str, username: &str, kind: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("{server_id}/{username}/{kind}")).map_err(|e| e.to_string())
}

/// 写入/清除某服务端某账户的密码（None = 删除）。仅凭证库可用时调用。
pub fn set_password(server_id: &str, username: &str, pw: Option<&str>) -> Result<(), String> {
    let e = entry2(server_id, username, "password")?;
    match pw {
        Some(v) => e.set_password(v).map_err(|err| err.to_string()),
        None => {
            let _ = e.delete_password();
            Ok(())
        }
    }
}

/// 取回记住的密码（未记住/凭证库不可用时 None）。
pub fn get_password(server_id: &str, username: &str) -> Option<String> {
    entry2(server_id, username, "password")
        .ok()
        .and_then(|e| e.get_password().ok().filter(|s| !s.is_empty()))
}
