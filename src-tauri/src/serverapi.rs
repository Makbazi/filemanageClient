//! 与 filemanageServer 交互：
//! - 认证：短期 access token + refresh token 自动续期（需求22：3 周滑动会话）
//! - 泛化 API 代理 srv_call（401 → 自动 refresh → 重试 → 仍失败才报 AUTH_REQUIRED）
//! - 分片上传/断点续传/进度事件/取消/限速（需求3、18）
//! - 流式下载 + .part 断点续传（Range）+ 进度事件
//! - TLS：https 直连；服务端为自签证书时可按配置跳过校验（insecureTls）
//! - 媒体缓存：把服务端文件拉到本地缓存目录，供 asset 协议播放（预览，需求11）

use std::collections::HashMap;
use std::error::Error as _;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::config::{state, AppState, ServerConf};

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
    if srv.insecure_tls && srv.normalized_base().starts_with("https://") {
        b = b.danger_accept_invalid_certs(true);
    }
    Ok(b)
}

// ---------- HTTP 客户端复用（0.3.2 断连修复） ----------
//
// reqwest 的连接池在 Client 内部——旧实现每次请求新建 Client，keep-alive 永不
// 生效：4MiB 分片逐个重连重握手，慢链路/NAT 环境下放大悬挂与 reset 概率。
// 按 (地址|TLS 选项|用途) 缓存，配置变更即时换 key，进程内复用。

fn clients() -> &'static Mutex<HashMap<String, reqwest::Client>> {
    static CLIENTS: OnceLock<Mutex<HashMap<String, reqwest::Client>>> = OnceLock::new();
    CLIENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// api=false：JSON 短请求（connect 15s + 总超时 120s，契约不变）；
/// api=true → stream：大流量/长耗时传输（connect 15s、无总超时——耗时不可预估）。
/// 两者均加 tcp_keepalive(30s)：中间设备/对端的空闲断连更早以半开探测暴露，
/// 配合分片重试把"传一半静默断流"从悬挂 2 分钟级压到秒级发现。
fn client_cached(srv: &ServerConf, stream: bool) -> Result<reqwest::Client, String> {
    let key = format!(
        "{}|{}|{}|{}",
        srv.normalized_base(),
        srv.insecure_tls,
        srv.ca_file.as_deref().unwrap_or(""),
        if stream { "stream" } else { "api" }
    );
    if let Some(c) = clients().lock().unwrap().get(&key) {
        return Ok(c.clone());
    }
    let mut b = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .tcp_keepalive(Duration::from_secs(30))
        .tcp_nodelay(true);
    if !stream {
        b = b.timeout(Duration::from_secs(120));
    }
    let c = apply_tls(srv, b)?
        .build()
        .map_err(|e| format!("HTTP 客户端构造失败: {}", req_detail(&e)))?;
    clients().lock().unwrap().insert(key, c.clone());
    Ok(c)
}

/// 按服务端配置取 HTTP 客户端（JSON 短请求，带总超时）。
fn client_for(srv: &ServerConf) -> Result<reqwest::Client, String> {
    client_cached(srv, false)
}

/// 大流量传输客户端：不设总超时（大文件下载/上传耗时不可预估）。
fn stream_client_for(srv: &ServerConf) -> Result<reqwest::Client, String> {
    client_cached(srv, true)
}

/// 拼接请求 URL 的基础地址（0.1.3 修复：经归一——裸 host:port 补 http://，防 reqwest
/// URL 解析失败被吞成误导性的 "builder error"）。
fn base_of(srv: &ServerConf) -> String {
    srv.normalized_base()
}

/// reqwest 错误真实成因：构造类失败（URL/头等）的 Display 只有 "builder error" 一行，
/// 成因藏在 source 里；统一带出，避免用户误判为网络问题（0.1.3 修复）。
fn req_detail(e: &reqwest::Error) -> String {
    match e.source() {
        Some(s) => format!("{e}: {s}"),
        None => e.to_string(),
    }
}

