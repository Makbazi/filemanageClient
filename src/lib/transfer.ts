// 传输任务管理器（0.6.0 需求4/5/6）：
// - 任务注册表：上传/下载统一入队，记录全部参数以支持 暂停→继续 / 失败→重试；
// - Rust "fm-transfer" 事件按 transferId 归并进度（running 态由事件驱动）；
// - 暂停=停止传输但保留进度（下载 .part / 上传服务端会话），继续=以同 transferId 重跑断点续传；
// - TransferPanel（浮出小窗）与 TransfersView（管理页）共用本注册表；
// - 需求41 目录上传：enqueueGroup 组任务——子任务只在注册表内（不进 UI 快照 order），
//   由一条组行聚合进度，并发池限流（默认 3），暂停/继续/取消/重试作用于整组。
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ServerSource } from "./server";
import { getConfig } from "./api";
import { uid } from "./types";
import type { TransferTask } from "./transtypes";

export type { TransferTask, TransferStatus } from "./transtypes";
import type { TransferStatus } from "./transtypes";

const tasks = new Map<string, TransferTask>();
const order: string[] = []; // 最新在前
const listeners = new Set<(list: TransferTask[]) => void>();

function notify() {
  const snap = order.map((id) => tasks.get(id)!).filter(Boolean);
  listeners.forEach((fn) => fn(snap));
}

function patch(id: string, p: Partial<TransferTask>) {
  const t = tasks.get(id);
  if (!t) return;
  Object.assign(t, p);
  notify();
  if (t.group) settle(t.group); // 需求41：子任务状态/进度变化同步到组行（组行无 group 字段，不会递归）
}

/** 事件驱动的进度归并（仅作用于运行中的任务；done/error/cancelled/paused 落终态）。 */
function applyEvent(ev: {
  transferId: string; name: string; direction: string;
  sent: number; total: number; speed: number; status: string; message: string;
}) {
  const t = tasks.get(ev.transferId);
  if (!t) {
    // 未经入队的传输（App 直接发起的服务端上传/下载等）：首个事件自动注册为
    // 展示任务——可取消、可看进度；无完整参数，暂停/继续/重试不可用。
    const task: TransferTask = {
      id: ev.transferId,
      kind: ev.direction === "download" ? "download" : "upload",
      serverId: "",
      rootId: "",
      name: ev.name,
      remotePath: "",
      localPath: "",
      status: (ev.status || "running") as TransferStatus,
      sent: ev.sent,
      total: ev.total,
      speed: ev.speed,
      message: ev.message,
    };
    tasks.set(task.id, task);
    order.unshift(task.id);
    notify();
    return;
  }
  const st = ev.status as TransferStatus;
  patch(ev.transferId, {
    sent: ev.sent, total: ev.total, speed: ev.speed,
    status: st === "running" ? "running" : st,
    message: ev.message,
  });
}

let inited = false;
export async function initTransfers() {
  if (inited) return;
  inited = true;
  await listen("fm-transfer", (e) => applyEvent(e.payload as never));
}

export function subscribe(fn: (tasks: TransferTask[]) => void): () => void {
  listeners.add(fn);
  fn(order.map((id) => tasks.get(id)!).filter(Boolean));
  return () => listeners.delete(fn);
}

export function getTasks(): TransferTask[] {
  return order.map((id) => tasks.get(id)!).filter(Boolean);
}

export function activeCount(): number {
  // 需求41：只计 UI 快照任务（组行按一条计），目录上传子任务不单独进角标
  return order
    .map((id) => tasks.get(id))
    .filter((t) => t && (t.status === "running" || t.status === "queued" || t.status === "paused")).length;
}

/** 入队并开始执行（需求6：上传/下载统一入口，方向由 kind 区分）。 */
export function enqueue(t: Omit<TransferTask, "status" | "sent" | "total" | "speed" | "message">): TransferTask {
  const task: TransferTask = { ...t, status: "queued", sent: 0, total: 0, speed: 0, message: "" };
  tasks.set(task.id, task);
  order.unshift(task.id);
  notify();
  void run(task.id);
  return task;
}

