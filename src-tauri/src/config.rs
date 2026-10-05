//! 客户端配置：本地目录、多服务端、AI、界面偏好（主题/视图/位置恢复/会话恢复）、
//! 传输限速、已记住的服务端账户索引（密码本体只进系统凭证库，本文件不落盘）。
//! 配置存于 app_data_dir/config.json，tmp+rename 原子写。

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 本地托管目录（客户端独立部署时配置一个本地目录即可管理）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootConf {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// 已配置的服务端（可配置多个）。
/// token 为短期访问令牌；refresh_token 用于自动续期（需求22：3 周滑动会话）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConf {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// 信任自签证书（服务端 TLS 使用自签证书时开启，需求3）
    #[serde(default)]
    pub insecure_tls: bool,
    /// 指定 CA 证书文件路径（PEM，0.4.0 安全升级：优先于 insecure_tls，避免全盘跳过校验）
    #[serde(default)]
    pub ca_file: Option<String>,
}

impl ServerConf {
    /// 地址归一（0.1.3 修复）：去首尾空白；缺协议头的裸 `host[:port][/路径]` 按 `http://` 补全。
    /// 缺 scheme 时 reqwest 的 URL 解析直接失败，但 Display 只有 "builder error" 一行，
    /// 与网络故障无法区分；补全走明文 http——前端保存该形态时已二次确认风险。
    pub(crate) fn norm_base(url: &str) -> String {
        let t = url.trim();
        if t.is_empty() {
            return String::new();
        }
        let lower = t.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            t.to_string()
        } else {
            format!("http://{t}")
        }
    }

    /// 拼接请求 URL 用的基础地址：归一 + 去尾部 '/'。
    pub fn normalized_base(&self) -> String {
        Self::norm_base(&self.base_url).trim_end_matches('/').to_string()
    }
}

/// AI 能力配置（云厂商 OpenAI 兼容接口 / 本地 ollama）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIConf {
    /// none | openai | ollama
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl Default for AIConf {
    fn default() -> Self {
        Self {
            provider: "none".into(),
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
        }
    }
}

/// 当前激活的来源：本地目录 或 某个服务端。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveConf {
    /// local | server
    pub kind: String,
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub root_id: String,
}

/// 上次关闭时的位置（需求21：启动时可选恢复）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastLocation {
    #[serde(default)]
    pub active: Option<ActiveConf>,
    #[serde(default)]
    pub view: String, // files | trash | ai | search
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub view_mode: String, // list | grid
}

/// 已"记住密码"的服务端账户索引（0.6.0 需求3）。密码本体存系统凭证库
/// （key 为 {serverId}/{username}/password），config.json 只存非敏感索引；
/// 同一服务端可有多条（多账户），同一账户配到不同服务端按 serverId 隔离。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredRef {
    pub server_id: String,
    pub username: String,
}

/// 界面偏好（需求5/14/21）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiConf {
    /// 主题：dark-glass | light | nord | dracula | ocean
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 目录浏览风格：list（按行）| grid（按缩略图，需求14）
    #[serde(default = "default_view_mode")]
    pub view_mode: String,
    /// 启动时恢复上次关闭位置（需求21）
    #[serde(default)]
    pub restore_last_location: bool,
    #[serde(default)]
    pub last_location: Option<LastLocation>,
    /// 按文件类型分组显示（需求15）
    #[serde(default)]
    pub group_by_kind: bool,
    /// 左侧导航栏是否折叠为小箭头标签（0.4.0；默认折叠，点击标签显隐）
    #[serde(default = "default_true")]
    pub sidebar_collapsed: bool,
    /// 启动时是否恢复各服务端登录状态（0.6.0 需求9）。
    /// true（默认）：上次保持登录的服务端重启后仍为登录态，可直接打开远程；
    /// false：启动时清除全部令牌，所有服务端置为退出状态（已记住的密码保留）。
    #[serde(default = "default_true")]
    pub restore_sessions: bool,
    /// 快速切换第二按钮指向的远程服务端 id（0.6.0 需求10）
    #[serde(default)]
    pub last_server_id: Option<String>,
    /// 关闭按钮(X)行为（0.3.0 需求2）：tray=隐藏到托盘（默认；托盘不可用环境
    /// 自动退回退出）| quit=退出程序
    #[serde(default = "default_close_action")]
    pub close_action: String,
    /// 视频播放方式（0.3.0 需求1）：system=WebView 内 <video> 走系统解码器
    /// （默认；解码失败时查看器提示并可一键改用外部播放器）| external=外部播放器
    #[serde(default = "default_video_decoder")]
    pub video_decoder: String,
    /// 外部播放器命令（0.3.0；空=系统关联播放器）。argv 直起不经 shell，
    /// 含 `{file}` 则替换为文件路径，否则路径追加为末位参数；路径含空格请为命令加引号
    #[serde(default)]
    pub video_player_cmd: Option<String>,
}

