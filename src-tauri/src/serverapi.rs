//! 与 filemanageServer 交互：
//! - 认证：短期 access token + refresh token 自动续期（需求22：3 周滑动会话）
//! - 泛化 API 代理 srv_call（401 → 自动 refresh → 重试 → 仍失败才报 AUTH_REQUIRED）
//! - 分片上传/断点续传/进度事件/取消/限速（需求3、18）
//! - 流式下载 + .part 断点续传（Range）+ 进度事件
//! - TLS：https 直连；服务端为自签证书时可按配置跳过校验（insecureTls）
//! - 媒体缓存：把服务端文件拉到本地缓存目录，供 asset 协议播放（预览，需求11）

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::config::{state, ServerConf};

/// 进度事件负载（前端 TransferPanel 订阅 "fm-transfer"）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub transfer_id: String,
    pub name: String,
    /// upload | download
    pub direction: String,
    pub sent: u64,
    pub total: u64,
    /// B/s，0 表示未知
    pub speed: u64,
    /// done | error | cancelled 时携带
    pub status: String,
    pub message: String,
}

/// 传输停止信号：0=无，1=取消，2=暂停（0.6.0 需求4/5：暂停保留进度可续传）。
pub const SIG_NONE: u8 = 0;
pub const SIG_CANCEL: u8 = 1;
pub const SIG_PAUSE: u8 = 2;

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicU8>>> {
    static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicU8>>>> = OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_cancel(id: &str) -> Arc<AtomicU8> {
    let flag = Arc::new(AtomicU8::new(SIG_NONE));
    cancels().lock().unwrap().insert(id.to_string(), flag.clone());
    flag
}

fn unregister_cancel(id: &str) {
    cancels().lock().unwrap().remove(id);
}

/// 停止一个进行中的传输：pause=false 取消（丢弃本次调用，.part/会话仍保留可重跑），
/// pause=true 暂停（0.6.0 需求4/5）。
#[tauri::command]
pub fn transfer_cancel(transfer_id: String, pause: Option<bool>) -> Result<(), String> {
    if let Some(f) = cancels().lock().unwrap().get(&transfer_id) {
        f.store(if pause.unwrap_or(false) { SIG_PAUSE } else { SIG_CANCEL }, Ordering::SeqCst);
    }
    Ok(())
}

fn emit(app: &AppHandle, ev: TransferEvent) {
    let _ = app.emit("fm-transfer", ev);
}

/// 叠加 TLS 选项（0.4.0 安全升级）：
///  - caFile：仅信任指定 CA（推荐的自签场景做法，等效证书固定）；
///  - insecureTls：全盘跳过校验（兼容旧配置，前端已提示风险）。
fn apply_tls(srv: &ServerConf, b: reqwest::ClientBuilder) -> Result<reqwest::ClientBuilder, String> {
    let mut b = b;
    if let Some(ca) = srv.ca_file.as_deref().filter(|s| !s.is_empty()) {
        let pem = std::fs::read(ca).map_err(|e| format!("读取 CA 证书失败 {ca}: {e}"))?;
        let cert = reqwest::Certificate::from_pem(&pem).map_err(|e| format!("CA 证书 PEM 解析失败: {e}"))?;
        b = b.add_root_certificate(cert);
    }
    if srv.insecure_tls && srv.base_url.starts_with("https") {
        b = b.danger_accept_invalid_certs(true);
    }
    Ok(b)
}

/// 按服务端配置构造 HTTP 客户端（JSON 短请求，带总超时）。
fn client_for(srv: &ServerConf) -> Result<reqwest::Client, String> {
    let b = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120));
    apply_tls(srv, b)?.build().map_err(|e| e.to_string())
}

/// 大流量传输客户端：不设总超时（大文件下载/上传耗时不可预估）。
fn stream_client_for(srv: &ServerConf) -> Result<reqwest::Client, String> {
    let b = reqwest::Client::builder().connect_timeout(Duration::from_secs(15));
    apply_tls(srv, b)?.build().map_err(|e| e.to_string())
}

