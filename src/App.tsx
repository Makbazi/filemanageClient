// App 根组件：全局状态编排（来源切换/刷新/对话框调度/传输/位置恢复/主题/登录态事件同步）。
import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import "./styles/base.css";
import "./styles/themes.css";
import type { ActiveConf, AppConfig, FsEntry, SearchHit, ServerRoot, TrashItem } from "./lib/types";
import { uid } from "./lib/types";
import * as api from "./lib/api";
import { AuthError } from "./lib/api";
import { initTransfers, enqueue, subscribe, enqueueGroup } from "./lib/transfer";
import { walkLocalDir, type WalkResult } from "./lib/local";
import { serverMkdirs } from "./lib/server";
import { applyTheme } from "./lib/theme";
import { joinPath, parentOf } from "./lib/format";
import { viewableType } from "./lib/preview";
import Sidebar, { type View } from "./components/Sidebar";
import Topbar from "./components/Topbar";
import FileView from "./components/FileView";
import TrashView from "./components/TrashView";
import TransfersView from "./components/TransfersView";
import AIView from "./components/AIView";
import SearchView from "./components/SearchView";
import Settings from "./components/Settings";
import PreviewModal from "./components/PreviewModal";
import FileViewer from "./components/FileViewer";
import ShareDialog from "./components/ShareDialog";
import AclDialog from "./components/AclDialog";
import VersionsDialog from "./components/VersionsDialog";
import TransferPanel from "./components/TransferPanel";
import ContextMenu, { type CtxItem } from "./components/ContextMenu";
import UploadToDialog from "./components/UploadToDialog";
import { IconEye, IconUpload, IconExpand } from "./components/icons";
import { Confirm, Modal, Prompt } from "./components/Modals";

type Dialog =
  | { kind: "none" }
  | { kind: "confirm"; danger: boolean; title: string; lines: string[]; typed?: string; onOk(): void; onCancel?(): void }
  | { kind: "prompt"; title: string; label: string; initial: string; onOk(v: string): void }
  | { kind: "login"; serverId: string; from?: "settings" }
  | { kind: "uploadTo"; entry: FsEntry }
  // 0.1.4（需求2）：设置不再是对话框，并入视图体系（view === "settings"，主区整页视图）
  | { kind: "preview"; entry: FsEntry }
  | { kind: "share"; target: { path: string; isDir: boolean } }
  | { kind: "acl"; path: string }
  | { kind: "versions"; entry: FsEntry };

interface PromptLoginProps {
  serverId: string;
  cfg: AppConfig;
  onDone(): void;
  onClose(): void;
}

/**
 * 登录框（0.6.0 需求3）：可按"服务端+账户"维度记住密码（本体存系统凭证库）；
 * 已记住的账户出现在下拉中，选中自动回填密码；取消勾选记住=清除该账户凭证。
 * 需求11/12：管理员身份由服务端在用户端口拒绝登录（403），错误原文显示于此。
 */