fn default_theme() -> String {
    "dark-glass".into()
}
fn default_view_mode() -> String {
    "list".into()
}
fn default_true() -> bool {
    true
}
fn default_trash_days() -> i64 {
    30
}
fn default_close_action() -> String {
    "tray".into()
}
fn default_video_decoder() -> String {
    "system".into()
}

impl Default for UiConf {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            view_mode: default_view_mode(),
            restore_last_location: false,
            last_location: None,
            group_by_kind: false,
            sidebar_collapsed: true,
            restore_sessions: true,
            last_server_id: None,
            close_action: default_close_action(),
            video_decoder: default_video_decoder(),
            video_player_cmd: None,
        }
    }
}

/// 传输设置（需求18：限速，0 = 不限速）。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferConf {
    #[serde(default)]
    pub upload_limit_kbps: u32,
    #[serde(default)]
    pub download_limit_kbps: u32,
}

/// 媒体/缩略图缓存配额（0.3.2 需求3/4/5）：
/// - 磁盘：媒体缓存目录（缩略图/预览/查看落盘）总上限，Rust LRU 按 mtime 淘汰执行；
///   跨程序退出保留复用（设置页可手动清空）。
/// - 内存：缩略图字节 blob 缓存预算，前端 thumbcache.ts 读取执行。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheConf {
    /// 磁盘缓存上限 MB（默认 10240 = 10GB）
    #[serde(default = "default_cache_disk_mb")]
    pub max_disk_mb: u64,
    /// 缩略图内存缓存上限 MB（默认 2048 = 2GB）
    #[serde(default = "default_cache_mem_mb")]
    pub max_mem_mb: u64,
}

fn default_cache_disk_mb() -> u64 {
    10240
}
fn default_cache_mem_mb() -> u64 {
    2048
}