fn base_of(srv: &ServerConf) -> String {
    srv.base_url.trim_end_matches('/').to_string()
}

/// 限速节拍：传输 bytes 字节后按 limit_kbps 补齐等待时间（0 = 不限速）。
async fn pace(limit_kbps: u32, bytes: u64, elapsed: Duration) {
    if limit_kbps == 0 || bytes == 0 {
        return;
    }
    let target = Duration::from_secs_f64(bytes as f64 / (limit_kbps as f64 * 1024.0));
    if target > elapsed {
        tokio::time::sleep(target - elapsed).await;
    }
}

// ---------- 认证 ----------

/// 登录：保存 access token 与 refresh token（旧版服务端无 refreshToken 也兼容）。
/// remember=Some(true)：登录成功后把密码记入系统凭证库（0.6.0 需求3，按 服务端+账户 隔离）；
/// Some(false)：清除该账户已记住的密码；None：保持现状。凭证库不可用时静默跳过。
#[tauri::command]
pub async fn srv_login(
    app: AppHandle,
    server_id: String,
    username: String,
    password: String,
    remember: Option<bool>,
) -> Result<Value, String> {
    let st = state(&app);
    let srv = st.server(&server_id)?;
    let resp = client_for(&srv)?
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
    let refresh = body
        .get("refreshToken")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    // 记住密码（仅凭证库可用时；密码不进 config.json）
    if let Some(do_remember) = remember {
        if st.keyring_ok {
            if do_remember {
                crate::secret::set_password(&server_id, &username, Some(&password))?;
            } else {
                let _ = crate::secret::set_password(&server_id, &username, None);
            }
        }
    }
    let cred = crate::config::CredRef { server_id: server_id.clone(), username: username.clone() };
    let snapshot = st.update(&app, |cfg| {
        if let Some(s) = cfg.servers.iter_mut().find(|s| s.id == server_id) {
            s.token = Some(token.clone());
            s.refresh_token = refresh.clone();
            s.username = Some(username.clone());
        }
        match remember {
            Some(true) => {
                if !cfg.credentials.contains(&cred) {
                    cfg.credentials.push(cred.clone());
                }
            }
            Some(false) => cfg.credentials.retain(|c| c != &cred),
            None => {}
        }
    })?;
    let _ = snapshot;
    // Rust 侧令牌/凭证变化广播 → 前端同步登录态（需求8 左右面板一致性）
    let _ = app.emit("fm-config-changed", ());
    Ok(json!({ "ok": true, "user": body.get("user").cloned().unwrap_or(Value::Null),
        "passwordSaved": remember == Some(true) && st.keyring_ok }))
}

