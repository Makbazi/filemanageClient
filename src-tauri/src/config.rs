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
}

/// AI 能力配置（云厂商 OpenAI 兼容接口 / 本地 ollama），预留接入。
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
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
}

/// 全局共享状态：配置目录 + 内存中的配置。
pub struct AppState {
    pub data_dir: PathBuf,
    pub config: RwLock<AppConfig>,
}

impl AppState {
    pub fn load(data_dir: PathBuf) -> Self {
        let cfg = read_config(&data_dir).unwrap_or_default();
        Self {
            data_dir,
            config: RwLock::new(cfg),
        }
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
        f(&mut guard);
        let snapshot = guard.clone();
        drop(guard);
        write_config(&self.data_dir, &snapshot)?;
        let _ = app;
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

    pub fn trash_index(&self) -> PathBuf {
        self.data_dir.join("trash.json")
    }

    pub fn ai_index(&self) -> PathBuf {
        self.data_dir.join("ai_descriptions.json")
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

/// 供各模块共用的 JSON 文件读写。
pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, default: T) -> T {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(default)
}

pub fn write_json(path: &Path, v: &(impl Serialize + ?Sized)) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let b = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, b).map_err(|e| e.to_string())
}