/** 执行一个任务（新入队/继续/重试都走这里；同 transferId 复用断点）。 */
async function run(id: string) {
  const t = tasks.get(id);
  if (!t || !t.serverId || !t.rootId) {
    patch(id, { status: "error", message: "任务缺少服务端信息" });
    return;
  }
  const srv = getConfig().servers.find((s) => s.id === t.serverId);
  if (!srv?.token) {
    patch(id, { status: "error", message: "未登录该服务端，请先登录后重试" });
    return;
  }
  patch(id, { status: "running", message: "" });
  const source = new ServerSource(t.serverId, t.rootId, false);
  try {
    if (t.kind === "upload") {
      let baseHash = t.baseHash;
      if (t.overwrite) {
        // 覆盖模式：入队执行时再取目标哈希（服务端覆盖前自动版本快照，需求3/6）
        try {
          const st = await source.stat(t.remotePath);
          baseHash = st.hash || "";
        } catch {
          baseHash = "-";
        }
      }
      await source.uploadFile(t.localPath, dirOf(t.remotePath), id, baseHash);
    } else {
      await source.downloadFile(t.localPath, t.remotePath, id);
    }
    if (tasks.get(id)?.status !== "paused" && tasks.get(id)?.status !== "cancelled") {
      patch(id, { status: "done", message: tasks.get(id)?.message || "" });
    }
  } catch (e) {
    const msg = String(e);
    const cur = tasks.get(id);
    if (!cur) return;
    if (cur.status === "paused" || cur.status === "cancelled") return; // 事件已落状态
    if (msg.includes("已暂停")) patch(id, { status: "paused" });
    else if (msg.includes("取消")) patch(id, { status: "cancelled" });
    else if (msg.includes("conflict") || msg.includes("已存在"))
      patch(id, { status: "error", message: "目标已存在或已被他人修改——可勾选覆盖重试" });
    else if (msg.startsWith("AUTH_REQUIRED")) patch(id, { status: "error", message: "登录已失效，重新登录后重试" });
    else patch(id, { status: "error", message: msg });
  }
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export async function pauseTask(id: string) {
  await invoke("transfer_cancel", { transferId: id, pause: true }).catch(() => {});
  patch(id, { status: "paused", message: "已暂停" });
}

export async function cancelTask(id: string) {
  await invoke("transfer_cancel", { transferId: id, pause: false }).catch(() => {});
  patch(id, { status: "cancelled", message: "已取消" });
}

/** 继续/重试：保留断点重跑（暂停任务=续传；错误任务=再试一次）。 */
export function resumeTask(id: string) {
  const t = tasks.get(id);
  if (!t) return;
  patch(id, { status: "queued" });
  void run(id);
}

/** 覆盖重试：先取目标当前哈希再跑（服务端覆盖前版本快照）。 */
export function overwriteRetry(id: string) {
  const t = tasks.get(id);
  if (!t) return;
  patch(id, { overwrite: true });
  void run(id);
}

export function removeTask(id: string) {
  const g = groups.get(id);
  if (g) {
    // 需求41：移除组行时级联清理其子任务（子任务不在 order，不会经 clearFinished 触达）
    for (const cid of g.childIds) tasks.delete(cid);
    groups.delete(id);
  }
  tasks.delete(id);
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  notify();
}

export function clearFinished() {
  for (const id of [...order]) {
    const t = tasks.get(id);
    if (t && (t.status === "done" || t.status === "cancelled")) removeTask(id);
  }
}

/** 本地模式的导入/导出：注册一条即时完成的任务记录（保持界面统一）。 */
export function reportLocal(id: string, name: string, patchFields: Partial<TransferTask>) {
  const task: TransferTask = {
    id, kind: "upload", serverId: "", rootId: "", name, remotePath: "", localPath: "",
    status: "running", sent: 0, total: 0, speed: 0, message: "", ...patchFields,
  };
  tasks.set(id, task);
  order.unshift(id);
  notify();
}

// ---------- 需求41：目录上传组任务（聚合行 + 并发池） ----------

const GROUP_CONCURRENCY = 3;

interface GroupRec {
  id: string;
  childIds: string[];
  pending: string[]; // queued 未派发；enqueueGroup 填充，pause/cancel 清空，resume/retry 回填
  running: number;
  concurrency: number;
}
const groups = new Map<string, GroupRec>();

export interface GroupChildSpec {
  name: string;
  remotePath: string;
  localPath: string;
  size: number;
  baseHash?: string;
}

/** 入队一个目录上传组：子任务只进注册表（不进 order=不进 UI 快照），
 *  由一条组行聚合展示；并发池限流（默认 3）避免整棵树同时开传。 */
export function enqueueGroup(o: {
  id: string;
  label: string;
  serverId: string;
  rootId: string;
  children: GroupChildSpec[];
  concurrency?: number;
}): void {
  const rec: GroupRec = {
    id: o.id, childIds: [], pending: [], running: 0,
    concurrency: o.concurrency ?? GROUP_CONCURRENCY,
  };
  groups.set(o.id, rec);
  for (const c of o.children) {
    const task: TransferTask = {
      id: uid(), kind: "upload", serverId: o.serverId, rootId: o.rootId,
      name: c.name, remotePath: c.remotePath, localPath: c.localPath,
      baseHash: c.baseHash, group: o.id,
      status: "queued", sent: 0, total: c.size, speed: 0, message: "",
    };
    tasks.set(task.id, task); // 注意：不 unshift 进 order（UI 快照只含组行）
    rec.childIds.push(task.id);
    rec.pending.push(task.id);
  }
  const row: TransferTask = {
    id: o.id, kind: "upload", serverId: o.serverId, rootId: o.rootId,
    name: o.label, remotePath: "", localPath: "", isGroup: true,
    status: "queued", sent: 0, total: o.children.reduce((s, c) => s + c.size, 0), speed: 0, message: "",
    files: 0, filesTotal: o.children.length,
  };
  tasks.set(row.id, row);
  order.unshift(row.id);
  notify();
  pump(o.id);
}

/** 并发池：把 pending 子任务补到 running 上限；每个终态回调里再补位。 */
function pump(gid: string) {
  const g = groups.get(gid);
  if (!g) return;
  while (g.running < g.concurrency && g.pending.length > 0) {
    const id = g.pending.shift()!;
    const t = tasks.get(id);
    if (!t || t.status !== "queued") continue; // 排队期间被组级暂停/取消的跳过
    g.running++;
    void run(id).finally(() => {
      g.running--;
      pump(gid);
    });
  }
  settle(gid);
}

/** 子任务变化后重算组行（由 patch 的 t.group 分支触发；组行自身无 group，无递归）。 */
function settle(gid: string) {
  const g = groups.get(gid);
  const row = tasks.get(gid);
  if (!g || !row) return;
  const ch = g.childIds.map((id) => tasks.get(id)).filter((t): t is TransferTask => !!t);
  if (ch.length === 0) return;
  const cnt = (s: TransferTask["status"]) => ch.filter((t) => t.status === s).length;
  const done = cnt("done"), errs = cnt("error"), canc = cnt("cancelled");
  const paused = cnt("paused"), queued = cnt("queued"), runCnt = cnt("running");
  const over = done + errs + canc;
  // done 子任务按全量字节计（事件终态 sent 可能小于 total，防进度条回退）
  const sent = ch.reduce((s, t) => s + (t.status === "done" ? t.total : t.sent), 0);
  const speed = ch.reduce((s, t) => s + (t.status === "running" ? t.speed : 0), 0);
  let status: TransferTask["status"] = "running";
  let message = "";
  if (over === ch.length) {
    if (errs === 0 && canc === 0) {
      status = "done";
      message = `${done}/${ch.length} 个文件`;
    } else if (canc === ch.length) {
      status = "cancelled";
      message = "已取消";
    } else {
      status = "error";
      message = `${done}/${ch.length} 个文件成功` + (errs ? `，${errs} 个失败` : "") + (canc ? `，${canc} 个已取消` : "");
    }
  } else if (runCnt === 0 && g.pending.length === 0) {
    if (paused > 0) { status = "paused"; message = "已暂停"; }
    else if (queued > 0) status = "queued";
  }
  patch(gid, { status, message, sent, total: Math.max(row.total, sent), speed, files: over, filesTotal: ch.length });
}

export async function pauseGroup(gid: string) {
  const g = groups.get(gid);
  if (!g) return;
  g.pending.length = 0;
  for (const id of g.childIds) {
    const t = tasks.get(id);
    if (!t) continue;
    if (t.status === "running") await pauseTask(id);
    else if (t.status === "queued") patch(id, { status: "paused", message: "已暂停" });
  }
  settle(gid);
}

export async function cancelGroup(gid: string) {
  const g = groups.get(gid);
  if (!g) return;
  g.pending.length = 0;
  for (const id of g.childIds) {
    const t = tasks.get(id);
    if (!t) continue;
    if (t.status === "running") await cancelTask(id);
    else if (t.status === "queued" || t.status === "paused") patch(id, { status: "cancelled", message: "已取消" });
  }
  settle(gid);
}

/** 组继续：paused 子任务回到 queued 重入池（同 transferId 断点续传）。 */
export function resumeGroup(gid: string) {
  const g = groups.get(gid);
  if (!g) return;
  for (const id of g.childIds) {
    const t = tasks.get(id);
    if (!t || t.status !== "paused") continue;
    patch(id, { status: "queued" });
    if (!g.pending.includes(id)) g.pending.push(id);
  }
  pump(gid);
}

/** 组重试：error 子任务重入池；冲突失败的置 overwrite=true 走覆盖重试——
 *  服务端覆盖前自动版本快照（需求3），与单文件"覆盖重试"同语义。 */
export function retryGroup(gid: string) {
  const g = groups.get(gid);
  if (!g) return;
  for (const id of g.childIds) {
    const t = tasks.get(id);
    if (!t || t.status !== "error") continue;
    if (t.message.includes("已存在") || t.message.includes("conflict")) t.overwrite = true;
    patch(id, { status: "queued" });
    if (!g.pending.includes(id)) g.pending.push(id);
  }
  pump(gid);
}

/** UI 快照已不含子任务；此 API 留给后续"展开组行看明细"。 */
export function getGroupChildren(gid: string): TransferTask[] {
  const g = groups.get(gid);
  if (!g) return [];
  return g.childIds.map((id) => tasks.get(id)).filter((t): t is TransferTask => !!t);
}

/** UI 动作统一选路：组行走组级 API，普通行走单任务 API（两个传输视图共用）。 */
export function rowActions(t: TransferTask) {
  return {
    pause: () => (t.isGroup ? pauseGroup(t.id) : pauseTask(t.id)),
    resume: () => (t.isGroup ? resumeGroup(t.id) : resumeTask(t.id)),
    cancel: () => (t.isGroup ? cancelGroup(t.id) : cancelTask(t.id)),
    retry: () => (t.isGroup ? retryGroup(t.id) : resumeTask(t.id)),
    overwriteRetry: () => (t.isGroup ? retryGroup(t.id) : overwriteRetry(t.id)),
  };
}