/// 自助改密（批次需求31）：POST /api/v1/auth/change-password。
/// 服务端校验旧密码并作废全部会话，故成功后本地必须：
///   a) 若该账户启用了"记住密码"，把凭证库里的旧密码更新为新密码；
///   b) 清空 token/refresh（下次操作走登录对话框）。
/// 不经 srv_call（401 自动续期会重试一次，语义错误；旧密码错就是 401）。
#[tauri::command]
pub async fn srv_change_password(
    app: AppHandle,
    old_password: String,
    new_password: String,
) -> Result<Value, String> {
    let server_id = {
        let cfg = state(&app).config();
        cfg.active
            .as_ref()
            .and_then(|a| if a.kind == "server" { a.server_id.clone() } else { None })
            .ok_or_else(|| "未选择服务端".to_string())?
    };
    let (username, token) = {
        let st = state(&app);
        let srv = st.server(&server_id)?;
        (
            srv.username.clone().ok_or("当前会话缺少用户名")?,
            srv.token.clone().ok_or("AUTH_REQUIRED: 需要重新登录")?,
        )
    };
    let srv = state(&app).server(&server_id)?;
    let resp = client_for(&srv)?
        .post(format!("{}/api/v1/auth/change-password", base_of(&srv)))
        .bearer_auth(&token)
        .json(&json!({ "oldPassword": old_password, "newPassword": new_password }))
        .send()
        .await
        .map_err(|e| format!("无法连接服务端: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("响应解析失败: {e}"))?;
    if !status.is_success() {
        return Err(body
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("修改密码失败")
            .into());
    }
    // a) 更新已记住的口令（仅当该 服务端+账户 在凭证记住清单内且凭证库可用）
    let mut password_saved = false;
    {
        let st = state(&app);
        let remembered = st.keyring_ok
            && st.config().credentials.iter().any(|c| {
                c.server_id == server_id && c.username == username
            });
        if remembered {
            crate::secret::set_password(&server_id, &username, Some(&new_password))?;
            password_saved = true;
        }
        // b) 全部会话已在服务端作废：清本地 token，强制重新登录
        st.update(&app, |cfg| {
            if let Some(s) = cfg.servers.iter_mut().find(|s| s.id == server_id) {
                s.token = None;
                s.refresh_token = None;
            }
        })?;
    }
    let _ = app.emit("fm-config-changed", ());
    let _ = body;
    Ok(json!({ "ok": true, "reauthRequired": true, "passwordSaved": password_saved }))
}

/// 用 refresh token 换新的 access/refresh（轮换）。成功返回新 access token。
async fn try_refresh(app: &AppHandle, server_id: &str) -> Result<String, String> {
    let st = state(app);
    let srv = st.server(server_id)?;
    let rt = srv
        .refresh_token
        .clone()
        .ok_or_else(|| "AUTH_REQUIRED: 需要重新登录".to_string())?;
    let resp = client_for(&srv)?
        .post(format!("{}/api/v1/auth/refresh", base_of(&srv)))
        .json(&json!({ "refreshToken": rt }))
        .send()
        .await
        .map_err(|e| format!("无法连接服务端: {e}"))?;
    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // 会话过期（超过 3 周未使用）→ 需要重新登录
        return Err("AUTH_REQUIRED: 会话已过期，请重新登录".into());
    }
    let token = body
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or("服务端未返回 token")?
        .to_string();
    let new_rt = body
        .get("refreshToken")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());
    let sid = server_id.to_string();
    st.update(app, |cfg| {
        if let Some(s) = cfg.servers.iter_mut().find(|s| s.id == sid) {
            s.token = Some(token.clone());
            if let Some(r) = new_rt {
                s.refresh_token = Some(r);
            }
        }
    })?;
    // 续期轮换后前端 access token 字符串已旧：广播同步（需求8）
    let _ = app.emit("fm-config-changed", ());
    Ok(token)
}

#[tauri::command]
pub async fn srv_logout(app: AppHandle, server_id: String) -> Result<(), String> {
    let st = state(&app);
    // 尽力通知服务端注销会话（失败不阻塞本地登出）
    if let Ok(srv) = st.server(&server_id) {
        if let Some(rt) = srv.refresh_token.clone() {
            if let Ok(c) = client_for(&srv) {
                let _ = c
                    .post(format!("{}/api/v1/auth/logout", base_of(&srv)))
                    .json(&json!({ "refreshToken": rt }))
                    .send()
                    .await;
            }
        }
    }
    st.update(&app, |cfg| {
        if let Some(s) = cfg.servers.iter_mut().find(|s| s.id == server_id) {
            s.token = None;
            s.refresh_token = None;
        }
    })?;
    // 登出立即广播：左侧徽章与右侧数据面板同步（需求8）
    let _ = app.emit("fm-config-changed", ());
    Ok(())
}

// ---------- 记住的账户密码管理（0.6.0 需求3） ----------

/// 取回某服务端某账户已记住的密码（快速登录用；未记住返回 null）。
#[tauri::command]
pub fn cred_take(app: AppHandle, server_id: String, username: String) -> Result<Option<String>, String> {
    let st = state(&app);
    if !st.keyring_ok || !st.config().credentials.iter().any(|c| c.server_id == server_id && c.username == username) {
        return Ok(None);
    }
    Ok(crate::secret::get_password(&server_id, &username))
}

