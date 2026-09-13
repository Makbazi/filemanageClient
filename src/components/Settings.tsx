import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AIProvider, AppConfig, RootConf, ServerConf } from "../lib/types";
import { uid } from "../lib/types";
import { serverCall } from "../lib/api";
import { Modal } from "./Modals";
import { IconPlus, IconTrash } from "./icons";

interface Props {
  cfg: AppConfig;
  onSave(next: AppConfig): Promise<void>;
  onClose(): void;
  onLogin(serverId: string): void;
}

type Tab = "local" | "servers" | "ai" | "users";

interface UserInfo {
  id: number;
  username: string;
  role: string;
  allowedRoots?: string[];
}

export default function Settings(p: Props) {
  const [tab, setTab] = useState<Tab>("local");
  const [cfg, setCfg] = useState<AppConfig>({
    ...p.cfg,
    localRoots: [...p.cfg.localRoots],
    servers: [...p.cfg.servers],
    ai: { ...p.cfg.ai },
  });
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [usersErr, setUsersErr] = useState("");
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "user" });
  const [saving, setSaving] = useState(false);

  async function persist(next: AppConfig) {
    setCfg(next);
    setSaving(true);
    try {
      await p.onSave(next);
    } finally {
      setSaving(false);
    }
  }

  // ---------- 本地目录 ----------
  async function addLocalRoot() {
    const picked = await open({ directory: true, multiple: false, title: "选择要管理的本地目录" });
    if (!picked) return;
    const path = String(picked);
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    const root: RootConf = { id: uid(), name, path };
    await persist({ ...cfg, localRoots: [...cfg.localRoots, root] });
  }
  const removeLocalRoot = (id: string) =>
    persist({ ...cfg, localRoots: cfg.localRoots.filter((r) => r.id !== id) });

  // ---------- 服务端 ----------
  async function addServer() {
    const name = window.prompt("服务端名称（如：家中 NAS）");
    if (!name) return;
    const baseUrl = window.prompt("服务地址（如 http://192.168.1.10:8484）");
    if (!baseUrl) return;
    const s: ServerConf = { id: uid(), name, baseUrl, token: null, username: null };
    await persist({ ...cfg, servers: [...cfg.servers, s] });
  }
  const removeServer = (id: string) =>
    persist({ ...cfg, servers: cfg.servers.filter((s) => s.id !== id) });

  // ---------- 用户管理 ----------
  useEffect(() => {
    if (tab !== "users") return;
    setUsersErr("");
    serverCall("GET", "/api/v1/admin/users")
      .then((r) => setUsers((r as UserInfo[]) ?? []))
      .catch((e) => {
        setUsers(null);
        setUsersErr(String(e));
      });
  }, [tab]);

  async function createUser() {
    try {
      await serverCall("POST", "/api/v1/admin/users", newUser);
      setNewUser({ username: "", password: "", role: "user" });
      const r = await serverCall("GET", "/api/v1/admin/users");
      setUsers((r as UserInfo[]) ?? []);
    } catch (e) {
      setUsersErr(String(e));
    }
  }

  const aiSet = (patch: Partial<AppConfig["ai"]>) => setCfg({ ...cfg, ai: { ...cfg.ai, ...patch } });

  return (
    <Modal title="设置" onClose={p.onClose} width={640}>
      <div className="tabs">
        {(
          [
            ["local", "本地目录"],
            ["servers", "服务端"],
            ["ai", "AI 能力"],
            ["users", "用户管理"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "local" && (
        <div className="tab-body">
          <p className="dim tip">客户端可脱离服务端独立部署：配置一个本地目录即可管理其下文件。所有操作被限制在目录内。</p>
          {cfg.localRoots.map((r) => (
            <div className="list-row" key={r.id}>
              <div>
                <div className="list-name">{r.name}</div>
                <div className="dim path-cell">{r.path}</div>
              </div>
              <button className="mini danger" onClick={() => removeLocalRoot(r.id)}>
                <IconTrash size={14} />
              </button>
            </div>
          ))}
          <button className="btn" onClick={addLocalRoot}>
            <IconPlus size={15} /> 添加目录…
          </button>
        </div>
      )}

      {tab === "servers" && (
        <div className="tab-body">
          <p className="dim tip">可配置多个服务端并随时切换。服务端默认只允许局域网访问；连接需登录认证。</p>
          {cfg.servers.map((s) => (
            <div className="list-row" key={s.id}>
              <div>
                <div className="list-name">
                  {s.name} {s.token ? <span className="badge ok">已登录 {s.username}</span> : <span className="badge">未登录</span>}
                </div>
                <div className="dim path-cell">{s.baseUrl}</div>
              </div>
              <div className="row-actions">
                {!s.token && (
                  <button className="btn small" onClick={() => p.onLogin(s.id)}>
                    登录
                  </button>
                )}
                <button className="mini danger" onClick={() => removeServer(s.id)}>
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
          ))}
          <button className="btn" onClick={addServer}>
            <IconPlus size={15} /> 添加服务端…
          </button>
        </div>
      )}

      {tab === "ai" && (
        <div className="tab-body">
          <p className="dim tip">
            AI 能力为预留接口：支持 OpenAI 兼容协议（任意云厂商 / 本地网关）与本地 Ollama。描述结果将存入
            {cfg.servers.length ? "（本地模式存本机文件库；服务端模式存服务端元数据库，经 filemanageDb 交互）" : "元数据库"}，用于按文字描述检索。
          </p>
          <div className="field">
            <label>Provider</label>
            <select value={cfg.ai.provider} onChange={(e) => aiSet({ provider: e.target.value as AIProvider })}>
              <option value="none">未启用</option>
              <option value="openai">OpenAI 兼容（云厂商 / vLLM / one-api…）</option>
              <option value="ollama">Ollama（本地部署）</option>
            </select>
          </div>
          {cfg.ai.provider !== "none" && (
            <>
              <div className="field">
                <label>Base URL</label>
                <input
                  placeholder={cfg.ai.provider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1"}
                  value={cfg.ai.baseUrl}
                  onChange={(e) => aiSet({ baseUrl: e.target.value })}
                />
              </div>
              <div className="field">
                <label>API Key（Ollama 可留空）</label>
                <input type="password" value={cfg.ai.apiKey} onChange={(e) => aiSet({ apiKey: e.target.value })} />
              </div>
              <div className="field">
                <label>模型（需支持视觉时填 vision 模型）</label>
                <input
                  placeholder="gpt-4o-mini / qwen2.5-vl / llama3.2-vision…"
                  value={cfg.ai.model}
                  onChange={(e) => aiSet({ model: e.target.value })}
                />
              </div>
            </>
          )}
          <button className="btn primary" onClick={() => persist(cfg)} disabled={saving}>
            保存 AI 配置
          </button>
        </div>
      )}

      {tab === "users" && (
        <div className="tab-body">
          <p className="dim tip">区分用户：服务端为每个用户维护独立的元数据、回收站与 AI 描述。需要管理员权限。</p>
          {usersErr && <div className="error-bar">{usersErr}</div>}
          {users && (
            <table className="table compact">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>用户名</th>
                  <th>角色</th>
                  <th>可访问根目录</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.id}</td>
                    <td>{u.username}</td>
                    <td>{u.role === "admin" ? "管理员" : "普通用户"}</td>
                    <td className="dim">{u.allowedRoots?.length ? u.allowedRoots.join(", ") : "全部"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="inline-form">
            <input placeholder="用户名" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} />
            <input placeholder="密码(≥6)" type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
            <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
            <button className="btn small" disabled={!newUser.username || newUser.password.length < 6} onClick={createUser}>
              创建
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
