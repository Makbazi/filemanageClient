//! 本地模式的 AI 能力（预留）：对文件/图像生成文字描述并持久化，
//! 支持按文字描述搜索文件。服务端模式下 AI 走服务端 /api/v1/ai/* 接口。

use std::time::Duration;

use base64::Engine;
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::config::{read_json, state, write_json, AIConf};
use crate::localfs::{kind_of, resolve_in_root};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescRecord {
    pub root_id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub text: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub embedding: Vec<u8>, // 预留：向量检索
}

fn load_descs(st: &crate::config::AppState) -> Vec<DescRecord> {
    read_json(&st.ai_index(), Vec::new())
}

fn prompt_for(kind: &str, name: &str) -> String {
    match kind {
        "image" => format!("请观察这张图片（文件名：{name}），用一句中文描述它的内容、主体与场景。只输出描述本身。"),
        "video" => format!("这是一个视频文件（文件名：{name}）。请用一句中文描述其可能内容。只输出描述本身。"),
        "audio" => format!("这是一个音频文件（文件名：{name}）。请用一句中文说明它可能的内容类型。只输出描述本身。"),
        _ => format!("这是一个 {} 类型的文件（文件名：{name}）。请用一句中文根据文件名推断其内容。只输出描述本身。", kind),
    }
}

fn apply_ai_conf(cfg: &AIConf, override_conf: &Option<AIConf>) -> AIConf {
    override_conf.clone().unwrap_or_else(|| cfg.clone())
}

/// 对本地文件生成 AI 描述。ai 参数允许前端传入最新配置（无需先保存）。
#[tauri::command]
pub async fn ai_describe_local(
    app: AppHandle,
    root_id: String,
    path: String,
    ai: Option<AIConf>,
) -> Result<DescRecord, String> {
    let st = state(&app);
    let conf = apply_ai_conf(&st.config().ai, &ai);
    if conf.provider == "none" || conf.model.is_empty() {
        return Err("AI 未配置：请在设置中配置模型服务（OpenAI 兼容 / Ollama）".into());
    }
    let root = st.root_path(&root_id)?;
    let abs = resolve_in_root(&root, &path)?;
    let md = std::fs::metadata(&abs).map_err(|e| e.to_string())?;
    if md.is_dir() {
        return Err("目录暂不支持 AI 描述".into());
    }
    let kind = kind_of(&abs.to_string_lossy(), false);
    let name = abs.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut data: Vec<u8> = Vec::new();
    if kind == "image" && md.len() <= 20 << 20 {
        data = std::fs::read(&abs).map_err(|e| e.to_string())?;
    }
    let text = if conf.provider == "ollama" {
        ollama_chat(&conf, &prompt_for(&kind, &name), &data, kind == "image").await?
    } else {
        openai_chat(&conf, &prompt_for(&kind, &name), &data, kind == "image").await?
    };

    let now = Local::now().timestamp_millis();
    let mut descs = load_descs(&st);
    let rec = DescRecord {
        root_id: root_id.clone(),
        path: path.clone(),
        name,
        kind,
        text,
        model: format!("{}:{}", conf.provider, conf.model),
        created_at: now,
        updated_at: now,
        embedding: Vec::new(),
    };
    if let Some(old) = descs
        .iter_mut()
        .find(|d| d.root_id == root_id && d.path == path)
    {
        *old = rec.clone();
    } else {
        descs.push(rec.clone());
    }
    write_json(&st.ai_index(), &descs)?;
    Ok(rec)
}

async fn openai_chat(conf: &AIConf, prompt: &str, img: &[u8], with_img: bool) -> Result<String, String> {
    let base = if conf.base_url.is_empty() {
        "https://api.openai.com/v1".to_string()
    } else {
        conf.base_url.trim_end_matches('/').to_string()
    };
    let user_content = if with_img && !img.is_empty() {
        json!([
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(img))}}
        ])
    } else {
        json!(prompt)
    };
    let payload = json!({
        "model": conf.model,
        "messages": [
            {"role": "system", "content": "你是文件管理器中的智能归档助手，用简洁中文描述文件。"},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": 200,
    });
    let mut req = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{base}/chat/completions"))
        .json(&payload);
    if !conf.api_key.is_empty() {
        req = req.bearer_auth(&conf.api_key);
    }
    let resp = req.send().await.map_err(|e| format!("AI 请求失败: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("AI 服务错误 {status}: {body}"));
    }
    body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| format!("AI 响应格式异常: {body}"))
}

async fn ollama_chat(conf: &AIConf, prompt: &str, img: &[u8], with_img: bool) -> Result<String, String> {
    let base = if conf.base_url.is_empty() {
        "http://127.0.0.1:11434".to_string()
    } else {
        conf.base_url.trim_end_matches('/').to_string()
    };
    let mut msg = json!({"role": "user", "content": prompt});
    if with_img && !img.is_empty() {
        msg["images"] = json!([base64::engine::general_purpose::STANDARD.encode(img)]);
    }
    let payload = json!({"model": conf.model, "messages": [msg], "stream": false});
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{base}/api/chat"))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Ollama 请求失败（本地模型是否已启动？）: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Ollama 错误 {status}: {body}"));
    }
    body["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| format!("Ollama 响应格式异常: {body}"))
}

/// 已生成的描述列表（可按本地目录过滤）。
#[tauri::command]
pub async fn ai_list_local(app: AppHandle, root_id: Option<String>) -> Result<Vec<DescRecord>, String> {
    let st = state(&app);
    let mut descs = load_descs(&st);
    if let Some(r) = root_id {
        descs.retain(|d| d.root_id == r);
    }
    descs.sort_by_key(|d| -d.updated_at);
    Ok(descs)
}

/// 根据用户文字描述查找文件（本地库内关键词检索；接入 embedding 后升级语义检索）。
#[tauri::command]
pub async fn ai_search_local(app: AppHandle, query: String) -> Result<Vec<DescRecord>, String> {
    let st = state(&app);
    let lq = query.to_lowercase();
    let mut hits: Vec<DescRecord> = load_descs(&st)
        .into_iter()
        .filter(|d| d.text.to_lowercase().contains(&lq) || d.name.to_lowercase().contains(&lq))
        .collect();
    hits.sort_by_key(|d| -d.updated_at);
    hits.truncate(50);
    Ok(hits)
}