/// 删除某服务端某账户的已记住密码（索引+凭证库；update() 统一清理）。
#[tauri::command]
pub fn cred_forget(app: AppHandle, server_id: String, username: String) -> Result<(), String> {
    let st = state(&app);
    let cred = crate::config::CredRef { server_id: server_id.clone(), username: username.clone() };
    st.update(&app, |cfg| cfg.credentials.retain(|c| c != &cred))?;
    let _ = app.emit("fm-config-changed", ());
    Ok(())
}

// ---------- 泛化 API 调用 ----------

fn api_error(status: reqwest::StatusCode, text: &str) -> String {
    let msg = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or_else(|| format!("HTTP {status}"));
    if status.as_u16() == 401 {
        format!("AUTH_REQUIRED: {msg}")
    } else {
        msg
    }
}

/// 泛化 API 调用：method=GET|POST|PUT|DELETE，path 以 / 开头。
/// 401 时自动用 refresh token 续期并重试一次；仍失败返回 AUTH_REQUIRED 前缀错误。
#[tauri::command]
pub async fn srv_call(
    app: AppHandle,
    server_id: String,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    for attempt in 0..2 {
        let st = state(&app);
        let srv = st.server(&server_id)?;
        let url = format!("{}{}", base_of(&srv), path);
        let m = method.to_uppercase();
        let mut req = match m.as_str() {
            "GET" => client_for(&srv)?.get(&url),
            "POST" => client_for(&srv)?.post(&url),
            "PUT" => client_for(&srv)?.put(&url),
            "DELETE" => client_for(&srv)?.delete(&url),
            _ => return Err(format!("不支持的方法 {method}")),
        };
        if let Some(t) = &srv.token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = &body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| format!("无法连接服务端: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if status.as_u16() == 401 && attempt == 0 {
            // 尝试刷新会话后重试（需求22）
            if try_refresh(&app, &server_id).await.is_ok() {
                continue;
            }
        }
        if !status.is_success() {
            return Err(api_error(status, &text));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        return serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {e}"));
    }
    Err("AUTH_REQUIRED: 需要重新登录".into())
}

/// 带认证的二进制 GET（下载/预览/媒体缓存共用），支持 Range 头。
async fn authed_get(
    app: &AppHandle,
    server_id: &str,
    url: &str,
    query: &[(&str, &str)],
    range_from: Option<u64>,
) -> Result<reqwest::Response, String> {
    for attempt in 0..2 {
        let st = state(app);
        let srv = st.server(server_id)?;
        let mut req = stream_client_for(&srv)?.get(url).query(query);
        if let Some(t) = &srv.token {
            req = req.bearer_auth(t);
        }
        if let Some(from) = range_from {
            req = req.header("Range", format!("bytes={from}-"));
        }
        let resp = req.send().await.map_err(|e| format!("无法连接服务端: {e}"))?;
        if resp.status().as_u16() == 401 && attempt == 0 {
            if try_refresh(app, server_id).await.is_ok() {
                continue;
            }
        }
        return Ok(resp);
    }
    Err("AUTH_REQUIRED: 需要重新登录".into())
}

// ---------- 下载（流式 + .part 断点续传 + 进度 + 限速） ----------

/// 下载服务端文件到本机路径（dest_path 为完整文件路径）。
/// 中断后重试会自动从 <dest>.part 已下载位置用 Range 续传（需求3）。
#[tauri::command]
pub async fn srv_download(
    app: AppHandle,
    server_id: String,
    root_id: String,
    path: String,
    dest_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let st = state(&app);
    let limit = st.config().transfer.download_limit_kbps;
    let name = path.rsplit('/').next().unwrap_or("download").to_string();
    let flag = register_cancel(&transfer_id);
    let result = download_inner(
        &app,
        &server_id,
        &format!("{}/api/v1/download", base_of(&st.server(&server_id)?)),
        &[("rootId", root_id.as_str()), ("path", path.as_str())],
        &dest_path,
        &transfer_id,
        &name,
        limit,
        &flag,
    )
    .await;
    unregister_cancel(&transfer_id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn download_inner(
    app: &AppHandle,
    server_id: &str,
    url: &str,
    query: &[(&str, &str)],
    dest_path: &str,
    transfer_id: &str,
    name: &str,
    limit_kbps: u32,
    flag: &AtomicU8,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let part = format!("{dest_path}.part");
    let mut existing: u64 = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    if let Some(dir) = std::path::Path::new(dest_path).parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| e.to_string())?;
    }
    let resp = authed_get(app, server_id, url, query, if existing > 0 { Some(existing) } else { None }).await?;
    let status = resp.status();
    if !status.is_success() {
        if status.as_u16() == 416 && existing > 0 {
            // Range 超出：说明 .part 已是完整文件
            tokio::fs::rename(&part, dest_path)
                .await
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        let t = resp.text().await.unwrap_or_default();
        return Err(api_error(status, &t));
    }
    let append = status.as_u16() == 206 && existing > 0;
    if !append {
        existing = 0;
    }
    let total = existing
        + resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
    let mut file = if append {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .await
            .map_err(|e| e.to_string())?
    } else {
        tokio::fs::File::create(&part)
            .await
            .map_err(|e| e.to_string())?
    };
    let mut resp = resp;
    let mut sent = existing;
    let started = Instant::now();
    let mut last_emit = Instant::now();
    loop {
        let sig = flag.load(Ordering::SeqCst);
        if sig != SIG_NONE {
            let _ = file.flush().await;
            let paused = sig == SIG_PAUSE;
            emit(app, TransferEvent {
                transfer_id: transfer_id.into(), name: name.into(), direction: "download".into(),
                sent, total, speed: 0,
                status: if paused { "paused" } else { "cancelled" }.into(),
                message: if paused { "已暂停（保留 .part，可继续）".into() } else { "已取消（保留 .part 可续传）".into() },
            });
            return Err(if paused { "已暂停" } else { "已取消" }.into());
        }
        let t0 = Instant::now();
        let chunk = resp.chunk().await.map_err(|e| e.to_string())?;
        let Some(chunk) = chunk else { break };
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        sent += chunk.len() as u64;
        pace(limit_kbps, chunk.len() as u64, t0.elapsed()).await;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = Instant::now();
            let speed = (sent.saturating_sub(existing)) as f64 / started.elapsed().as_secs_f64().max(0.001);
            emit(app, TransferEvent {
                transfer_id: transfer_id.into(), name: name.into(), direction: "download".into(),
                sent, total, speed: speed as u64, status: "running".into(), message: String::new(),
            });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&part, dest_path)
        .await
        .map_err(|e| e.to_string())?;
    emit(app, TransferEvent {
        transfer_id: transfer_id.into(), name: name.into(), direction: "download".into(),
        sent, total: sent, speed: 0, status: "done".into(), message: dest_path.into(),
    });
    Ok(())
}

// ---------- 上传（分片 + 断点续传 + 并发写保护 + 进度 + 限速） ----------

const CHUNK_SIZE: u64 = 4 << 20; // 4MB，与服务端默认一致

/// 上传本机文件到服务端 dir 目录（文件名取本机文件名）。
/// 走分片协议：会话可断点续传；base_hash 为覆盖目标的乐观锁（可空）。
#[tauri::command]
pub async fn srv_upload(
    app: AppHandle,
    server_id: String,
    root_id: String,
    dir: String,
    local_path: String,
    transfer_id: String,
    base_hash: Option<String>,
) -> Result<Value, String> {
    let st = state(&app);
    let limit = st.config().transfer.upload_limit_kbps;
    let file_name = std::path::Path::new(&local_path)
        .file_name()
        .ok_or("非法本地路径")?
        .to_string_lossy()
        .into_owned();
    let dir = dir.trim_matches('/');
    let rel = if dir.is_empty() {
        file_name.clone()
    } else {
        format!("{dir}/{file_name}")
    };
    let meta = tokio::fs::metadata(&local_path).await.map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("目录上传暂不支持，请逐个上传文件".into());
    }
    let size = meta.len();
    let flag = register_cancel(&transfer_id);
    let result = upload_inner(
        &app, &server_id, &root_id, &rel, &local_path, &transfer_id, &file_name,
        size, base_hash, limit, &flag,
    )
    .await;
    unregister_cancel(&transfer_id);
    match &result {
        Ok(_) => emit(&app, TransferEvent {
            transfer_id: transfer_id.clone(), name: file_name, direction: "upload".into(),
            sent: size, total: size, speed: 0, status: "done".into(), message: rel.clone(),
        }),
        Err(e) => emit(&app, TransferEvent {
            transfer_id: transfer_id.clone(), name: file_name, direction: "upload".into(),
            sent: 0, total: size, speed: 0,
            status: if e.contains("暂停") {
                "paused"
            } else if e.contains("取消") {
                "cancelled"
            } else {
                "error"
            }
            .into(),
            message: e.clone(),
        }),
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn upload_inner(
    app: &AppHandle,
    server_id: &str,
    root_id: &str,
    rel: &str,
    local_path: &str,
    transfer_id: &str,
    name: &str,
    size: u64,
    base_hash: Option<String>,
    limit_kbps: u32,
    flag: &AtomicU8,
) -> Result<Value, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    // 1) 创建/恢复上传会话（同路径他人会话 → 服务端返回 409 冲突）
    let sess: Value = srv_call(
        app.clone(),
        server_id.to_string(),
        "POST".into(),
        "/api/v1/upload/session".into(),
        Some(json!({
            "rootId": root_id,
            "path": rel,
            "size": size,
            "chunkSize": CHUNK_SIZE,
            "baseHash": base_hash.unwrap_or_default(),
        })),
    )
    .await?;
    let session_id = sess
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or("服务端未返回 sessionId")?
        .to_string();
    let chunk_size = sess
        .get("chunkSize")
        .and_then(|v| v.as_u64())
        .unwrap_or(CHUNK_SIZE)
        .max(1);
    let uploaded: Vec<u64> = sess
        .get("uploadedChunks")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_u64()).collect())
        .unwrap_or_default();
    let chunk_count = if size == 0 { 1 } else { (size + chunk_size - 1) / chunk_size };

    // 2) 逐分片上传（跳过已传分片 → 断点续传）
    let mut file = tokio::fs::File::open(local_path).await.map_err(|e| e.to_string())?;
    let mut sent: u64 = uploaded.iter().map(|i| chunk_bytes(*i, size, chunk_size)).sum();
    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut buf = vec![0u8; chunk_size as usize];
    for i in 0..chunk_count {
        let sig = flag.load(Ordering::SeqCst);
        if sig != SIG_NONE {
            return Err(if sig == SIG_PAUSE {
                "已暂停（会话保留，可继续）".into()
            } else {
                "已取消（会话保留，可断点续传）".into()
            });
        }
        let want = chunk_bytes(i, size, chunk_size);
        if uploaded.contains(&i) {
            continue; // 服务端已收到该分片
        }
        file.seek(std::io::SeekFrom::Start(i * chunk_size))
            .await
            .map_err(|e| e.to_string())?;
        let mut got = 0usize;
        while got < want as usize {
            let n = file
                .read(&mut buf[got..want as usize])
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            got += n;
        }
        let body = buf[..got].to_vec();
        let t0 = Instant::now();
        put_chunk(app, server_id, &session_id, i, body).await?;
        sent += got as u64;
        pace(limit_kbps, got as u64, t0.elapsed()).await;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = Instant::now();
            let speed = sent as f64 / started.elapsed().as_secs_f64().max(0.001);
            emit(app, TransferEvent {
                transfer_id: transfer_id.into(), name: name.into(), direction: "upload".into(),
                sent, total: size, speed: speed as u64, status: "running".into(), message: String::new(),
            });
        }
    }

    // 3) 完成合并（服务端做哈希校验、BaseHash 并发校验、版本快照、原子替换）
    srv_call(
        app.clone(),
        server_id.to_string(),
        "POST".into(),
        "/api/v1/upload/complete".into(),
        Some(json!({ "sessionId": session_id })),
    )
    .await
}