/// 请求发送类错误统一文案。
fn req_err(e: reqwest::Error) -> String {
    format!("无法连接服务端: {}", req_detail(&e))
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
        .map_err(req_err)?;
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
        .map_err(req_err)?;
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
        .map_err(req_err)?;
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
        let resp = req.send().await.map_err(req_err)?;
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
        let resp = req.send().await.map_err(req_err)?;
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
//
// 0.3.2 断连/兜底大修（事故日志：目录上传中 PUT /upload/chunk 卡 2m33s 后
// read tcp connection reset）：
//  1. 分片 PUT 网络级重试 ≤3（1/2/4s 退避）——服务端按 index 幂等覆盖，重发安全；
//  2. complete 移出 srv_call 的 120s 总超时通道（本批主根因：大文件服务端合并
//     被客户端掐 → 服务端其实替换成功 → 重试撞 409 冲突风暴）；任何"没拿到
//     响应"的失败**不重发 complete**，改 GET /upload/session 轮询判 completed；
//  3. 会话创建后校验 chunkCount 与本地片数一致，不符（坏会话/旧服务端残留）
//     先 DELETE 再重建——否则该路径永久卡死；
//  4. 取消（非暂停）尽力 DELETE 会话，即时回收服务端 staging 碎片（不再等 7 天僵尸清理）；
//  5. 错误分类弃用中文串嗅探：FM_PAUSE:/FM_CANCEL:/FM_CONFLICT:/FM_NET: 前缀
//     （UI 展示时剥离），transfer.ts 按前缀路由。
// 另：upload_inner 在关键节点回写本地上传账本（journal，见 localdb.rs）——
//     会话 id/条目终态，支撑"重启后继续目录上传"。

const CHUNK_SIZE: u64 = 4 << 20; // 4MB，与服务端默认一致
const NET_RETRY: u32 = 3; // 分片网络重试次数
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(15 * 60); // complete 请求上限
const POLL_DEADLINE_SECS: u64 = 15 * 60; // 断连后轮询会话状态的上限
const POLL_INTERVAL_SECS: u64 = 5;

/// 账本回写（Rust 侧内部调用；短事务锁，绝不跨 await 持锁——约定11）。
fn journal_write(app: &AppHandle, journal: Option<(&str, &str)>, f: impl FnOnce(&rusqlite::Connection, &str, &str) -> Result<(), String>) {
    let Some((gid, rel)) = journal else { return };
    let st = state(app);
    let guard = st.db.lock();
    if let Ok(db) = guard {
        let _ = f(&db, gid, rel);
    }
}

/// 上传本机文件到服务端 dir 目录（文件名取本机文件名）。
/// 走分片协议：会话可断点续传；base_hash 为覆盖目标的乐观锁（可空；
/// "-"=断言新文件；""=跳过乐观校验）。
/// journal_gid/journal_rel：0.3.2 目录上传账本坐标（非组任务传 null）。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn srv_upload(
    app: AppHandle,
    server_id: String,
    root_id: String,
    dir: String,
    local_path: String,
    transfer_id: String,
    base_hash: Option<String>,
    journal_gid: Option<String>,
    journal_rel: Option<String>,
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
    let journal = match (&journal_gid, &journal_rel) {
        (Some(g), Some(r)) => Some((g.as_str(), r.as_str())),
        _ => None,
    };
    let flag = register_cancel(&transfer_id);
    let result = upload_inner(
        &app, &server_id, &root_id, &rel, &local_path, &transfer_id, &file_name,
        size, base_hash, limit, &flag, journal,
    )
    .await;
    unregister_cancel(&transfer_id);
    match &result {
        Ok(_) => {
            journal_write(&app, journal, |db, g, r| {
                crate::localdb::journal_item_state(db, g, r, "done")
            });
            emit(&app, TransferEvent {
                transfer_id: transfer_id.clone(), name: file_name, direction: "upload".into(),
                sent: size, total: size, speed: 0, status: "done".into(), message: rel.clone(),
            });
        }
        Err(e) => {
            // 前缀路由（0.3.2）：暂停保留 pending（续传坐标不变）；取消记 canceled；
            // 其余失败记 failed（组"重试"仍可重跑同会话）。
            let state = if e.starts_with("FM_PAUSE:") {
                "pending"
            } else if e.starts_with("FM_CANCEL:") {
                "canceled"
            } else {
                "failed"
            };
            journal_write(&app, journal, |db, g, r| {
                crate::localdb::journal_item_state(db, g, r, state)
            });
            emit(&app, TransferEvent {
                transfer_id: transfer_id.clone(), name: file_name, direction: "upload".into(),
                sent: 0, total: size, speed: 0,
                status: if e.starts_with("FM_PAUSE:") {
                    "paused"
                } else if e.starts_with("FM_CANCEL:") {
                    "cancelled"
                } else {
                    "error"
                }
                .into(),
                message: strip_fm(e),
            });
        }
    }
    result
}