function LoginModal(p: PromptLoginProps) {
  const srv = p.cfg.servers.find((s) => s.id === p.serverId);
  const creds = p.cfg.credentials.filter((c) => c.serverId === p.serverId);
  const initUser = srv?.username ?? creds[0]?.username ?? "";
  const [username, setUsername] = useState(initUser);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() => !!initUser && creds.some((c) => c.username === initUser));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 选中已记住账户 → 从凭证库回填密码
  useEffect(() => {
    if (!username || !creds.some((c) => c.username === username)) return;
    let cancelled = false;
    api
      .credTake(p.serverId, username)
      .then((pw) => {
        if (!cancelled && pw) setPassword(pw);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, p.serverId]);
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.serverLogin(p.serverId, username, password, remember);
      p.onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`登录 · ${srv?.name ?? "服务端"}`} onClose={p.onClose} width={400}>
      {creds.length > 0 && (
        <div className="field">
          <label>已记住的账户</label>
          <select
            value={creds.some((c) => c.username === username) ? username : ""}
            onChange={(e) => {
              if (!e.target.value) return;
              setUsername(e.target.value);
              setRemember(true);
            }}
          >
            <option value="">（其他账户 / 手动输入）</option>
            {creds.map((c) => (
              <option key={c.username} value={c.username}>
                {c.username}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label>用户名</label>
        <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="field">
        <label>密码</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      <label className="check-item">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        记住密码（存系统凭证库，按服务端+账户隔离，供下次快速登录）
      </label>
      <div className="dim tip">登录后会话最长保留 3 周（活跃自动续期）。管理员账户只能在服务端管理台登录。</div>
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
  // 0.1.7：查看覆盖层（双击可预览类型→主区就地显示；非 Dialog，弹窗仍可在其上叠加）
  const [viewing, setViewing] = useState<FsEntry | null>(null);
  // 本地文件右键菜单（需求7）
  const [ctx, setCtx] = useState<{ entry: FsEntry; x: number; y: number } | null>(null);
  const [toast, setToast] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [groupByKind, setGroupByKind] = useState(false);
  // 左侧导航折叠态（0.4.0，总结4：默认折叠为小箭头标签）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const restored = useRef(false);
  // 已自动弹过登录框的服务端 id：后台加载遇 401 只对同一服务端弹一次，
  // 用户取消后不再反复弹出（显式操作/登录成功/登出时重置）。
  const loginPrompted = useRef("");
  // 0.1.4（需求2）：设置为左侧导航保持可见的主区整页视图；侧栏"用户"与登录回跳
  // 直达账户页签（以 key 侧重挂 Settings 使 initialTab 生效）。
  const [settingsTab, setSettingsTab] = useState<"account" | null>(null);
  const openSettings = (tab?: "account") => {
    setSettingsTab(tab ?? null);
    setView("settings");
  };

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 3500);
  }, []);

  const src = cfg ? api.source() : null;
  const activeConf = cfg ? api.active() : null;
  const activeKey = activeConf?.kind === "server" ? activeConf.serverId ?? "" : "local";
  const activeServer = cfg?.servers.find((s) => s.id === (activeConf?.serverId ?? "")) ?? null;
  // 激活来源的稳定字符串签名：saveConfig 后 cfg?.active 引用会变，effect 依赖
  // 若用对象引用会形成"持久化→刷新→再持久化"的死循环（导致登录框反复弹出）。
  const activeSig = `${activeConf?.kind ?? ""}|${activeConf?.serverId ?? ""}|${activeConf?.rootId ?? ""}`;

  /** 后台加载遇 401：显示错误条；每个服务端只自动弹一次登录框。 */
  const handleAuthFail = useCallback((a: ActiveConf) => {
    setError("需要登录服务端");
    const sid = a.kind === "server" ? a.serverId ?? "" : "";
    if (sid && loginPrompted.current !== sid) {
      loginPrompted.current = sid;
      setDialog({ kind: "login", serverId: sid });
    }
  }, []);

  // ---------- 数据加载 ----------

  const refresh = useCallback(async () => {
    const a = api.active();
    if (!a.rootId) {
      setEntries([]);
      setError("请先在设置中添加本地目录，或添加服务端");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setEntries(await api.source().list(path));
    } catch (e) {
      if (e instanceof AuthError) handleAuthFail(a);
      else setError(String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [path, handleAuthFail]);

  const refreshTrash = useCallback(async () => {
    const a = api.active();
    setLoading(true);
    setError("");
    try {
      setTrash(await api.source().listTrash());
    } catch (e) {
      if (e instanceof AuthError) handleAuthFail(a);
      else setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [handleAuthFail]);

  // 入队传输的完成回调可能跨多次渲染，用 ref 拿最新 refresh（避免闭包锁死旧 path）
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  /** 盯一个入队任务直到终态：完成→提示+刷新；失败→提示（重试在传输面板）；取消→静默。 */
  const watchTransfer = useCallback(
    (id: string, label: string) => {
      const unsub = subscribe((list) => {
        const t = list.find((x) => x.id === id);
        if (!t) {
          unsub(); // 已被"清除已完成"移除
          return;
        }
        if (t.status === "done") {
          unsub();
          notify(`${label}完成：${t.name}`);
          void refreshRef.current();
        } else if (t.status === "error") {
          unsub();
          notify(`${label}失败：${t.message || "未知错误"}（可在传输面板处理）`);
        } else if (t.status === "cancelled") {
          unsub();
        }
      });
    },
    [notify]
  );

  /** 需求41：盯一个目录上传组行到终态——整组结束才一次汇总通知 + 刷新。 */
  const watchGroup = useCallback(
    (gid: string, label: string) => {
      const unsub = subscribe((list) => {
        const t = list.find((x) => x.id === gid);
        if (!t) {
          unsub();
          return;
        }
        if (t.status === "done") {
          unsub();
          notify(`目录上传完成：${label}（${t.files}/${t.filesTotal} 个文件）`);
          void refreshRef.current();
        } else if (t.status === "error") {
          unsub();
          notify(`目录上传结束但有失败：${t.message}（可在传输面板处理）`);
        } else if (t.status === "cancelled") {
          unsub();
        }
      });
    },
    [notify]
  );

  // 启动：加载配置 → 应用主题 → 恢复上次位置（需求21）→ 初始化传输监听
  useEffect(() => {
    initTransfers();
    api
      .loadConfig()
      .then(async (c) => {
        applyTheme(c.ui.theme);
        setViewMode(c.ui.viewMode === "grid" ? "grid" : "list");
        setGroupByKind(c.ui.groupByKind);
        setSidebarCollapsed(c.ui.sidebarCollapsed !== false);
        if (c.ui.restoreLastLocation && c.ui.lastLocation?.active) {
          const ll = c.ui.lastLocation;
          const next = { ...c, active: ll.active };
          await api.saveConfig(next);
          setCfg({ ...next });
          setView((ll.view as View) || "files");
          setPath(ll.path || "");
          if (ll.viewMode === "grid" || ll.viewMode === "list") setViewMode(ll.viewMode);
          if (ll.active?.kind === "server" && ll.active.serverId) {
            const rs = await api.fetchRoots(ll.active.serverId).catch(() => [] as ServerRoot[]);
            setRoots(rs);
          }
        } else {
          setCfg({ ...c });
        }
        restored.current = true;
      })
      .catch((e) => setError(String(e)));
  }, []);

  // 需求8/1：Rust 侧登录/登出/令牌轮换/凭证变更广播 fm-config-changed——
  // 前端同步配置单例 + React 状态 + 当前服务端 roots；左侧 badge 与右侧
  // 内容由此共用同一时刻快照（保存链已由 save_config 令牌合并保证不会反向覆盖）。
  useEffect(() => {
    let cancelled = false;
    const un = listen("fm-config-changed", async () => {
      const c = await api.loadConfig().catch(() => null);
      if (!c || cancelled) return;
      api.invalidateSource();
      setCfg({ ...c });
      const a = api.active();
      if (a.kind === "server" && a.serverId) {
        const rs = await api.fetchRoots(a.serverId).catch(() => [] as ServerRoot[]);
        if (!cancelled) setRoots(rs ?? []);
      }
    });
    return () => {
      cancelled = true;
      void un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    if (view === "files") refresh();
    if (view === "trash") refreshTrash();
  }, [view, path, activeSig, refresh, refreshTrash]);

  // 记录当前位置（防抖持久化，需求21）
  useEffect(() => {
    if (!cfg || !restored.current) return;
    // 设置视图不记录位置：lastLocation 保持进入设置前的业务视图，避免下次启动恢复到设置页
    if (view === "settings") return;
    const t = window.setTimeout(async () => {
      const c = api.getConfig();
      const next: AppConfig = {
        ...c,
        ui: {
          ...c.ui,
          lastLocation: { active: c.active ?? null, view, path, viewMode },
        },
      };
      const saved = await api.saveConfig(next).catch(() => null);
      if (saved) setCfg({ ...saved });
    }, 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, path, viewMode, activeSig]);

  // 0.1.7：切换视图/目录/来源时收起查看覆盖层（依赖均为稳定字符串，见上 activeSig 注）
  useEffect(() => {
    setViewing(null);
  }, [view, path, activeSig]);

  const setActive = async (a: ActiveConf) => {
    const c = api.getConfig();
    const next = { ...c, active: a };
    const saved = await api.saveConfig(next);
    api.invalidateSource();
    setCfg({ ...saved });
    setPath("");
  };

  // ---------- 来源切换（需求10：主界面快速切换） ----------

  async function pickLocalRoot(id: string) {
    setView("files");
    await setActive({ kind: "local", rootId: id });
  }

  function switchLocal() {
    const c = api.getConfig();
    if (!c.localRoots.length) {
      openSettings();
      return;
    }
    const last =
      c.ui.lastLocation?.active?.kind === "local" &&
      c.localRoots.some((r) => r.id === c.ui.lastLocation?.active?.rootId)
        ? c.ui.lastLocation.active.rootId
        : c.localRoots[0].id;
    void pickLocalRoot(last);
  }

  /** 切换服务端：未登录也允许（游客只读浏览，需求6）。 */
  async function pickServer(id: string) {
    const c = api.getConfig();
    const s = c.servers.find((x) => x.id === id);
    if (!s) return;
    try {
      const rs = await api.fetchRoots(id);
      setRoots(rs ?? []);
      setView("files");
      const keepRoot = api.active().kind === "server" && api.active().serverId === id ? api.active().rootId : "";
      await setActive({ kind: "server", serverId: id, rootId: keepRoot || rs?.[0]?.id || "" });
      // 需求10：记住"选中的远程"，本地模式下快速切换第二按钮指向它
      const c2 = api.getConfig();
      void api
        .saveConfig({ ...c2, ui: { ...c2.ui, lastServerId: id } })
        .then((saved) => setCfg({ ...saved }))
        .catch(() => undefined);
    } catch (e) {
      if (e instanceof AuthError) {
        // 服务端未开放匿名浏览 → 显式切换动作，弹一次登录框并标记（后台失败不再重复弹）
        loginPrompted.current = id;
        setDialog({ kind: "login", serverId: id });
      } else {
        notify("连接服务端失败: " + String(e));
      }
    }
  }

  const rootName = () => {
    const a = api.active();
    if (a.kind === "local") return cfg?.localRoots.find((r) => r.id === a.rootId)?.name ?? "本地";
    const s = cfg?.servers.find((x) => x.id === a.serverId);
    const r = roots.find((x) => x.id === a.rootId);
    return s ? `${s.name} · ${r?.name ?? a.rootId}` : "服务端";
  };

  // ---------- 文件操作 ----------

  /** 双击入口（0.1.7 区分查看/预览）：目录→进入；可预览类型→主区"查看"覆盖层
   * （无大小限制，大图片可看）；其余→预览弹窗（提示下载，同旧行为）。 */
  function openEntry(e: FsEntry) {
    if (e.isDir) {
      setPath(e.path);
      return;
    }
    if (viewableType(e)) {
      setViewing(e);
      return;
    }
    previewEntry(e);
  }

  /** 预览按钮/右键"预览"：缩放式弹窗（"预览是缩略图"语义） */
  function previewEntry(e: FsEntry) {
    setDialog({ kind: "preview", entry: e });
  }

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
          const n = await api.source().remove(items.map((i) => i.path));
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

  /**
   * 上传/导入（需求3 覆盖冲突保护）。服务端模式 0.6.0 起入队执行：
   * 传输面板可暂停→断点续传、失败重试；覆盖任务的 BaseHash 由任务执行时
   * 重新 stat 取得（并发状态最新）。本地模式保持即时导入。
   */
  async function upload() {
    const source = api.source();
    if (source.anonymous) {
      notify("游客模式不可上传，请先登录");
      setDialog({ kind: "login", serverId: api.active().serverId ?? "" });
      return;
    }
    const picked = await openDialog({ multiple: false, title: "选择要上传的文件" });
    if (!picked) return;
    const local = String(picked);
    const name = local.split(/[\\/]/).pop() ?? "file";
    const transferId = uid();

    const a = api.active();
    if (source.kind === "server" && a.serverId) {
      // 目标已存在 → 二次确认；确认覆盖后由 run() 执行时取哈希做乐观并发锁
      let overwrite = false;
      try {
        await source.stat(joinPath(path, name));
        overwrite = await askConfirmAsync(
          `「${name}」已存在，覆盖上传？`,
          ["服务端会先保存旧内容为历史版本，可回滚。"]
        );
        if (!overwrite) return;
      } catch {
        /* 目标不存在：断言新文件（期间被他人创建则报冲突） */
      }
      enqueue({
        id: transferId,
        kind: "upload",
        serverId: a.serverId,
        rootId: a.rootId,
        name,
        remotePath: joinPath(path, name),
        localPath: local,
        ...(overwrite ? { overwrite: true } : { baseHash: "-" }),
      });
      notify(`已加入上传队列：${name}`);
      watchTransfer(transferId, "上传");
      return;
    }

    // 本地模式：即时导入（LocalSource 内部 reportLocal 记录进度）
    try {
      try {
        await source.stat(joinPath(path, name));
        const ok = await askConfirmAsync(`「${name}」已存在，覆盖导入？`, ["旧内容将保存为历史版本。"]);
        if (!ok) return;
      } catch {
        /* 新文件 */
      }
      await source.uploadFile(local, path, transferId);
      notify("上传完成");
      refresh();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("conflict")) notify("上传冲突：目标文件已被其他客户端修改，请刷新后重试");
      else if (!msg.includes("取消")) notify("上传失败: " + msg);
    }
  }

  /** Promise 化的确认框（确认 true / 取消 false）。 */
  function askConfirmAsync(title: string, lines: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      setDialog({
        kind: "confirm",
        danger: false,
        title,
        lines,
        onOk: () => {
          setDialog({ kind: "none" });
          resolve(true);
        },
        onCancel: () => {
          setDialog({ kind: "none" });
          resolve(false);
        },
      });
    });
  }

  async function download(items: FsEntry[]) {
    const source = api.source();
    if (source.anonymous) {
      notify("游客模式不可下载，请先登录");
      return;
    }
    const a = api.active();
    for (const it of items) {
      if (it.isDir) {
        notify("目录下载暂不支持，请进入目录选择文件");
        continue;
      }
      const dest = await saveDialog({ defaultPath: it.name, title: `下载 ${it.name}` });
      if (!dest) continue;
      // 服务端模式：入队执行（.part 断点，暂停→继续、失败→重试在传输面板，需求4/5）
      if (source.kind === "server" && a.serverId) {
        const transferId = uid();
        enqueue({
          id: transferId,
          kind: "download",
          serverId: a.serverId,
          rootId: a.rootId,
          name: it.name,
          remotePath: it.path,
          localPath: String(dest),
        });
        notify(`已加入下载队列：${it.name}`);
        watchTransfer(transferId, "下载");
        continue;
      }
      try {
        await source.downloadFile(String(dest), it.path, uid());
        notify("已下载到: " + dest);
      } catch (e) {
        const msg = String(e);
        if (!msg.includes("取消")) setError(msg);
      }
    }
  }

  /** 需求7：本地文件右键上传 → 每个选中的服务端生成一个入队任务（传输界面统一管理）。 */
  function uploadToServers(entry: FsEntry, targets: { serverId: string; rootId: string }[]) {
    setDialog({ kind: "none" });
    let abs = "";
    try {
      abs = api.joinLocalAbs(entry.path);
    } catch (e) {
      notify(String(e));
      return;
    }
    for (const t of targets) {
      const id = uid();
      enqueue({
        id,
        kind: "upload",
        serverId: t.serverId,
        rootId: t.rootId,
        name: entry.name,
        remotePath: entry.name, // 传到该远程根目录；冲突可在传输面板"覆盖重试"
        localPath: abs,
        baseHash: "-",
      });
      watchTransfer(id, "上传");
    }
    notify(`已加入上传队列：${entry.name} → ${targets.length} 个服务端（见"传输"界面）`);
  }

  /** 需求41：右键本地目录 → 整树上传。fs_walk 枚举 → mkdirs 批量建目录骨架（含空目录，
   *  旧服务端自动退化逐个 mkdir）→ 逐文件入组队列（并发池限流，传输界面聚合一条）。 */
  async function uploadDirToServers(entry: FsEntry, targets: { serverId: string; rootId: string }[]) {
    setDialog({ kind: "none" });
    let walk: WalkResult;
    try {
      walk = await walkLocalDir(api.active().rootId, entry.path);
    } catch (e) {
      setError(String(e));
      return;
    }
    if (walk.truncated) {
      setError("目录过大（超过 20000 个条目或 64 层深度），已拒绝上传，请拆分后分批进行");
      return;
    }
    let dirAbs = "";
    try {
      dirAbs = api.joinLocalAbs(entry.path);
    } catch (e) {
      notify(String(e));
      return;
    }
    const dirs = [entry.name, ...walk.entries.filter((x) => x.isDir).map((x) => `${entry.name}/${x.relPath}`)];
    const files = walk.entries.filter((x) => !x.isDir);
    for (const t of targets) {
      try {
        await serverMkdirs(t.serverId, t.rootId, dirs);
      } catch (e) {
        setError(`建远端目录失败：${String(e)}`);
        continue; // 该服务端整体跳过（文件传上去也会因权限/jail 失败），其余照常
      }
      if (files.length === 0) {
        notify(`已在所选服务端创建空目录 ${entry.name}`);
        continue;
      }
      const gid = uid();
      enqueueGroup({
        id: gid,
        label: `目录 ${entry.name}`,
        serverId: t.serverId,
        rootId: t.rootId,
        children: files.map((f) => ({
          name: f.name,
          remotePath: `${entry.name}/${f.relPath}`, // 相对远程根；落在 <根>/<目录名>/…
          localPath: `${dirAbs}/${f.relPath}`,
          size: f.size,
          baseHash: "-", // 与单文件流一致：断言新文件；已存在→冲突 error，组"重试"走覆盖
        })),
      });
      watchGroup(gid, entry.name);
    }
    if (files.length > 0) {
      notify(`已加入目录上传队列：${entry.name}（${files.length} 个文件）→ ${targets.length} 个服务端（见"传输"界面）`);
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
          await api.source().rename(e.path, v);
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
          const source = api.source();
          if (mode === "copy") await source.copy(items.map((i) => i.path), dest);
          else await source.move(items.map((i) => i.path), dest);
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
    api.saveConfig(next).then((saved) => {
      api.invalidateSource();
      setCfg({ ...saved });
      setView("files");
      setPath(parentOf(hit.path));
      notify(`已定位到 ${hit.path}`);
    });
  }

  function changeViewMode(m: "list" | "grid") {
    setViewMode(m);
    const c = api.getConfig();
    void api.saveConfig({ ...c, ui: { ...c.ui, viewMode: m } }).then((saved) => setCfg({ ...saved }));
  }

  function changeGroupByKind(v: boolean) {
    setGroupByKind(v);
    const c = api.getConfig();
    void api.saveConfig({ ...c, ui: { ...c.ui, groupByKind: v } }).then((saved) => setCfg({ ...saved }));
  }

  function toggleSidebar() {
    const c = api.getConfig();
    const v = !c.ui.sidebarCollapsed;
    setSidebarCollapsed(v);
    void api.saveConfig({ ...c, ui: { ...c.ui, sidebarCollapsed: v } }).then((saved) => setCfg({ ...saved }));
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
  const anonymous = !!src?.anonymous;

  return (
    <div className="app">
      <Sidebar
        cfg={cfg}
        view={view}
        roots={api.active().kind === "server" ? roots : cfg.localRoots}
        collapsed={sidebarCollapsed}
        onView={setView}
        onToggleCollapse={toggleSidebar}
        onPickLocalRoot={pickLocalRoot}
        onPickServer={pickServer}
        onPickRoot={async (id) => {
          const a = api.active();
          await setActive({ ...a, rootId: id });
        }}
        onOpenSettings={() => openSettings()}
        onOpenUsers={() => openSettings("account")}
      />

      <main className="main">
        <Topbar
          cfg={cfg}
          view={view}
          activeKey={activeKey}
          lastServerId={cfg.ui.lastServerId}
          anonymous={anonymous}
          username={activeServer?.username}
          onSwitchLocal={switchLocal}
          onSwitchServer={pickServer}
          onLogin={(id) => setDialog({ kind: "login", serverId: id })}
          onLogout={async () => {
            await api.serverLogout(api.active().serverId!);
            loginPrompted.current = ""; // 登出后若服务端拒绝游客，允许再自动弹一次
            setCfg({ ...api.getConfig() }); // 需求8：badge/用户名等左右状态立即同步（事件稍后再兜底一次）
            setRoots([]);
            notify("已退出登录");
            refresh();
          }}
        />

        {view === "files" && src && (
          <FileView
            path={path}
            rootName={rootName()}
            entries={entries}
            loading={loading}
            error={error}
            isServer={src.kind === "server"}
            anonymous={anonymous}
            caps={src.caps}
            aiReady={cfg.ai.provider !== "none"}
            viewMode={viewMode}
            onViewMode={changeViewMode}
            groupByKind={groupByKind}
            onGroupByKind={changeGroupByKind}
            onOpen={openEntry}
            onPreview={previewEntry}
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
                    await api.source().mkdir(joinPath(path, v));
                    refresh();
                  } catch (e) {
                    setError(String(e));
                  }
                },
              })
            }
            onUpload={upload}
            onDownload={download}
            onRename={rename}
            onCopyMove={copyMove}
            onDelete={askDelete}
            onDescribe={describe}
            onShare={(e) => setDialog({ kind: "share", target: { path: e.path, isDir: e.isDir } })}
            onAcl={(e) =>
              setDialog({
                kind: "acl",
                path: e ? (e.isDir ? e.path : parentOf(e.path)) : path,
              })
            }
            onVersions={(e) => setDialog({ kind: "versions", entry: e })}
            onCtxEntry={src?.kind === "local" && cfg.servers.length > 0 ? (e, x, y) => setCtx({ entry: e, x, y }) : undefined}
          />
        )}

        {view === "trash" && (
          <TrashView
            items={trash}
            loading={loading}
            error={error}
            isLocal={src?.kind !== "server"}
            retentionDays={cfg.trashRetentionDays}
            onRefresh={refreshTrash}
            onRestore={async (t) => {
              try {
                await api.source().restoreTrash(t.trashId);
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
                    await api.source().removeTrash(t.trashId);
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
                    await api.source().clearTrash();
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

        {view === "transfers" && <TransfersView cfg={cfg} />}

        {view === "ai" && <AIView cfg={cfg} onOpenSettings={() => openSettings()} onJump={jumpTo} />}

        {view === "search" && (
          <SearchView
            onOpen={openEntry}
            onPreview={previewEntry}
            onLocate={(e) => {
              setView("files");
              setPath(e.path);
            }}
          />
        )}

        {/* 0.1.4（需求2）：设置为整页视图——左侧导航保持可见/可折叠，非浮动卡片 */}
        {view === "settings" && (
          <Settings
            key={settingsTab ?? "open"}
            cfg={cfg}
            initialTab={settingsTab ?? undefined}
            onClose={() => setView("files")}
            onSave={async (next) => {
              const saved = await api.saveConfig(next);
              api.invalidateSource();
              setCfg({ ...saved });
              applyTheme(saved.ui.theme);
              await refresh();
            }}
            onLogin={(id) => setDialog({ kind: "login", serverId: id, from: "settings" })}
          />
        )}

        {/* 0.1.7：查看覆盖层——盖住主区文件列表（保留其下筛选/选中状态），
            仅 files/search 视图生效（切视图的清除 effect 之前不闪现） */}
        {viewing && (view === "files" || view === "search") && (
          <FileViewer
            entry={viewing}
            decoder={cfg.ui.videoDecoder}
            onExit={() => setViewing(null)}
            onDownload={(e) => {
              setViewing(null);
              void download([e]);
            }}
          />
        )}
      </main>

      {showConfirm && (
        <Confirm
          title={showConfirm.title}
          lines={showConfirm.lines}
          danger={showConfirm.danger}
          typedConfirm={showConfirm.typed}
          onOk={showConfirm.onOk}
          onCancel={() => {
            setDialog({ kind: "none" });
            showConfirm.onCancel?.();
          }}
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
          onClose={() => {
            // 从设置（账户/服务器页）打开的登录框：取消也回到账户页，不落主界面
            const back = dialog.from === "settings";
            setDialog({ kind: "none" });
            if (back) openSettings("account");
          }}
          onDone={async () => {
            loginPrompted.current = ""; // 登录成功：重置，未来会话失效仍可自动弹一次
            const c = await api.loadConfig();
            setCfg({ ...c });
            applyTheme(c.ui.theme);
            const rs = await api.fetchRoots(dialog.serverId).catch(() => [] as ServerRoot[]);
            setRoots(rs);
            // 登录成功后回到账户页（0.6.1）：从设置打开的登录框不再落回主界面
            const back = dialog.from === "settings";
            setDialog({ kind: "none" });
            if (back) openSettings("account");
            const cur = api.active();
            await setActive({
              kind: "server",
              serverId: dialog.serverId,
              rootId: cur.kind === "server" && cur.serverId === dialog.serverId ? cur.rootId : rs?.[0]?.id ?? "",
            });
          }}
        />
      )}
      {dialog.kind === "preview" && (
        <PreviewModal
          entry={dialog.entry}
          onClose={() => setDialog({ kind: "none" })}
          onDownload={(e) => {
            setDialog({ kind: "none" });
            void download([e]);
          }}
        />
      )}
      {dialog.kind === "share" && (
        <ShareDialog target={dialog.target} onClose={() => setDialog({ kind: "none" })} notify={notify} />
      )}
      {dialog.kind === "acl" && (
        <AclDialog path={dialog.path} onClose={() => setDialog({ kind: "none" })} notify={notify} />
      )}
      {dialog.kind === "versions" && (
        <VersionsDialog
          entry={dialog.entry}
          onClose={() => setDialog({ kind: "none" })}
          onRolledBack={refresh}
          notify={notify}
        />
      )}

      {dialog.kind === "uploadTo" && (
        <UploadToDialog
          cfg={cfg}
          fileName={dialog.entry.name}
          isDir={dialog.entry.isDir}
          onCancel={() => setDialog({ kind: "none" })}
          onSubmit={(targets) =>
            dialog.entry.isDir ? uploadDirToServers(dialog.entry, targets) : uploadToServers(dialog.entry, targets)
          }
        />
      )}

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={
            [
              ...(ctx.entry.isDir
                ? [{ label: "打开", icon: <IconEye size={13} />, onSelect: () => openEntry(ctx.entry) }]
                : viewableType(ctx.entry)
                  ? // 0.1.7 查看/预览分离：可预览类型两项都给（查看=主区大图，预览=弹窗小图）
                    [
                      { label: "查看", icon: <IconExpand size={13} />, onSelect: () => openEntry(ctx.entry) },
                      { label: "预览", icon: <IconEye size={13} />, onSelect: () => previewEntry(ctx.entry) },
                    ]
                  : [{ label: "预览", icon: <IconEye size={13} />, onSelect: () => previewEntry(ctx.entry) }]),
              {
                label: ctx.entry.isDir ? "上传目录到远程…" : "上传到远程…",
                icon: <IconUpload size={13} />,
                onSelect: () => setDialog({ kind: "uploadTo", entry: ctx.entry }),
              },
            ] as CtxItem[]
          }
          onClose={() => setCtx(null)}
        />
      )}

      <TransferPanel />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