fn chunk_bytes(index: u64, size: u64, chunk_size: u64) -> u64 {
    let start = index * chunk_size;
    if start >= size {
        return 0;
    }
    (size - start).min(chunk_size)
}

/// PUT 单个分片（带认证；401 时自动续期并重试一次）。
async fn put_chunk(
    app: &AppHandle,
    server_id: &str,
    session_id: &str,
    index: u64,
    body: Vec<u8>,
) -> Result<(), String> {
    for attempt in 0..2 {
        let st = state(app);
        let srv = st.server(server_id)?;
        let mut req = stream_client_for(&srv)?
            .put(format!("{}/api/v1/upload/chunk", base_of(&srv)))
            .query(&[("sessionId", session_id), ("index", &index.to_string())])
            .header("Content-Type", "application/octet-stream")
            .body(body.clone());
        if let Some(t) = &srv.token {
            req = req.bearer_auth(t);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("无法连接服务端: {e}"))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let text = resp.text().await.unwrap_or_default();
        if status.as_u16() == 401 && attempt == 0 && try_refresh(app, server_id).await.is_ok() {
            continue;
        }
        return Err(api_error(status, &text));
    }
    Err("AUTH_REQUIRED: 需要重新登录".into())
}

// ---------- 预览 / 媒体缓存（需求11） ----------

