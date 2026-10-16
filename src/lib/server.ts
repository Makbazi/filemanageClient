// 服务端数据源：JSON API 走 srv_call 代理（Rust 注入 token + 自动续期），
// 大流量传输走专用命令（分片上传/流式下载，带进度事件）。
import { invoke } from "@tauri-apps/api/core";
import type { DataSource, SourceCapabilities } from "./datasource";
import type { FsEntry, SearchFilters, TrashItem, VersionInfo } from "./types";
import { AuthError } from "./errors";

function q(rootId: string, path: string) {
  return `rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`;
}

/** 服务端 API 调用（经 srv_call 代理），401 → AuthError。 */
export async function srvCall<T = unknown>(
  serverId: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  try {
    return (await invoke("srv_call", { serverId, method, path, body: body ?? null })) as T;
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith("AUTH_REQUIRED")) throw new AuthError(msg.replace(/^AUTH_REQUIRED:\s*/, ""));
    throw new Error(msg);
  }
}

/** 服务端是否报"端点不存在"（需求41 mkdirs 兼容退化判定）。
 * gin NoRoute 信封 {error:"not found: /api/v1/mkdirs"}，Rust api_error 只透传 error 文本；
 * 非 JSON 响应体时为 "HTTP 404"/"HTTP 405"。新服务端 mkdirs 自身永不返回 404，误判安全。 */
export function isMissingEndpoint(e: unknown): boolean {
  const s = String(e);
  return /not found/i.test(s) || /HTTP (404|405)/.test(s);
}

/** 需求41：批量建远端目录（服务端 0.2.0 起提供 POST /api/v1/mkdirs，1000 条上限、
 * 1MB JSON 限内，客户端按 500/批）。旧服务端（<0.2.0）报端点不存在 → 该批退化为
 * 逐路径 POST /api/v1/mkdir（幂等 MkdirAll 递归，数量受 fs_walk 上限约束，串行可接受）；
 * 其他错误原样抛出，由调用方决定中止。 */
export async function serverMkdirs(serverId: string, rootId: string, paths: string[]): Promise<void> {
  const BATCH = 500;
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    try {
      await srvCall(serverId, "POST", "/api/v1/mkdirs", { rootId, paths: batch });
    } catch (e) {
      if (!isMissingEndpoint(e)) throw e;
      for (const p of batch) await srvCall(serverId, "POST", "/api/v1/mkdir", { rootId, path: p });
    }
  }
}

// ---------- 0.3.2 目录重传预检（POST /api/v1/check，Server ≥0.2.1） ----------

export interface CheckFile {
  path: string;
  size: number;
  hash?: string;
}

export type CheckState = "missing" | "same" | "differ" | "unknown";

export interface CheckResult {
  path: string;
  state: CheckState;
}

/** 批量校验远端文件（相同跳过/不同询问的服务端支撑）。500/批同 mkdirs 骨架。
 *  端点缺失（旧服务端）由调用方经 isMissingEndpoint 判定后退化为无预检旧流程。 */
export async function serverCheck(serverId: string, rootId: string, files: CheckFile[]): Promise<CheckResult[]> {
  const BATCH = 500;
  const out: CheckResult[] = [];
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH).map((f) => (f.hash ? f : { path: f.path, size: f.size }));
    const d = await srvCall<{ results?: CheckResult[] }>(serverId, "POST", "/api/v1/check", {
      rootId,
      files: batch,
    });
    out.push(...(d.results ?? []));
  }
  return out;
}

interface ServerFileVersion {
  id: number;
  versionNo: number;
  size: number;
  createdAt: string;
  createdBy?: number;
  hash?: string;
}

export class ServerSource implements DataSource {
  readonly kind = "server" as const;
  readonly caps: SourceCapabilities = { versions: true, share: true, acl: true, ai: true };

  constructor(
    readonly serverId: string,
    readonly rootId: string,
    readonly anonymous: boolean
  ) {}

  private call<T = unknown>(method: string, path: string, body?: unknown) {
    return srvCall<T>(this.serverId, method, path, body);
  }

  async list(path: string): Promise<FsEntry[]> {
    const d = await this.call<{ entries?: FsEntry[] }>("GET", `/api/v1/files?${q(this.rootId, path)}`);
    return d.entries ?? [];
  }

  stat(path: string): Promise<FsEntry> {
    return this.call<FsEntry>("GET", `/api/v1/stat?${q(this.rootId, path)}`);
  }

  async mkdir(path: string): Promise<void> {
    await this.call("POST", "/api/v1/mkdir", { rootId: this.rootId, path });
  }

  async rename(path: string, newName: string): Promise<void> {
    await this.call("POST", "/api/v1/rename", { rootId: this.rootId, path, newName });
  }

  async move(paths: string[], dest: string): Promise<void> {
    await this.call("POST", "/api/v1/move", { rootId: this.rootId, paths, dest });
  }

