import { useCallback, useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import type { ActiveConf, AppConfig, FsEntry, SearchHit, ServerRoot, TrashItem } from "./lib/types";
import * as api from "./lib/api";
import { AuthError } from "./lib/api";
import { joinPath, parentOf } from "./lib/format";
import Sidebar, { type View } from "./components/Sidebar";
import FileView from "./components/FileView";
import TrashView from "./components/TrashView";
import AIView from "./components/AIView";
import Settings from "./components/Settings";
import { Confirm, Modal, Prompt } from "./components/Modals";
import { IconLogout, IconSearch } from "./components/icons";

function b64ToText(dataUrl: string): string {
  const b = atob(dataUrl.split(",")[1] ?? "");
  const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

type Dialog =
  | { kind: "none" }
  | { kind: "confirm"; danger: boolean; title: string; lines: string[]; typed?: string; onOk(): void }
  | { kind: "prompt"; title: string; label: string; initial: string; onOk(v: string): void }
  | { kind: "login"; serverId: string }
  | { kind: "settings" }
  | { kind: "preview"; title: string; dataUrl: string };

interface PromptLoginProps {
  serverId: string;
  cfg: AppConfig;
  onDone(): void;
  onClose(): void;
}

function LoginModal(p: PromptLoginProps) {
  const srv = p.cfg.servers.find((s) => s.id === p.serverId);
  const [username, setUsername] = useState(srv?.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.serverLogin(p.serverId, username, password);
      p.onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`登录 · ${srv?.name ?? "服务端"}`} onClose={p.onClose} width={400}>
      <div className="field">
        <label>用户名</label>
        <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="field">
        <label>密码</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      </div>
      {err && <div className="error-bar">{err}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={p.onClose}>
          取消
        </button>
        <button className="btn primary" disabled={busy || !username} onClick={submit}>
          {busy ? "登录中…" : "登录"}
        </button>
      </div>
    </Modal>
  );
}

export default function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [view, setView] = useState<View>("files");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [roots, setRoots] = useState<ServerRoot[]>([]);
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [toast, setToast] = useState("");

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 3500);
  }, []);

  const refresh = useCallback(async () => {
    const a = api.active();
    if (!a.rootId) {
      setEntries([]);
      setError("请先在设置中添加本地目录，或添加并登录服务端");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setEntries(await api.listFiles(path));
    } catch (e) {
      if (e instanceof AuthError) {
        if (a.kind === "server" && a.serverId) setDialog({ kind: "login", serverId: a.serverId });
        setError("需要登录服务端");
      } else {
        setError(String(e));
      }
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [path]);

  const refreshTrash = useCallback(async () => {
    const a = api.active();
    setLoading(true);
    setError("");
    try {
      setTrash(await api.listTrash());
    } catch (e) {
      if (e instanceof AuthError && a.kind === "server" && a.serverId) {
        setDialog({ kind: "login", serverId: a.serverId });
        setError("需要登录服务端");
      } else setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .loadConfig()
      .then((c) => {
        setCfg({ ...c });
        return refresh();
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view === "files") refresh();
    if (view === "trash") refreshTrash();
  }, [view, path, cfg?.active, refresh, refreshTrash]);

  const setActive = async (a: ActiveConf) => {
    const c = api.getConfig();
    const next = { ...c, active: a };
    await api.saveConfig(next);
    setCfg({ ...next });
    setPath("");
  };

  async function pickLocalRoot(id: string) {
    setView("files");
    await setActive({ kind: "local", rootId: id });
  }

  async function pickServer(id: string) {
    const c = api.getConfig();
    const s = c.servers.find((x) => x.id === id);
    if (!s) return;
    if (!s.token) {
      setDialog({ kind: "login", serverId: id });
      return;
    }
    try {
      const rs = await api.fetchRoots(id);
      setRoots(rs ?? []);
      setView("files");
      await setActive({ kind: "server", serverId: id, rootId: rs?.[0]?.id ?? "" });
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith("AUTH_REQUIRED")) setDialog({ kind: "login", serverId: id });
      else notify("连接服务端失败: " + msg);
    }
  }

  const rootName = () => {
    const a = api.active();
    if (a.kind === "local") return cfg?.localRoots.find((r) => r.id === a.rootId)?.name ?? "本地";
    const s = cfg?.servers.find((x) => x.id === a.serverId);
    const r = roots.find((x) => x.id === a.rootId);
    return s ? `${s.name} · ${r?.name ?? a.rootId}` : "服务端";
  };

  // ---------- 操作 ----------

  function openEntry(e: FsEntry) {
    if (e.isDir) {
      setPath(e.path);
      return;
    }
    const a = api.active();
    if (a.kind === "local") {
      invoke<string>("fs_preview", { rootId: a.rootId, path: e.path })
        .then((url) => setDialog({ kind: "preview", title: e.name, dataUrl: url }))
        .catch((err) => notify("预览: " + String(err)));
    } else {
      notify("服务端文件请先「下载」到本机后预览");
    }
  }

  /** 删除：二次确认对话框（req: 删除时需要二次确认）。 */
  function askDelete(items: FsEntry[]) {
    if (!items.length) return;
    setDialog({
      kind: "confirm",
      danger: true,
      title: `确认删除 ${items.length} 项？`,
      lines: items.map((i) => i.name).slice(0, 8),
      typed: items.length > 5 ? "删除" : undefined,
      onOk: async () => {
        setDialog({ kind: "none" });
        try {
          const n = await api.deletePaths(items.map((i) => i.path));
          notify(`已删除 ${n} 项，可在回收站还原`);
          refresh();
        } catch (e) {
          setError(String(e));
        }
      },
    });
  }

  async function describe(e: FsEntry) {
    try {
      notify("AI 正在生成描述…");
      const r = await api.aiDescribe(e.path);
      notify(`✨ ${e.name}: ${(r as { text: string }).text}`);
    } catch (err) {
      notify("AI: " + String(err));
    }
  }

  async function upload() {
    const a = api.active();
    const picked = await openDialog({ multiple: false, title: "选择要上传的文件" });
    if (!picked) return;
    const local = String(picked);
    try {
      if (a.kind === "server") {
        await api.uploadLocalToServer(path || "/", local);
      } else {
        await api.importToLocal(path, local);
      }
      notify("上传完成");
      refresh();
    } catch (e) {
      notify("上传失败: " + String(e));
    }
  }

  async function download(items: FsEntry[]) {
    for (const it of items) {
      if (it.isDir) {
        notify("目录下载暂不支持，请进入目录选择文件");
        continue;
      }
      const dest = await saveDialog({ defaultPath: it.name, title: `下载 ${it.name}` });
      if (!dest) continue;
      try {
        await api.downloadToLocal(String(dest), it.path);
        notify("已下载到: " + dest);
      } catch (e) {
        setError(String(e));
      }
    }
  }

  function rename(e: FsEntry) {
    setDialog({
      kind: "prompt",
      title: "重命名",
      label: "新名称",
      initial: e.name,
      onOk: async (v) => {
        setDialog({ kind: "none" });
        try {
          await api.rename(e.path, v);
          refresh();
        } catch (err) {
          setError(String(err));
        }
      },
    });
  }

  function copyMove(items: FsEntry[], mode: "copy" | "move") {
    setDialog({
      kind: "prompt",
      title: mode === "copy" ? "复制到目录" : "移动到目录",
      label: "目标目录（相对根目录，留空为根）",
      initial: path,
      onOk: async (v) => {
        setDialog({ kind: "none" });
        try {
          const dest = v.trim().replace(/\/+$/, "");
          if (mode === "copy") await api.copyPaths(items.map((i) => i.path), dest);
          else await api.movePaths(items.map((i) => i.path), dest);
          refresh();
        } catch (e) {
          setError(String(e));
        }
      },
    });
  }

  function jumpTo(hit: SearchHit) {
    setDialog({ kind: "none" });
    const a = api.active();
    const c = api.getConfig();
    const next = { ...c, active: { ...a, rootId: hit.rootId } as ActiveConf };
    api.saveConfig(next).then(() => {
      setCfg({ ...next });
      setView("files");
      setPath(parentOf(hit.path));
      notify(`已定位到 ${hit.path}`);
    });
  }

  // ---------- 渲染 ----------

  if (!cfg) {
    return (
      <div className="app loading-root">
        <div className="spinner" />
      </div>
    );
  }

  const showConfirm = dialog.kind === "confirm" ? dialog : null;

  return (
    <div className="app">
      <Sidebar
        cfg={cfg}
        view={view}
        roots={api.active().kind === "server" ? roots : cfg.localRoots}
        onView={setView}
        onPickLocalRoot={pickLocalRoot}
        onPickServer={pickServer}
        onPickRoot={async (id) => {
          const a = api.active();
          await setActive({ ...a, rootId: id });
        }}
        onOpenSettings={() => setDialog({ kind: "settings" })}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            {view === "files" && "文件"}
            {view === "trash" && "回收站"}
            {view === "ai" && "AI 助手"}
            {view === "search" && "搜索"}
          </div>
          <div className="topbar-right">
            {api.active().kind === "server" && api.active().serverId && (
              <button
                className="btn small ghost"
                onClick={async () => {
                  await api.serverLogout(api.active().serverId!);
                  setRoots([]);
                  notify("已退出登录");
                }}
              >
                <IconLogout size={14} /> 退出登录
              </button>
            )}
          </div>
        </header>

        {view === "files" && (
          <FileView
            path={path}
            rootName={rootName()}
            entries={entries}
            loading={loading}
            error={error}
            isServer={api.active().kind === "server"}
            aiReady={cfg.ai.provider !== "none"}
            onOpen={openEntry}
            onBreadcrumb={setPath}
            onRefresh={refresh}
            onMkdir={() =>
              setDialog({
                kind: "prompt",
                title: "新建文件夹",
                label: "名称",
                initial: "",
                onOk: async (v) => {
                  setDialog({ kind: "none" });
                  try {
                    await api.makeDir(joinPath(path, v));
                    refresh();
                  } catch (e) {
                    setError(String(e));
                  }
                },
              })
            }
            onUpload={upload}
            onDownload={(items) => download(items)}
            onRename={rename}
            onCopyMove={copyMove}
            onDelete={askDelete}
            onDescribe={describe}
          />
        )}

        {view === "trash" && (
          <TrashView
            items={trash}
            loading={loading}
            error={error}
            onRefresh={refreshTrash}
            onRestore={async (t) => {
              try {
                await api.restoreTrash(t.trashId);
                notify(`已还原 ${t.name}`);
                refreshTrash();
              } catch (e) {
                setError(String(e));
              }
            }}
            onRemove={(t) =>
              setDialog({
                kind: "confirm",
                danger: true,
                title: `彻底删除「${t.name}」？`,
                lines: ["此操作不可恢复。"],
                typed: "删除",
                onOk: async () => {
                  setDialog({ kind: "none" });
                  try {
                    await api.removeTrash(t.trashId);
                    refreshTrash();
                  } catch (e) {
                    setError(String(e));
                  }
                },
              })
            }
            onClear={() =>
              setDialog({
                kind: "confirm",
                danger: true,
                title: "清空回收站？",
                lines: ["所有条目将被彻底删除，不可恢复。"],
                typed: "清空",
                onOk: async () => {
                  setDialog({ kind: "none" });
                  try {
                    await api.clearTrash();
                    notify("回收站已清空");
                    refreshTrash();
                  } catch (e) {
                    setError(String(e));
                  }
                },
              })
            }
          />
        )}

        {view === "ai" && (
          <AIView cfg={cfg} onOpenSettings={() => setDialog({ kind: "settings" })} onJump={jumpTo} />
        )}

        {view === "search" && <SearchView onOpen={openEntry} />}
      </main>

      {showConfirm && (
        <Confirm
          title={showConfirm.title}
          lines={showConfirm.lines}
          danger={showConfirm.danger}
          typedConfirm={showConfirm.typed}
          onOk={showConfirm.onOk}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "prompt" && (
        <Prompt
          title={dialog.title}
          label={dialog.label}
          initial={dialog.initial}
          onOk={dialog.onOk}
          onCancel={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "login" && (
        <LoginModal
          serverId={dialog.serverId}
          cfg={cfg}
          onClose={() => setDialog({ kind: "none" })}
          onDone={async () => {
            await api.loadConfig();
            setCfg({ ...api.getConfig() });
            const rs = await api.fetchRoots(dialog.serverId).catch(() => [] as ServerRoot[]);
            setRoots(rs);
            setDialog({ kind: "none" });
            await setActive({ kind: "server", serverId: dialog.serverId, rootId: rs?.[0]?.id ?? "" });
          }}
        />
      )}
      {dialog.kind === "settings" && (
        <Settings
          cfg={cfg}
          onClose={() => setDialog({ kind: "none" })}
          onSave={async (next) => {
            await api.saveConfig(next);
            setCfg({ ...next });
            await refresh();
          }}
          onLogin={(id) => setDialog({ kind: "login", serverId: id })}
        />
      )}
      {dialog.kind === "preview" && (
        <Modal title={dialog.title} onClose={() => setDialog({ kind: "none" })} width={720}>
          <div className="preview-box">
            {dialog.dataUrl.startsWith("data:image") ? (
              <img src={dialog.dataUrl} alt={dialog.title} />
            ) : dialog.dataUrl.startsWith("data:text") ? (
              <pre className="preview-text">{b64ToText(dialog.dataUrl)}</pre>
            ) : (
              <div className="dim">该类型文件不支持预览（图像/文本可预览）。</div>
            )}
          </div>
        </Modal>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// 独立的文件名搜索页
function SearchView(p: { onOpen(e: FsEntry): void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<FsEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setRes(await api.searchNames(q.trim()));
    } catch (e) {
      setRes([]);
      console.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <div className="search-hero card">
        <div className="search-row">
          <IconSearch size={16} />
          <input
            className="search-input"
            placeholder="按文件名搜索（当前来源目录内递归查找）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          <button className="btn primary" onClick={run} disabled={busy || !q.trim()}>
            {busy ? "搜索中…" : "搜索"}
          </button>
        </div>
        {res && (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>路径</th>
              </tr>
            </thead>
            <tbody>
              {res.map((e) => (
                <tr key={e.path} className="row" onDoubleClick={() => p.onOpen(e)}>
                  <td className="cell-name">{e.name}</td>
                  <td className="dim path-cell">{e.path}</td>
                </tr>
              ))}
              {res.length === 0 && (
                <tr>
                  <td colSpan={2} className="empty">
                    未找到匹配文件
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
