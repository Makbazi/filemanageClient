// 本地目录数据源：全部经 Rust command（resolve_in_root 防逃逸）。
import { invoke } from "@tauri-apps/api/core";
import type { DataSource, SourceCapabilities } from "./datasource";
import type { FsEntry, SearchFilters, TrashItem, VersionInfo } from "./types";
import { parentOf } from "./format";
import { reportLocal } from "./transfer";

interface LocalVersion {
  id: string;
  rootId: string;
  path: string;
  versionNo: number;
  size: number;
  createdAt: number;
}

export class LocalSource implements DataSource {
  readonly kind = "local" as const;
  readonly anonymous = false;
  readonly caps: SourceCapabilities = { versions: true, share: false, acl: false, ai: true };

  constructor(readonly rootId: string) {}

  list(path: string): Promise<FsEntry[]> {
    return invoke("fs_list", { rootId: this.rootId, path }) as Promise<FsEntry[]>;
  }

  async stat(path: string): Promise<FsEntry> {
    const entries = await this.list(parentOf(path));
    const name = path.split("/").pop();
    const hit = entries.find((e) => e.name === name);
    if (!hit) throw new Error("文件不存在: " + path);
    return hit;
  }

  mkdir(path: string): Promise<void> {
    return invoke("fs_mkdir", { rootId: this.rootId, path });
  }

  rename(path: string, newName: string): Promise<void> {
    return invoke("fs_rename", { rootId: this.rootId, path, newName });
  }

  move(paths: string[], dest: string): Promise<void> {
    return invoke("fs_move", { rootId: this.rootId, paths, dest });
  }

  copy(paths: string[], dest: string): Promise<void> {
    return invoke("fs_copy", { rootId: this.rootId, paths, dest });
  }

  async remove(paths: string[]): Promise<number> {
    const items = (await invoke("fs_delete", { rootId: this.rootId, paths })) as TrashItem[];
    return items.length;
  }

  listTrash(): Promise<TrashItem[]> {
    return invoke("fs_trash_list", { rootId: this.rootId }) as Promise<TrashItem[]>;
  }

  restoreTrash(trashId: string): Promise<void> {
    return invoke("fs_trash_restore", { trashId }).then(() => undefined);
  }

  removeTrash(trashId: string): Promise<void> {
    return invoke("fs_trash_remove", { trashId });
  }

  clearTrash(): Promise<void> {
    return invoke("fs_trash_clear", { rootId: this.rootId }).then(() => undefined);
  }

  search(f: SearchFilters): Promise<FsEntry[]> {
    return invoke("fs_search", {
      rootId: this.rootId,
      query: f.query,
      kinds: f.kinds.length ? f.kinds : null,
      sizeMin: f.sizeMin ?? null,
      sizeMax: f.sizeMax ?? null,
      mtimeFrom: f.mtimeFrom ?? null,
      mtimeTo: f.mtimeTo ?? null,
    }) as Promise<FsEntry[]>;
  }

  previewData(entry: FsEntry): Promise<string> {
    return invoke("fs_preview", { rootId: this.rootId, path: entry.path }) as Promise<string>;
  }

  mediaCache(entry: FsEntry): Promise<string> {
    return invoke("fs_media_cache", { rootId: this.rootId, path: entry.path }) as Promise<string>;
  }

  async thumbData(entry: FsEntry): Promise<string | null> {
    if (entry.kind !== "image" || entry.size > 4 << 20) return null;
    try {
      return await this.previewData(entry);
    } catch {
      return null;
    }
  }

  async uploadFile(localPath: string, dir: string, transferId: string): Promise<void> {
    const name = localPath.split(/[\\/]/).pop() ?? "file";
    const d = dir.replace(/^\/+|\/+$/g, "");
    const destRel = d ? `${d}/${name}` : name;
    reportLocal(transferId, name, { kind: "upload", sent: 0, total: 1, status: "running" });
    try {
      await invoke("fs_import", { rootId: this.rootId, destRel, localPath });
      reportLocal(transferId, name, { kind: "upload", sent: 1, total: 1, status: "done", message: destRel });
    } catch (e) {
      reportLocal(transferId, name, { kind: "upload", status: "error", message: String(e) });
      throw e;
    }
  }

  async downloadFile(destPath: string, entryPath: string, transferId: string): Promise<void> {
    const name = entryPath.split("/").pop() ?? "file";
    reportLocal(transferId, name, { kind: "download", sent: 0, total: 1, status: "running" });
    try {
      await invoke("fs_export", { rootId: this.rootId, path: entryPath, destPath });
      reportLocal(transferId, name, { kind: "download", sent: 1, total: 1, status: "done", message: destPath });
    } catch (e) {
      reportLocal(transferId, name, { kind: "download", status: "error", message: String(e) });
      throw e;
    }
  }

  async versionsList(path: string): Promise<VersionInfo[]> {
    const vs = (await invoke("fs_versions_list", { rootId: this.rootId, path })) as LocalVersion[];
    return vs.map((v) => ({ id: v.id, versionNo: v.versionNo, size: v.size, createdAt: v.createdAt }));
  }

  versionsRollback(path: string, versionId: number | string): Promise<void> {
    return invoke("fs_versions_rollback", {
      rootId: this.rootId,
      path,
      versionId: String(versionId),
    });
  }

  versionsRemove(versionId: number | string): Promise<void> {
    return invoke("fs_versions_remove", { versionId: String(versionId) });
  }
}
