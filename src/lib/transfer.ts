// 传输任务管理器（0.6.0 需求4/5/6）：
// - 任务注册表：上传/下载统一入队，记录全部参数以支持 暂停→继续 / 失败→重试；
// - Rust "fm-transfer" 事件按 transferId 归并进度（running 态由事件驱动）；
// - 暂停=停止传输但保留进度（下载 .part / 上传服务端会话），继续=以同 transferId 重跑断点续传；
// - TransferPanel（浮出小窗）与 TransfersView（管理页）共用本注册表。
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ServerSource } from "./server";
import { getConfig } from "./api";
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
  return [...tasks.values()].filter((t) => t.status === "running" || t.status === "queued" || t.status === "paused").length;
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
