// 统一数据来源抽象：本地目录（invoke Rust 命令）与服务端（HTTP via Rust 代理）。
// App 层只调用这里的函数，切换来源即切换 active 配置。
import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveConf,
  AppConfig,
  DescRecord,
  FsEntry,
  SearchHit,
  ServerRoot,
  TrashItem,
} from "./types";

let cfg: AppConfig = {
  localRoots: [],
  servers: [],
  ai: { provider: "none", baseUrl: "", apiKey: "", model: "" },
};

export class AuthError extends Error {}

export async function loadConfig(): Promise<AppConfig> {
  cfg = (await invoke("get_config")) as AppConfig;
  if (!cfg.localRoots) cfg.localRoots = [];
  if (!cfg.servers) cfg.servers = [];
  if (!cfg.ai) cfg.ai = { provider: "none", baseUrl: "", apiKey: "", model: "" };
  return cfg;
}

export function getConfig(): AppConfig {
  return cfg;
}

export async function saveConfig(next: AppConfig): Promise<AppConfig> {
  cfg = (await invoke("save_config", { config: next })) as AppConfig;
  return cfg;
}

export function active(): ActiveConf {
  if (cfg.active) return cfg.active;
  const r = cfg.localRoots[0];
  return { kind: "local", rootId: r?.id ?? "" };
}

function q(rootId: string, path: string) {
  return `rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`;
}

async function call(method: string, path: string, body?: unknown) {
  const a = active();
  if (a.kind !== "server" || !a.serverId) throw new Error("未选择服务端");
  try {
    return await invoke("srv_call", {
      serverId: a.serverId,
      method,
      path,
      body: body ?? null,
    });
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith("AUTH_REQUIRED")) throw new AuthError(msg.replace(/^AUTH_REQUIRED:\s*/, ""));
    throw new Error(msg);
  }
}

export async function listFiles(path: string): Promise<FsEntry[]> {
  const a = active();
  if (a.kind === "local") {
    return (await invoke("fs_list", { rootId: a.rootId, path })) as FsEntry[];
  }
  const data = (await call("GET", `/api/v1/files?${q(a.rootId, path)}`)) as { entries: FsEntry[] };
  return data.entries ?? [];
}

export async function makeDir(path: string): Promise<void> {
  const a = active();
  if (a.kind === "local") return invoke("fs_mkdir", { rootId: a.rootId, path });
  await call("POST", "/api/v1/mkdir", { rootId: a.rootId, path });
}

export async function rename(path: string, newName: string): Promise<void> {
  const a = active();
  if (a.kind === "local") return invoke("fs_rename", { rootId: a.rootId, path, newName });
  await call("POST", "/api/v1/rename", { rootId: a.rootId, path, newName });
}

export async function movePaths(paths: string[], dest: string): Promise<void> {
  const a = active();
  if (a.kind === "local") return invoke("fs_move", { rootId: a.rootId, paths, dest });
  await call("POST", "/api/v1/move", { rootId: a.rootId, paths, dest });
}

export async function copyPaths(paths: string[], dest: string): Promise<void> {
  const a = active();
  if (a.kind === "local") return invoke("fs_copy", { rootId: a.rootId, paths, dest });
  await call("POST", "/api/v1/copy", { rootId: a.rootId, paths, dest });
}

/** 删除（进回收站）。调用方必须先做二次确认。 */
export async function deletePaths(paths: string[]): Promise<number> {
  const a = active();
  if (a.kind === "local") {
    const items = (await invoke("fs_delete", { rootId: a.rootId, paths })) as TrashItem[];
    return items.length;
  }
  const items = (await call("POST", "/api/v1/delete", { rootId: a.rootId, paths })) as TrashItem[];
  return items.length;
}

export async function listTrash(): Promise<TrashItem[]> {
  const a = active();
  if (a.kind === "local") return (await invoke("fs_trash_list", { rootId: a.rootId })) as TrashItem[];
  return (await call("GET", `/api/v1/trash?rootId=${encodeURIComponent(a.rootId)}`)) as TrashItem[];
}

export async function restoreTrash(trashId: string): Promise<void> {
  const a = active();
  if (a.kind === "local") return invoke("fs_trash_restore", { trashId });
  await call("POST", "/api/v1/trash/restore", { trashId });
}

export async function removeTrash(trashId: string): Promise<void> {
  const a = active();
  if (a.kind === "local") return invoke("fs_trash_remove", { trashId });
  await call("POST", "/api/v1/trash/remove", { trashId });
}