  async copy(paths: string[], dest: string): Promise<void> {
    await this.call("POST", "/api/v1/copy", { rootId: this.rootId, paths, dest });
  }

  async remove(paths: string[]): Promise<number> {
    const items = await this.call<TrashItem[]>("POST", "/api/v1/delete", { rootId: this.rootId, paths });
    return items?.length ?? 0;
  }

  async listTrash(): Promise<TrashItem[]> {
    const d = await this.call<{ items?: TrashItem[] }>(
      "GET",
      `/api/v1/trash?rootId=${encodeURIComponent(this.rootId)}`
    );
    return d.items ?? [];
  }

  async restoreTrash(trashId: string): Promise<void> {
    await this.call("POST", "/api/v1/trash/restore", { trashId });
  }

  async removeTrash(trashId: string): Promise<void> {
    await this.call("POST", "/api/v1/trash/remove", { trashId });
  }

  async clearTrash(): Promise<void> {
    await this.call("POST", `/api/v1/trash/clear?rootId=${encodeURIComponent(this.rootId)}`);
  }

  async search(f: SearchFilters): Promise<FsEntry[]> {
    const body: Record<string, unknown> = { rootId: this.rootId, query: f.query };
    if (f.kinds.length) body.kinds = f.kinds;
    if (f.sizeMin != null) body.sizeMin = f.sizeMin;
    if (f.sizeMax != null) body.sizeMax = f.sizeMax;
    if (f.mtimeFrom != null) body.mtimeFrom = new Date(f.mtimeFrom).toISOString();
    if (f.mtimeTo != null) body.mtimeTo = new Date(f.mtimeTo).toISOString();
    return (await this.call<FsEntry[]>("POST", "/api/v1/search", body)) ?? [];
  }

  previewData(entry: FsEntry): Promise<string> {
    return invoke("srv_preview_data", {
      serverId: this.serverId,
      rootId: this.rootId,
      path: entry.path,
      maxBytes: 8 << 20,
    }) as Promise<string>;
  }

  mediaCache(entry: FsEntry): Promise<string> {
    // ver=entry.mtime：缓存键含版本串，覆盖后自动重拉（0.1.7 图片也走本通道）
    return invoke("srv_media_cache", {
      serverId: this.serverId,
      rootId: this.rootId,
      path: entry.path,
      ver: String(entry.mtime),
    }) as Promise<string>;
  }

  thumbPath(entry: FsEntry): Promise<string | null> {
    // 0.3.6（浏览零整文件定版）：Rust 走服务端 GET /thumb（只回 ≤512px JPEG，
    // 几十 KB——打开图片目录不再拉取任何原图字节）。415/413/403/404=永久无图
    // （null 直接落图标；含 ≤0.2.0 旧服务端 404——废除旧"整文件静默入缓存本地
    // 缩放"兜底）；网络/429/401/5xx=瞬时（抛错，FileView 队列退避重试 ≤3 轮）。
    // Server ≥0.2.4 起 JPEG/RAW 像素闸门提至 50MP（YCbCr 平面路径），常见手机/
    // 单反原图仍出服务端小图；图标只剩 webp/heic 等无解码器形态。全量字节只在
    // 双击查看（mediaCache）或下载（srv_download）时到来。size_hint 参数已移除。
    return invoke("srv_thumb", {
      serverId: this.serverId,
      rootId: this.rootId,
      path: entry.path,
      ver: String(entry.mtime),
    }) as Promise<string | null>;
  }

  async uploadFile(
    localPath: string,
    dir: string,
    transferId: string,
    baseHash?: string,
    journal?: { gid: string; rel: string } | null
  ): Promise<void> {
    await invoke("srv_upload", {
      serverId: this.serverId,
      rootId: this.rootId,
      dir,
      localPath,
      transferId,
      baseHash: baseHash ?? null,
      journalGid: journal?.gid ?? null,
      journalRel: journal?.rel ?? null,
    });
  }

  async downloadFile(destPath: string, entryPath: string, transferId: string): Promise<void> {
    await invoke("srv_download", {
      serverId: this.serverId,
      rootId: this.rootId,
      path: entryPath,
      destPath,
      transferId,
    });
  }

  async versionsList(path: string): Promise<VersionInfo[]> {
    const d = await this.call<{ versions?: ServerFileVersion[] }>(
      "GET",
      `/api/v1/versions?${q(this.rootId, path)}`
    );
    return (d.versions ?? []).map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      size: v.size,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      hash: v.hash,
    }));
  }

  async versionsRollback(path: string, versionId: number | string): Promise<void> {
    await this.call("POST", "/api/v1/versions/rollback", {
      rootId: this.rootId,
      path,
      versionId: Number(versionId),
    });
  }

  async versionsRemove(versionId: number | string): Promise<void> {
    await this.call("DELETE", `/api/v1/versions/${versionId}`);
  }
}
