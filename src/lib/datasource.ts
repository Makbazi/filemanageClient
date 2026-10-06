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
  /** 图像/视频/音频/PDF（含相机 RAW）：拉入媒体缓存，返回可被 convertFileSrc
   *  使用的本机路径；无大小限制（大图可预览/查看），缓存键含 entry.mtime 版本串
   *  防覆盖后陈旧。0.2.1：RAW 不入原始字节——缓存的是从文件提取的最大内嵌
   *  JPEG 预览（.jpg），浏览器按普通图片渲染 */
  mediaCache(entry: FsEntry): Promise<string>;
  /** 网格视图缩略图（0.3.2 改版；0.3.3 契约收紧）：服务端模式优先走服务端
   *  GET /thumb（只回 ≤512px JPEG，浏览不再整文件入缓存；Server ≥0.2.2 含 BMP，
   *  出图能力与本地缩放机制对齐），本地产物仍落媒体缓存 `<key_hash>.thumb.jpg`，
   *  返回其本机路径（前端 thumbcache.ts 经 media_read_bytes 建 blob 上屏，
   *  ≤2GB 内存 LRU）。null=永久无缩略图（回退图标，不重试）；**抛错=瞬时失败**
   *  （网络/服务端繁忙等，由 FileView 队列退避重试 ≤3 轮后落图标）。
   *  0.3.3 起服务端明确不可出图（413/415/403）一律归 null——不再整文件下载兜底、
   *  不再对确定性结局空转重试（fs_thumb 同步对齐）。 */
  thumbPath(entry: FsEntry): Promise<string | null>;

  /** 上传/导入本机文件到 dir（带进度事件，transferId 关联 TransferPanel）。
   *  journal（0.3.2）：目录上传账本坐标 {gid, rel}——Rust 据此回写会话/终态，
   *  支撑重启后"继续未完成的上传组"；本地实现忽略。 */
  uploadFile(
    localPath: string,
    dir: string,
    transferId: string,
    baseHash?: string,
    journal?: { gid: string; rel: string } | null
  ): Promise<void>;
  /** 下载/导出到本机完整路径（带进度事件） */
  downloadFile(destPath: string, entryPath: string, transferId: string): Promise<void>;

  versionsList(path: string): Promise<VersionInfo[]>;
  versionsRollback(path: string, versionId: number | string): Promise<void>;
  versionsRemove?(versionId: number | string): Promise<void>;
}