export async function clearTrash(): Promise<void> {
  const a = active();
  if (a.kind === "local") return invoke("fs_trash_clear", { rootId: a.rootId });
  await call("POST", `/api/v1/trash/clear?rootId=${encodeURIComponent(a.rootId)}`);
}

export async function searchNames(query: string): Promise<FsEntry[]> {
  const a = active();
  if (a.kind === "local") return (await invoke("fs_search", { rootId: a.rootId, query })) as FsEntry[];
  return (await call("POST", "/api/v1/search", { rootId: a.rootId, query })) as FsEntry[];
}

export async function preview(entry: FsEntry): Promise<string> {
  const a = active();
  if (a.kind === "local") return (await invoke("fs_preview", { rootId: a.rootId, path: entry.path })) as string;
  // 服务端预览：下载到临时目录后读取
  throw new Error("服务端文件请先下载到本地后预览");
}

// ---------- 传输 ----------

/** 服务端 → 本机（dest 为本机完整路径） */
export async function downloadToLocal(destPath: string, entryPath: string): Promise<void> {
  const a = active();
  if (a.kind !== "server") throw new Error("仅服务端来源支持下载");
  await invoke("srv_download", {
    serverId: a.serverId,
    rootId: a.rootId,
    path: entryPath,
    destPath,
  });
}

/** 本机文件 → 服务端目录 */
export async function uploadLocalToServer(dir: string, localPath: string): Promise<void> {
  const a = active();
  if (a.kind !== "server") throw new Error("请切换到服务端来源");
  await invoke("srv_upload", { serverId: a.serverId, rootId: a.rootId, dir, localPath });
}

/** 本机文件 → 当前本地目录 */
export async function importToLocal(path: string, localPath: string): Promise<void> {
  const a = active();
  if (a.kind !== "local") throw new Error("本地模式才支持导入");
  const name = localPath.split(/[\\/]/).pop() ?? "file";
  const b64 = (await invoke("fs_read_bytes_b64", { path: localPath })) as string;
  const dest = path ? `${path}/${name}` : name;
  await invoke("fs_write_bytes_b64", { destPath: joinLocalAbs(dest), dataB64: b64 });
}

/** 管理接口泛用调用（当前激活的服务端）。 */
export async function serverCall(method: string, path: string, body?: unknown): Promise<unknown> {
  return call(method, path, body);
}

// ---------- 服务端专属（登录/根列表） ----------

export async function serverLogin(serverId: string, username: string, password: string) {
  return invoke("srv_login", { serverId, username, password });
}

export async function serverLogout(serverId: string) {
  await invoke("srv_logout", { serverId });
  await loadConfig(); // 刷新 token 状态
}

export async function fetchRoots(serverId: string): Promise<ServerRoot[]> {
  return (await invoke("srv_call", { serverId, method: "GET", path: "/api/v1/roots", body: null })) as ServerRoot[];
}

export async function serverInfo(serverId: string): Promise<{ ok: boolean; db: string; version: string }> {
  return (await invoke("srv_call", { serverId, method: "GET", path: "/api/v1/health", body: null })) as never;
}

// ---------- AI（预留） ----------

export async function aiDescribe(entryPath: string): Promise<DescRecord | { text: string }> {
  const a = active();
  if (a.kind === "local") {
    return (await invoke("ai_describe_local", { rootId: a.rootId, path: entryPath, ai: cfg.ai })) as DescRecord;
  }
  return (await call("POST", "/api/v1/ai/describe", { rootId: a.rootId, path: entryPath })) as { text: string };
}

export async function aiSearch(query: string): Promise<SearchHit[]> {
  const a = active();
  if (a.kind === "local") {
    const recs = (await invoke("ai_search_local", { query })) as DescRecord[];
    return recs.map((r) => ({ ...r, score: 1 }));
  }
  const hits = (await call("POST", "/api/v1/ai/search", { query })) as SearchHit[];
  return hits ?? [];
}

// 辅助：把相对路径解析为当前本地根目录的绝对路径（仅本地模式）
export function joinLocalAbs(rel: string): string {
  const a = active();
  const root = cfg.localRoots.find((r) => r.id === a.rootId);
  if (!root) throw new Error("未选择本地目录");
  const clean = rel.replace(/^\/+/, "");
  return root.path.replace(/\/+$/, "") + "/" + clean;
}

export function isServerMode() {
  return active().kind === "server";
}
