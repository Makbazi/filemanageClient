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
    return invoke("srv_media_cache", {
      serverId: this.serverId,
      rootId: this.rootId,
      path: entry.path,
    }) as Promise<string>;
  }

  async thumbData(entry: FsEntry): Promise<string | null> {
    if (entry.kind !== "image" || entry.size > 4 << 20) return null;
    try {
      return (await invoke("srv_thumb", {
        serverId: this.serverId,
        rootId: this.rootId,
        path: entry.path,
      })) as string;
    } catch {
      return null;
    }
  }

  async uploadFile(localPath: string, dir: string, transferId: string, baseHash?: string): Promise<void> {
    await invoke("srv_upload", {
      serverId: this.serverId,
      rootId: this.rootId,
      dir,
      localPath,
      transferId,
      baseHash: baseHash ?? null,
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
