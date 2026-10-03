// DataSource 统一数据源接口（接口化设计，需求1）：
// 本地目录（Rust command）与服务端（HTTP via Rust 代理）各自实现，
// UI 层只依赖本接口，切换来源即切换实现。
import type { FsEntry, SearchFilters, TrashItem, VersionInfo } from "./types";

export interface SourceCapabilities {
  /** 文件版本管理（本地/服务端均支持，需求13） */
  versions: boolean;
  /** 临时分享链接（仅服务端，需求7） */
  share: boolean;
  /** 目录权限/分享设置（仅服务端，需求8/9） */
  acl: boolean;
  /** AI 描述（本地=本机 AI 配置；服务端=服务端 AI） */
  ai: boolean;
}

export interface DataSource {
  readonly kind: "local" | "server";
  readonly rootId: string;
  /** 服务端来源且未登录（游客只读，需求6） */
  readonly anonymous: boolean;
  readonly caps: SourceCapabilities;

  list(path: string): Promise<FsEntry[]>;
  stat(path: string): Promise<FsEntry>;
  mkdir(path: string): Promise<void>;
  rename(path: string, newName: string): Promise<void>;
  move(paths: string[], dest: string): Promise<void>;
  copy(paths: string[], dest: string): Promise<void>;
  /** 删除（进回收站），返回删除数量 */
  remove(paths: string[]): Promise<number>;

  listTrash(): Promise<TrashItem[]>;
  restoreTrash(trashId: string): Promise<void>;
  removeTrash(trashId: string): Promise<void>;
  clearTrash(): Promise<void>;

  search(f: SearchFilters): Promise<FsEntry[]>;

  /** 文本预览：返回 data URL（0.1.7 起图像不再走本通道——8MiB 上限只适合小文本；大图统一 mediaCache） */
  previewData(entry: FsEntry): Promise<string>;
  /** 图像/视频/音频/PDF：拉入媒体缓存，返回可被 convertFileSrc 使用的本机路径；
   *  无大小限制（大图可预览/查看），缓存键含 entry.mtime 版本串防覆盖后陈旧 */
  mediaCache(entry: FsEntry): Promise<string>;
  /** 网格视图缩略图：返回 data URL；不支持/过大返回 null（前端回退图标） */
  thumbData(entry: FsEntry): Promise<string | null>;

  /** 上传/导入本机文件到 dir（带进度事件，transferId 关联 TransferPanel） */
  uploadFile(localPath: string, dir: string, transferId: string, baseHash?: string): Promise<void>;
  /** 下载/导出到本机完整路径（带进度事件） */
  downloadFile(destPath: string, entryPath: string, transferId: string): Promise<void>;

  versionsList(path: string): Promise<VersionInfo[]>;
  versionsRollback(path: string, versionId: number | string): Promise<void>;
  versionsRemove?(versionId: number | string): Promise<void>;
}
