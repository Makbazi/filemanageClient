// 传输任务共享类型（需求4/5/6）：transfer.ts 任务注册表与传输 UI 共用此契约。
// 状态字符串与 Rust "fm-transfer" 事件的 status 取值一致。
export type TransferKind = "upload" | "download";

/** queued/running/paused 为非终态；done/error/cancelled 为终态。 */
export type TransferStatus = "queued" | "running" | "paused" | "done" | "error" | "cancelled";

/** 状态文案（TransferPanel 浮出小窗与 TransfersView 管理页共用）。 */
export const STATUS_LABEL: Record<TransferStatus, string> = {
  queued: "排队中",
  running: "传输中",
  paused: "已暂停",
  done: "完成",
  error: "失败",
  cancelled: "已取消",
};

export interface TransferTask {
  /** transferId（uid()），Rust 进度事件按此归并。 */
  id: string;
  kind: TransferKind;
  /**
   * 入队任务必填（run 需要）；本地导入或仅事件展示的任务为空串——
   * UI 据此决定 暂停/继续/重试 是否可用（断点重跑要求记录完整参数）。
   */
  serverId: string;
  rootId: string;
  name: string;
  remotePath: string;
  localPath: string;
  /** 上传乐观并发锁（"-"=断言新文件，需求3）。 */
  baseHash?: string;
  /** 覆盖重试：执行前重新取目标哈希（服务端覆盖前自动版本快照）。 */
  overwrite?: boolean;
  status: TransferStatus;
  sent: number;
  /** 0 = 总大小未知（如流式下载无 Content-Length）。 */
  total: number;
  /** B/s，0 = 未知。 */
  speed: number;
  message: string;
  /** 需求41 目录上传：子任务所属组任务 id（有值的任务不出现在 UI 快照，由组行聚合展示）。 */
  group?: string;
  /** 需求41：该任务为组聚合行（UI 的 暂停/继续/取消/重试 走组级 API）。 */
  isGroup?: boolean;
  /** 需求41：组行已完成（含失败/取消）文件数 与 总文件数。 */
  files?: number;
  filesTotal?: number;
  /** 0.3.2：目录重传预检判定的"相同跳过"文件数（不入队、不占 filesTotal）。 */
  skipped?: number;
  /** 0.3.2：组内子任务在上传账本中的 rel_path（组任务 id 即账本 gid；
   *  Rust srv_upload 据此回写 session_id/终态——重启后"继续未完成的上传组"）。 */
  journalRel?: string;
}