impl Default for CacheConf {
    fn default() -> Self {
        Self {
            max_disk_mb: default_cache_disk_mb(),
            max_mem_mb: default_cache_mem_mb(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub local_roots: Vec<RootConf>,
    #[serde(default)]
    pub servers: Vec<ServerConf>,
    #[serde(default)]
    pub ai: AIConf,
    #[serde(default)]
    pub active: Option<ActiveConf>,
    #[serde(default)]
    pub ui: UiConf,
    #[serde(default)]
    pub transfer: TransferConf,
    /// 本地回收站自动清理保留天数（0.4.0，需求：与服务端各自独立的 30 天清理）
    #[serde(default = "default_trash_days")]
    pub trash_retention_days: i64,
    /// 已记住密码的服务端账户索引（0.6.0 需求3；密码本体在系统凭证库）
    #[serde(default)]
    pub credentials: Vec<CredRef>,
    /// 媒体/缩略图缓存配额（0.3.2 需求3/4/5）
    #[serde(default)]
    pub cache: CacheConf,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            local_roots: Vec::new(),
            servers: Vec::new(),
            ai: AIConf::default(),
            active: None,
            ui: UiConf::default(),
            transfer: TransferConf::default(),
            trash_retention_days: default_trash_days(),
            credentials: Vec::new(),
            cache: CacheConf::default(),
        }
    }
}

impl AppConfig {
    /// 副本：清空服务端令牌——令牌存系统凭证库后 config.json 不再落盘明文（0.4.0）。
    pub fn without_tokens(&self) -> AppConfig {
        let mut c = self.clone();
        for s in c.servers.iter_mut() {
            s.token = None;
            s.refresh_token = None;
        }
        c
    }
}

/// 全局共享状态：配置目录 + 内存中的配置 + 本地元数据库。
pub struct AppState {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub config: RwLock<AppConfig>,
    /// 本地元数据库（localdb.sqlite3）。rusqlite Connection 为 Send 非 Sync，用 Mutex 保护；
    /// 取锁仅限同步段，禁止跨 .await 持有。
    pub db: std::sync::Mutex<rusqlite::Connection>,
    /// 系统凭证库可用性（true 时 token 存 keyring，config.json 不落盘明文；0.4.0）。
    pub keyring_ok: bool,
}

impl AppState {
    pub fn load(data_dir: PathBuf, cache_dir: PathBuf) -> Result<Self, String> {
        let mut cfg = read_config(&data_dir).unwrap_or_default();
        // 0.1.3 修复：旧 config.json 的服务端地址可能缺协议头（裸 host:port，reqwest 报
        // 不透明的 "builder error"）；启动即归一补 http://——Rust 请求路径与前端消费者
        // （分享链接拼接等）共用同一权威值，下一次 save_config 自然落盘修正。
        for s in cfg.servers.iter_mut() {
            s.base_url = ServerConf::norm_base(&s.base_url);
        }
        let keyring_ok = crate::secret::available();
        if keyring_ok {
            let mut migrated = false;
            for s in cfg.servers.iter_mut() {
                if s.token.is_some() || s.refresh_token.is_some() {
                    // 旧版明文 token → 一次性迁移进凭证库（config.json 稍后脱敏回写）
                    let _ = crate::secret::set_tokens(&s.id, s.token.as_deref(), s.refresh_token.as_deref());
                    migrated = true;
                } else {
                    let (t, r) = crate::secret::get_tokens(&s.id);
                    if t.is_some() || r.is_some() {
                        s.token = t;
                        s.refresh_token = r;
                    }
                }
            }
            if migrated {
                write_config(&data_dir, &cfg.without_tokens())?;
            }
        } else {
            eprintln!("提示: 系统凭证库不可用，服务端令牌将以明文存于 config.json（建议启用 Keychain/Keyring/Secret Service）");
        }
        // 0.6.0 需求9：关闭"启动恢复登录状态"时，上次保持登录的服务端在启动时一律置为退出
        // （清内存令牌 + 凭证库令牌；已记住的密码保留，供下次快速登录）。
        if !cfg.ui.restore_sessions {
            let had = cfg.servers.iter().any(|s| s.token.is_some() || s.refresh_token.is_some());
            if had {
                for s in cfg.servers.iter_mut() {
                    s.token = None;
                    s.refresh_token = None;
                    if keyring_ok {
                        let _ = crate::secret::set_tokens(&s.id, None, None);
                    }
                }
                let out = if keyring_ok { cfg.without_tokens() } else { cfg.clone() };
                write_config(&data_dir, &out)?;
            }
        }
        let _ = std::fs::create_dir_all(cache_dir.join("media"));
        let db = crate::localdb::open_and_migrate(&data_dir)?;
        Ok(Self {
            data_dir,
            cache_dir,
            config: RwLock::new(cfg),
            db: std::sync::Mutex::new(db),
            keyring_ok,
        })
    }

    pub fn config(&self) -> AppConfig {
        self.config.read().expect("config lock").clone()
    }