fn simple_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// 把服务端文件拉到本地媒体缓存目录（asset 协议已授权），返回缓存绝对路径。
/// 供 <video>/<audio>/<embed> 直接播放（asset 协议支持 Range）。
#[tauri::command]
pub async fn srv_media_cache(
    app: AppHandle,
    server_id: String,
    root_id: String,
    path: String,
) -> Result<String, String> {
    let st = state(&app);
    let srv = st.server(&server_id)?;
    let ext = path.rsplit('.').next().unwrap_or("bin");
    let cache_name = format!("{:x}.{}", simple_hash(&format!("{server_id}/{root_id}/{path}")), ext);
    let dest = st.media_cache_dir().join(&cache_name);
    let dest_s = dest.to_string_lossy().to_string();
    if dest.exists() {
        return Ok(dest_s); // 简单缓存命中
    }
    let url = format!("{}/api/v1/preview", base_of(&srv));
    let limit = st.config().transfer.download_limit_kbps;
    let name = path.rsplit('/').next().unwrap_or("media").to_string();
    let flag = Arc::new(AtomicU8::new(SIG_NONE));
    download_inner(
        &app,
        &server_id,
        &url,
        &[("rootId", root_id.as_str()), ("path", path.as_str())],
        &dest_s,
        &format!("media-{}", simple_hash(&dest_s)),
        &name,
        limit,
        &flag,
    )
    .await?;
    Ok(dest_s)
}