/// UI 展示用：剥离 FM_xxx: 前缀（前缀只作机器路由，不给用户看）。
fn strip_fm(msg: &str) -> String {
    for p in ["FM_PAUSE:", "FM_CANCEL:", "FM_CONFLICT:", "FM_NET:"] {
        if let Some(rest) = msg.strip_prefix(p) {
            return rest.trim_start().to_string();
        }
    }
    msg.to_string()
}

/// 创建/恢复上传会话；返回 (sessionId, chunkSize, uploadedChunks, chunkCount)。
async fn create_session(
    app: &AppHandle,
    server_id: &str,
    root_id: &str,
    rel: &str,
    size: u64,
    base_hash: &Option<String>,
) -> Result<(String, u64, Vec<u64>, u64), String> {
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
            "baseHash": base_hash.clone().unwrap_or_default(),
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
    let chunk_count = sess
        .get("chunkCount")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| expected_chunk_count(size, chunk_size));
    Ok((session_id, chunk_size, uploaded, chunk_count))
}

fn expected_chunk_count(size: u64, chunk_size: u64) -> u64 {
    if size == 0 {
        1
    } else {
        (size + chunk_size - 1) / chunk_size
    }
}

/// 作废服务端会话（尽力而为；DELETE /upload/session?id=——0.1.x 起即存在）。
async fn abort_session(app: &AppHandle, server_id: &str, session_id: &str) {
    let _ = srv_call(
        app.clone(),
        server_id.to_string(),
        "DELETE".into(),
        format!("/api/v1/upload/session?id={session_id}"),
        None,
    )
    .await;
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
    journal: Option<(&str, &str)>,
) -> Result<Value, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    // 1) 创建/恢复上传会话（同路径他人会话 → 服务端 409 冲突）
    let (mut session_id, mut chunk_size, mut uploaded, mut chunk_count) =
        create_session(app, server_id, root_id, rel, size, &base_hash).await?;

    // 1b) 坏会话兜底（0.3.2）：服务端返回的片数与本地 size/chunkSize 不符 =
    //     旧会话携带另一版本参数（本地文件改过尺寸后重建命中）。0.2.1 服务端
    //     已自动作废重建；旧服务端会原样返回旧会话——这里 DELETE 后重建一次，
    //     否则越界 400 / assemble size 不符，该路径永久卡死。
    chunk_size = chunk_size.max(1);
    if chunk_count != expected_chunk_count(size, chunk_size) {
        abort_session(app, server_id, &session_id).await;
        let s2 = create_session(app, server_id, root_id, rel, size, &base_hash).await?;
        session_id = s2.0;
        chunk_size = s2.1.max(1);
        uploaded = s2.2;
        chunk_count = s2.3;
    }
    // 账本：会话坐标回写（重启续传的关键——本地条目 ↔ 服务端会话）
    let sid_j = session_id.clone();
    journal_write(app, journal, move |db, g, r| {
        crate::localdb::journal_set_session(db, g, r, &sid_j)
    });

    // 2) 逐分片上传（跳过已传分片 → 断点续传）
    let mut file = tokio::fs::File::open(local_path).await.map_err(|e| e.to_string())?;
    let mut sent: u64 = uploaded.iter().map(|i| chunk_bytes(*i, size, chunk_size)).sum();
    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut buf = vec![0u8; chunk_size as usize];
    for i in 0..chunk_count {
        let sig = flag.load(Ordering::SeqCst);
        if sig != SIG_NONE {
            if sig == SIG_CANCEL {
                // 取消=废弃本次任务：作废服务端会话，staging 碎片即时回收（0.3.2）
                abort_session(app, server_id, &session_id).await;
                return Err("FM_CANCEL: 已取消（会话已作废，重传该文件将全新开始）".into());
            }
            return Err("FM_PAUSE: 已暂停（会话保留，可继续）".into());
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
    complete_with_polling(app, server_id, &session_id).await
}

fn chunk_bytes(index: u64, size: u64, chunk_size: u64) -> u64 {
    let start = index * chunk_size;
    if start >= size {
        return 0;
    }
    (size - start).min(chunk_size)
}

/// complete 的结果分类：Rejected=服务端明确答复（未发生合并/被拒，语义错误
/// 直接上抛）；Lost=没拿到完整响应（连接中断/超时——服务端**可能仍在合并**，
/// 绝不能重发 POST，转轮询）。
enum CompleteFail {
    Rejected(String),
    Lost(String),
}

/// POST /upload/complete + 断连轮询闭环（0.3.2 主修复）。
async fn complete_with_polling(app: &AppHandle, server_id: &str, session_id: &str) -> Result<Value, String> {
    match complete_post(app, server_id, session_id).await {
        Ok(v) => Ok(v),
        Err(CompleteFail::Rejected(msg)) => Err(msg),
        Err(CompleteFail::Lost(hint)) => {
            // 不重发 complete——服务端合并完成前会话恒 uploading，重发=双合并竞态。
            let deadline = Instant::now() + Duration::from_secs(POLL_DEADLINE_SECS);
            loop {
                tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
                match get_session(app, server_id, session_id).await {
                    Ok(sess) => {
                        let status = sess.get("status").and_then(|v| v.as_str()).unwrap_or("");
                        if status == "completed" {
                            return Ok(json!({ "ok": true, "polled": true, "sessionId": session_id }));
                        }
                        if Instant::now() >= deadline {
                            return Err(format!(
                                "FM_NET: 连接中断（{hint}）后轮询 15 分钟仍未见合并完成；若目标文件已是新版本，跳过重试即可，否则重试该文件"
                            ));
                        }
                    }
                    Err(e) => {
                        // 404=会话记录已不存在（被作废/清理）——不可能再"成功"
                        if e.contains("HTTP 404") || e.to_lowercase().contains("not found") {
                            return Err("会话已过期或被作废，请重新上传该文件".into());
                        }
                        if Instant::now() >= deadline {
                            return Err(format!("FM_NET: 连接中断（{hint}）且状态查询持续失败：{e}"));
                        }
                    }
                }
            }
        }
    }
}

/// 提交合并请求；401 续期重发一次（401 无副作用）。
async fn complete_post(app: &AppHandle, server_id: &str, session_id: &str) -> Result<Value, CompleteFail> {
    for attempt in 0..2 {
        let st = state(app);
        let srv = st.server(server_id).map_err(CompleteFail::Rejected)?;
        let req = stream_client_for(&srv)
            .map_err(CompleteFail::Rejected)?
            .post(format!("{}/api/v1/upload/complete", base_of(&srv)))
            .json(&json!({ "sessionId": session_id }));
        let req = if let Some(t) = &srv.token { req.bearer_auth(t) } else { req };
        let sent = tokio::time::timeout(COMPLETE_TIMEOUT, req.send()).await;
        let resp = match sent {
            Err(_) => return Err(CompleteFail::Lost("complete 请求 15 分钟未完成".into())),
            Ok(Err(e)) => return Err(CompleteFail::Lost(req_err(e))),
            Ok(Ok(r)) => r,
        };
        let status = resp.status();
        if status.as_u16() == 401 && attempt == 0 && try_refresh(app, server_id).await.is_ok() {
            continue; // 401 在进入业务前返回，无副作用，重发安全
        }
        let text = match tokio::time::timeout(COMPLETE_TIMEOUT, resp.text()).await {
            Err(_) | Ok(Err(_)) => {
                // 状态都拿到了才走到这——响应体断流：合并多半已执行，转轮询
                if status.is_success() {
                    return Err(CompleteFail::Lost(format!("合并响应中断（HTTP {status}）")));
                }
                return Err(CompleteFail::Rejected(api_error(status, "")));
            }
            Ok(Ok(t)) => t,
        };
        if !status.is_success() {
            let msg = api_error(status, &text);
            return Err(CompleteFail::Rejected(if status.as_u16() == 409 {
                format!("FM_CONFLICT: {msg}")
            } else {
                msg
            }));
        }
        return serde_json::from_str::<Value>(&text)
            .map_err(|e| CompleteFail::Lost(format!("合并响应解析失败: {e}")));
    }
    Err(CompleteFail::Rejected(
        "AUTH_REQUIRED: 需要重新登录".into(),
    ))
}

/// GET /upload/session?id=（续传/完成状态查询；返回原始 JSON 或错误串）。
async fn get_session(app: &AppHandle, server_id: &str, session_id: &str) -> Result<Value, String> {
    srv_call(
        app.clone(),
        server_id.to_string(),
        "GET".into(),
        format!("/api/v1/upload/session?id={session_id}"),
        None,
    )
    .await
}

/// 分片 PUT 失败的分类：Net=可重试（传输层/408/429/5xx——服务端按 index
/// 幂等覆盖，重发安全）；Fatal=语义错误（400 坏会话/403/409/404，重试无意义）。
enum ChunkFail {
    Net(String),
    Fatal(String),
}

/// PUT 单个分片（带认证；401 自动续期一次；网络类失败 ≤3 次退避重试 1/2/4s）。
async fn put_chunk(
    app: &AppHandle,
    server_id: &str,
    session_id: &str,
    index: u64,
    body: Vec<u8>,
) -> Result<(), String> {
    let mut net_attempts = 0u32;
    loop {
        match put_chunk_try(app, server_id, session_id, index, &body).await {
            Ok(()) => return Ok(()),
            Err(ChunkFail::Fatal(msg)) => return Err(msg),
            Err(ChunkFail::Net(msg)) => {
                net_attempts += 1;
                if net_attempts >= NET_RETRY {
                    return Err(format!("FM_NET: {msg}（重试 {NET_RETRY} 次仍失败）"));
                }
                let ms = (1000u64 << (net_attempts - 1)) + (index * 137 % 700); // 1/2/4s + 抖动
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
        }
    }
}

async fn put_chunk_try(
    app: &AppHandle,
    server_id: &str,
    session_id: &str,
    index: u64,
    body: &[u8],
) -> Result<(), ChunkFail> {
    for attempt in 0..2 {
        let st = state(app);
        let srv = st.server(server_id).map_err(ChunkFail::Fatal)?;
        let mut req = stream_client_for(&srv)
            .map_err(ChunkFail::Fatal)?
            .put(format!("{}/api/v1/upload/chunk", base_of(&srv)))
            .query(&[("sessionId", session_id), ("index", &index.to_string())])
            .header("Content-Type", "application/octet-stream")
            .body(body.to_vec());
        if let Some(t) = &srv.token {
            req = req.bearer_auth(t);
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => return Err(ChunkFail::Net(req_err(e))),
        };
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let text = resp.text().await.unwrap_or_default();
        let code = status.as_u16();
        if code == 401 && attempt == 0 {
            if try_refresh(app, server_id).await.is_ok() {
                continue;
            }
            return Err(ChunkFail::Fatal(api_error(status, &text)));
        }
        if matches!(code, 408 | 429) || code >= 500 {
            return Err(ChunkFail::Net(format!("HTTP {code}: {}", strip_fm(&api_error(status, &text)))));
        }
        if code == 409 {
            return Err(ChunkFail::Fatal(format!("FM_CONFLICT: {}", api_error(status, &text))));
        }
        return Err(ChunkFail::Fatal(api_error(status, &text)));
    }
    Err(ChunkFail::Fatal("AUTH_REQUIRED: 需要重新登录".into()))
}

// ---------- 预览 / 媒体缓存（需求11） ----------

fn simple_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// 媒体缓存键（与 localfs::cache_key 同构，前缀多 server_id）；
/// srv_media_cache 与 srv_thumb 共用，缩略图条目 = `<key_hash>.thumb.jpg`。
fn srv_media_key(server_id: &str, root_id: &str, path: &str, ver: Option<&str>) -> String {
    match ver {
        Some(v) => format!("{server_id}/{root_id}/{path}@{v}"),
        None => format!("{server_id}/{root_id}/{path}"),
    }
}

/// 把服务端文件确保纳入本地媒体缓存目录（asset 协议已授权），返回缓存路径。
/// 供 <img>/<video>/<audio>/<embed> 直接加载（asset 协议支持 Range）。
/// 0.1.7：可选 ver（前端传 entry.mtime 串）并入缓存键，防覆盖后 exists 命中旧内容。
/// 0.2.1：相机 RAW 浏览器不可解码——先落可续传 scratch 下载原始字节，再提取
/// **最大内嵌 JPEG 预览**定名 .jpg 并删 scratch（提取失败留 scratch 供重试）；
/// 提取失败报错、前端回退图标。字节来源为既有 `GET /api/v1/preview`（同端点
/// 同权限，服务端零改动，需求6 匿名语义不变）。非 RAW 下载语义不变：
/// download_inner 经 `<dest>.part` 断点续传、完成 rename，exists 只命中成品。
pub(crate) async fn srv_media_ensure(
    app: &AppHandle,
    server_id: &str,
    root_id: &str,
    path: &str,
    ver: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    use std::fs;
    let st = state(app);
    let srv = st.server(server_id)?;
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    let raw = crate::thumb::is_raw_ext(&ext);
    let key = srv_media_key(server_id, root_id, path, ver);
    let key_hash = simple_hash(&key);
    let cache_name = format!("{:x}.{}", key_hash, if raw { "jpg" } else { ext.as_str() });
    let dest = st.media_cache_dir().join(&cache_name);
    if dest.exists() {
        crate::cachemgr::touch(&dest); // 命中=访问（0.3.2 LRU；hard_link 条目跳过）
        return Ok(dest);
    }
    let url = format!("{}/api/v1/preview", base_of(&srv));
    let limit = st.config().transfer.download_limit_kbps;
    let name = path.rsplit('/').next().unwrap_or("media").to_string();
    let flag = Arc::new(AtomicU8::new(SIG_NONE));
    if !raw {
        let dest_s = dest.to_string_lossy().to_string();
        download_inner(
            app,
            server_id,
            &url,
            &[("rootId", root_id), ("path", path)],
            &dest_s,
            &format!("media-{key_hash:x}"),
            &name,
            limit,
            &flag,
        )
        .await?;
        note_media_write(&st, &dest);
        return Ok(dest);
    }
    // RAW：原始字节下到 scratch（可续传），提取预览后 scratch 删除不双占空间
    let scratch = st.media_cache_dir().join(format!("{key_hash:x}.raw-src"));
    if !scratch.exists() {
        download_inner(
            app,
            server_id,
            &url,
            &[("rootId", root_id), ("path", path)],
            &scratch.to_string_lossy(),
            &format!("media-{key_hash:x}"),
            &name,
            limit,
            &flag,
        )
        .await?;
    }
    let data = fs::read(&scratch).map_err(|e| e.to_string())?;
    let jpeg = crate::thumb::extract_preview(&data)
        .ok_or("该 RAW 未找到完整内嵌 JPEG 预览，请下载后用 RAW 软件查看")?;
    fs::write(&dest, &jpeg).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&scratch);
    note_media_write(&st, &dest);
    Ok(dest)
}

/// 媒体缓存新落盘条目：登记字节数并触发超限淘汰（0.3.2 磁盘 ≤10GB LRU）。
fn note_media_write(st: &AppState, dest: &std::path::Path) {
    if let Ok(m) = std::fs::metadata(dest) {
        crate::cachemgr::note_new_file(m.len());
    }
    crate::cachemgr::maybe_enforce(st);
}

#[tauri::command]
pub async fn srv_media_cache(
    app: AppHandle,
    server_id: String,
    root_id: String,
    path: String,
    ver: Option<String>,
) -> Result<String, String> {
    let p = srv_media_ensure(&app, &server_id, &root_id, &path, ver.as_deref()).await?;
    Ok(p.to_string_lossy().into_owned())
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

/// 服务端文件缩略图（网格视图，需求14；0.3.2 改版——"浏览零下载"核心）。
/// 优先走服务端 `GET /api/v1/thumb`（Server 0.2.1 加性端点）：只回 ≤512px
/// JPEG，**网格浏览不再把整文件拉进本地媒体缓存**；产物仍落媒体缓存
/// `<key_hash>.thumb.jpg`（与旧管线同名同键，前端 blob 通道不变）。
/// 回退链（兼容与安全垫）：
///  - 404（Server ≤0.2.0）→ 整条旧管线：srv_media_ensure 整文件入缓存后本地
///    缩放（旧语义，现已受 10GB LRU 约束；CHANGELOG 声明为已接受代价）；
///  - 413/415/429（服务端过大/不可解码/繁忙）且 size_hint ≤8MiB → 旧管线
///    （webp/heic/svg 等回浏览器自绘——查看可临时落盘、纳入上限淘汰的已确认边界）；
///  - 同上但 >8MiB → Err（前端图标回退 + 队列退避重试）。
/// 返回缓存绝对路径（前端经 media_read_bytes 建 blob，≤2GB 内存 LRU）。
#[tauri::command]
pub async fn srv_thumb(
    app: AppHandle,
    server_id: String,
    root_id: String,
    path: String,
    ver: Option<String>,
    size_hint: Option<u64>,
) -> Result<String, String> {
    let st = state(&app);
    let key = srv_media_key(&server_id, &root_id, &path, ver.as_deref());
    let key_hash = simple_hash(&key);
    let thumb = st.media_cache_dir().join(format!("{key_hash:x}.thumb.jpg"));
    if thumb.exists() {
        crate::cachemgr::touch(&thumb);
        return Ok(thumb.to_string_lossy().into_owned());
    }
    let small = size_hint.unwrap_or(0) <= 8 << 20;
    match fetch_server_thumb(&app, &server_id, &root_id, &path).await {
        ServerThumb::Bytes(b) => {
            let _ = std::fs::create_dir_all(st.media_cache_dir());
            let tmp = st.media_cache_dir().join(format!("{key_hash:x}.thumb.jpg.tmp"));
            std::fs::write(&tmp, &b).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &thumb).map_err(|e| e.to_string())?;
            crate::cachemgr::note_new_file(b.len() as u64);
            crate::cachemgr::maybe_enforce(&st);
            return Ok(thumb.to_string_lossy().into_owned());
        }
        ServerThumb::Legacy => {}
        ServerThumb::Unsupported(_) if small => {} // 小文件：旧管线让浏览器自绘
        ServerThumb::Unsupported(msg) => return Err(msg),
    }
    // 旧管线（0.2.1 语义）：整文件入媒体缓存后本地缩放
    let src = srv_media_ensure(&app, &server_id, &root_id, &path, ver.as_deref()).await?;
    match crate::thumb::ensure_thumb(&st, &key, &src) {
        Ok(t) => Ok(t.to_string_lossy().into_owned()),
        Err(e) => {
            if std::fs::metadata(&src).map(|m| m.len() <= 8 << 20).unwrap_or(false) {
                Ok(src.to_string_lossy().into_owned())
            } else {
                Err(e)
            }
        }
    }
}

enum ServerThumb {
    /// 服务端 0.2.1+：直接拿到 ≤512px JPEG 字节
    Bytes(Vec<u8>),
    /// 端点不存在（旧服务端）→ 旧管线
    Legacy,
    /// 服务端明确不可生成（413/415/语义 401/403…），携带展示错误
    Unsupported(String),
}

/// 拉服务端缩略图；429（生成器繁忙）退避 2s/4s 共试 3 次。
async fn fetch_server_thumb(app: &AppHandle, server_id: &str, root_id: &str, path: &str) -> ServerThumb {
    let srv = match state(app).server(server_id) {
        Ok(s) => s,
        Err(e) => return ServerThumb::Unsupported(e),
    };
    let url = format!("{}/api/v1/thumb", base_of(&srv));
    for attempt in 0..3u64 {
        let resp = match authed_get(
            app,
            server_id,
            &url,
            &[("rootId", root_id), ("path", path)],
            None,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => return ServerThumb::Unsupported(e),
        };
        let status = resp.status();
        match status.as_u16() {
            200 => match resp.bytes().await {
                Ok(b) => return ServerThumb::Bytes(b.to_vec()),
                Err(e) => return ServerThumb::Unsupported(format!("缩略图流读取失败: {e}")),
            },
            404 => return ServerThumb::Legacy, // 旧服务端无此端点
            429 => {
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(2000 << attempt)).await;
                    continue;
                }
                return ServerThumb::Unsupported("服务端缩略图生成繁忙，稍后重试".into());
            }
            413 | 415 => return ServerThumb::Unsupported("服务端不支持该文件的缩略图".into()),
            _ => {
                let t = resp.text().await.unwrap_or_default();
                return ServerThumb::Unsupported(api_error(status, &t));
            }
        }
    }
    ServerThumb::Unsupported("服务端缩略图生成繁忙".into())
}
