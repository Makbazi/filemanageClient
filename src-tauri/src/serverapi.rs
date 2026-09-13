//! 与 filemanageServer 交互：身份认证（JWT）+ 鉴权请求代理 + 流式上传/下载。
//! 前端通过泛化命令 srv_call 访问服务端 REST API，token 由 Rust 侧统一注入。

use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::config::{state, ServerConf};

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}

fn base_of(srv: &ServerConf) -> String {
    srv.base_url.trim_end_matches('/').to_string()
}

/// 登录并把 token 持久化到客户端配置。
#[tauri::command]
pub async fn srv_login(
    app: AppHandle,
    server_id: String,
    username: String,
    password: String,
) -> Result<Value, String> {
    let st = state(&app);
    let srv = st.server(&server_id)?;
    let resp = client()?
        .post(format!("{}/api/v1/auth/login", base_of(&srv)))
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| format!("无法连接服务端: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("响应解析失败: {e}"))?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("登录失败")
            .into());
    }
    let token = body
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or("服务端未返回 token")?
        .to_string();
    st.update(&app, |cfg| {
        if let Some(s) = cfg.servers.iter_mut().find(|s| s.id == server_id) {
            s.token = Some(token.clone());
            s.username = Some(username.clone());
        }
    })?;
    Ok(json!({ "ok": true, "user": body.get("user").cloned().unwrap_or(Value::Null) }))
}

#[tauri::command]
pub async fn srv_logout(app: AppHandle, server_id: String) -> Result<(), String> {
    let st = state(&app);
    st.update(&app, |cfg| {
        if let Some(s) = cfg.servers.iter_mut().find(|s| s.id == server_id) {
            s.token = None;
        }
    })?;
    Ok(())
}

/// 泛化 API 调用：method=GET|POST|PUT|DELETE，path 以 / 开头。
/// 401 会返回特定错误前缀，前端据此弹出重新登录。
#[tauri::command]
pub async fn srv_call(
    app: AppHandle,
    server_id: String,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let st = state(&app);
    let srv = st.server(&server_id)?;
    let url = format!("{}{}", base_of(&srv), path);
    let m = method.to_uppercase();
    let mut req = match m.as_str() {
        "GET" => client()?.get(&url),
        "POST" => client()?.post(&url),
        "PUT" => client()?.put(&url),
        "DELETE" => client()?.delete(&url),
        _ => return Err(format!("不支持的方法 {method}")),
    };
    if let Some(t) = &srv.token {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| format!("无法连接服务端: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| format!("HTTP {status}"));
        if status.as_u16() == 401 {
            return Err(format!("AUTH_REQUIRED: {msg}"));
        }
        return Err(msg);
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {e}"))
}

/// 下载服务端文件到本机路径（dest_path 为完整文件路径）。
#[tauri::command]
pub async fn srv_download(
    app: AppHandle,
    server_id: String,
    root_id: String,
    path: String,
    dest_path: String,
) -> Result<(), String> {
    let st = state(&app);
    let srv = st.server(&server_id)?;
    let url = format!("{}/api/v1/download", base_of(&srv));
    let mut req = client()?
        .get(&url)
        .query(&[("rootId", root_id.as_str()), ("path", path.as_str())]);
    if let Some(t) = &srv.token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| format!("无法连接服务端: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("下载失败 HTTP {}: {t}", status.as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::create_dir_all(
        std::path::Path::new(&dest_path)
            .parent()
            .ok_or("非法目标路径")?,
    )
    .await
    .map_err(|e| e.to_string())?;
    tokio::fs::write(&dest_path, &bytes).await.map_err(|e| e.to_string())
}

/// 上传本机文件到服务端 dir 目录（文件名取本机文件名）。
#[tauri::command]
pub async fn srv_upload(
    app: AppHandle,
    server_id: String,
    root_id: String,
    dir: String,
    local_path: String,
) -> Result<Value, String> {
    let st = state(&app);
    let srv = st.server(&server_id)?;
    let file_name = std::path::Path::new(&local_path)
        .file_name()
        .ok_or("非法本地路径")?
        .to_string_lossy()
        .into_owned();
    let rel = if dir.ends_with('/') {
        format!("{dir}{file_name}")
    } else {
        format!("{dir}/{file_name}")
    };
    let bytes = tokio::fs::read(&local_path).await.map_err(|e| e.to_string())?;
    let url = format!("{}/api/v1/upload", base_of(&srv));
    let mut req = client()?
        .post(&url)
        .query(&[("rootId", root_id.as_str()), ("path", rel.as_str())])
        .header("Content-Type", "application/octet-stream")
        .body(bytes);
    if let Some(t) = &srv.token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| format!("无法连接服务端: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("上传失败 HTTP {}: {text}", status.as_u16()));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