/// 小文件预览：拉取内容返回 data URL（图像/文本等 ≤ max_bytes）。
#[tauri::command]
pub async fn srv_preview_data(
    app: AppHandle,
    server_id: String,
    root_id: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    use base64::Engine;
    let st = state(&app);
    let srv = st.server(&server_id)?;
    let max = max_bytes.unwrap_or(8 << 20);
    let url = format!("{}/api/v1/preview", base_of(&srv));
    let resp = authed_get(
        &app,
        &server_id,
        &url,
        &[("rootId", root_id.as_str()), ("path", path.as_str())],
        None,
    )
    .await?;
    let status = resp.status();
    if !status.is_success() {
        let t = resp.text().await.unwrap_or_default();
        return Err(api_error(status, &t));
    }
    if let Some(len) = resp.content_length() {
        if len > max {
            return Err("文件过大，请下载后查看".into());
        }
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max {
        return Err("文件过大，请下载后查看".into());
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// 服务端文件缩略图（网格视图，需求14）：图像返回 data URL，超限/非图像报错由前端回退图标。
#[tauri::command]
pub async fn srv_thumb(
    app: AppHandle,
    server_id: String,
    root_id: String,
    path: String,
) -> Result<String, String> {
    srv_preview_data(app, server_id, root_id, path, Some(2 << 20)).await
}