    pub fn update<F: FnOnce(&mut AppConfig)>(
        &self,
        app: &tauri::AppHandle,
        f: F,
    ) -> Result<AppConfig, String> {
        let mut guard = self.config.write().expect("config lock");
        let prev_ids: Vec<String> = guard.servers.iter().map(|s| s.id.clone()).collect();
        let prev_creds: Vec<CredRef> = guard.credentials.clone();
        // 0.6.0（需求1）：记录变更前的令牌，keyring 只写真正变化的条目——
        // 前端位置持久化每 ~800ms 触发一次 save，全量重写会造成 Secret Service IPC 风暴。
        let prev_tokens: Vec<(String, Option<String>, Option<String>)> = guard
            .servers
            .iter()
            .map(|s| (s.id.clone(), s.token.clone(), s.refresh_token.clone()))
            .collect();
        f(&mut guard);
        let snapshot = guard.clone();
        drop(guard);
        let _ = app;
        if self.keyring_ok {
            // 被删除的服务端：连带清理凭证库条目（token + 该服务端全部已记住密码）
            let new_ids: Vec<&str> = snapshot.servers.iter().map(|s| s.id.as_str()).collect();
            for id in &prev_ids {
                if !new_ids.contains(&id.as_str()) {
                    crate::secret::remove(id);
                    for c in prev_creds.iter().filter(|c| c.server_id == *id) {
                        let _ = crate::secret::set_password(&c.server_id, &c.username, None);
                    }
                }
            }
            // 被移除的账户索引（如切换账户后清除记住）：清对应凭证库密码
            for c in &prev_creds {
                if !snapshot.credentials.contains(c) {
                    let _ = crate::secret::set_password(&c.server_id, &c.username, None);
                }
            }
            let mut ring_err = String::new();
            for s in &snapshot.servers {
                let changed = match prev_tokens.iter().find(|(id, _, _)| *id == s.id) {
                    None => s.token.is_some() || s.refresh_token.is_some(),
                    Some((_, pt, pr)) => pt != &s.token || pr != &s.refresh_token,
                };
                if changed {
                    if let Err(e) =
                        crate::secret::set_tokens(&s.id, s.token.as_deref(), s.refresh_token.as_deref())
                    {
                        ring_err = e;
                    }
                }
            }
            if ring_err.is_empty() {
                return match write_config(&self.data_dir, &snapshot.without_tokens()) {
                    Ok(()) => Ok(snapshot),
                    Err(e) => Err(e),
                };
            }
            eprintln!("警告: 写入系统凭证库失败，本轮回退明文存储 config.json: {ring_err}");
        }
        write_config(&self.data_dir, &snapshot)?;
        Ok(snapshot)
    }

    pub fn root_path(&self, root_id: &str) -> Result<PathBuf, String> {
        let cfg = self.config();
        let root = cfg
            .local_roots
            .iter()
            .find(|r| r.id == root_id)
            .ok_or_else(|| format!("未知的本地目录: {root_id}"))?;
        Ok(PathBuf::from(&root.path))
    }

    pub fn server(&self, server_id: &str) -> Result<ServerConf, String> {
        let cfg = self.config();
        cfg.servers
            .iter()
            .find(|s| s.id == server_id)
            .cloned()
            .ok_or_else(|| format!("未知的服务端: {server_id}"))
    }

    pub fn trash_dir(&self, root_id: &str) -> PathBuf {
        self.data_dir.join("trash").join(root_id)
    }

    /// 本地文件版本内容目录（需求13；版本索引已入 localdb.sqlite3）。
    pub fn versions_dir(&self) -> PathBuf {
        self.data_dir.join("versions")
    }

    /// 媒体预览缓存目录（asset 协议已授权该目录）。
    pub fn media_cache_dir(&self) -> PathBuf {
        self.cache_dir.join("media")
    }
}

pub fn state(app: &tauri::AppHandle) -> std::sync::Arc<AppState> {
    app.state::<std::sync::Arc<AppState>>().inner().clone()
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

fn read_config(data_dir: &Path) -> Result<AppConfig, String> {
    let p = config_path(data_dir);
    if !p.exists() {
        return Ok(AppConfig::default());
    }
    let b = std::fs::read(&p).map_err(|e| e.to_string())?;
    if b.is_empty() {
        return Ok(AppConfig::default());
    }
    serde_json::from_slice(&b).map_err(|e| format!("解析配置失败: {e}"))
}

pub fn write_config(data_dir: &Path, cfg: &AppConfig) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let b = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    let p = config_path(data_dir);
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &b).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// 读取 JSON 文件（仅用于一次性导入旧版 *.json 元数据）。
pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, default: T) -> T {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(default)
}
