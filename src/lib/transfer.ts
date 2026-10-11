// 传输任务管理器（需求4/5/6）：
// - 任务注册表：上传/下载统一入队，记录全部参数以支持 暂停→继续 / 失败→重试；
// - Rust "fm-transfer" 事件按 transferId 归并进度（running 态由事件驱动）；
// - 暂停=停止传输但保留进度（下载 .part / 上传服务端会话），继续=以同 transferId 重跑断点续传；
// - TransferPanel（浮出小窗）与 TransfersView（管理页）共用本注册表；
// - 需求41 目录上传：enqueueGroup 组任务——子任务只在注册表内（不进 UI 快照 order），
//   由一条组行聚合进度，并发池限流（默认 3），暂停/继续/取消/重试作用于整组。
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ServerSource, srvCall } from "./server";
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
  // 0.3.5 需求3：任务重新进入运行态（继续/重试）即清除面板隐藏标记——
  // 右下角面板必须能看见"在动"的任务；隐藏只针对终态行的展示。
  patch(id, { status: "running", message: "", panelHidden: false });
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
      await source.uploadFile(
        t.localPath,
        dirOf(t.remotePath),
        id,
        baseHash,
        t.group && t.journalRel ? { gid: t.group, rel: t.journalRel } : null
      );
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
    // 0.3.2：按 Rust 的 FM_* 前缀路由（弃中文串嗅探——服务端错误文案含"取消"
    // 等字样的误分类是旧隐患）；旧无前缀消息保留文本兜底以兼容过渡期。
    if (msg.startsWith("FM_PAUSE:") || msg.includes("已暂停")) patch(id, { status: "paused" });
    else if (msg.startsWith("FM_CANCEL:") || msg.includes("已取消")) patch(id, { status: "cancelled" });
    else if (msg.startsWith("FM_CONFLICT:") || msg.includes("conflict") || msg.includes("已存在"))
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

/** 0.3.5 需求3：仅从右下角传输面板隐藏该条（任务注册表与传输管理页不受影响；
 *  removeTask 才是两视图同删的"从列表移除"）。再次执行（run）自动恢复显示。 */
export function dismissFromPanel(id: string) {
  patch(id, { panelHidden: true });
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
  /** 0.3.2：上传账本 rel_path（组任务 id=账本 gid；缺省=不入账） */
  journalRel?: string;
}

/** 入队一个目录上传组：子任务只进注册表（不进 order=不进 UI 快照），
 *  由一条组行聚合展示；并发池限流（默认 3）避免整棵树同时开传。
 *  skipped=0.3.2 预检判定"远端已相同"的文件数（不入队，仅组行文案展示）。 */
export function enqueueGroup(o: {
  id: string;
  label: string;
  serverId: string;
  rootId: string;
  children: GroupChildSpec[];
  concurrency?: number;
  skipped?: number;
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
      baseHash: c.baseHash, group: o.id, journalRel: c.journalRel,
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
    files: 0, filesTotal: o.children.length, skipped: o.skipped,
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
  const skipTxt = row.skipped ? `，跳过 ${row.skipped} 个相同文件` : "";
  if (over === ch.length) {
    if (errs === 0 && canc === 0) {
      status = "done";
      message = `${done}/${ch.length} 个文件${skipTxt}`;
    } else if (canc === ch.length) {
      status = "cancelled";
      message = "已取消";
    } else {
      status = "error";
      message = `${done}/${ch.length} 个文件成功` + (errs ? `，${errs} 个失败` : "") + (canc ? `，${canc} 个已取消` : "") + skipTxt;
    }
  } else if (runCnt === 0 && g.pending.length === 0) {
    if (paused > 0) { status = "paused"; message = "已暂停"; }
    else if (queued > 0) status = "queued";
  }
  patch(gid, { status, message, sent, total: Math.max(row.total, sent), speed, files: over, filesTotal: ch.length });
  syncGroupDb(gid, status);
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

// ---------- 0.3.2 上传账本联动（重启续传兜底，需求清单第 2 条） ----------

/** 组行状态变化落账本（去抖：只在终态语义变化时写）。error/paused/queued/running
 *  统一记 active——账本语义是"未完成、可续"，done/canceled 才终态。 */
const groupDbStatus = new Map<string, string>();
function syncGroupDb(gid: string, status: TransferStatus) {
  const s = status === "done" ? "done" : status === "cancelled" ? "canceled" : "active";
  if (groupDbStatus.get(gid) === s) return;
  groupDbStatus.set(gid, s);
  void invoke("lg_group_status", { gid, status: s }).catch(() => {});
}

/** 账本组行（lg_list_pending/lg_group_info 的 JS 形态，Rust camelCase 序列化）。 */
export interface JournalGroupRow {
  gid: string;
  label: string;
  serverId: string;
  rootId: string;
  localAbs: string;
  remotePrefix: string;
  status: string;
  totalFiles: number;
  doneFiles: number;
  createdAt: number;
  updatedAt: number;
}

export interface JournalItemRow {
  relPath: string;
  name: string;
  localPath: string;
  remotePath: string;
  size: number;
  mtimeMs: number;
  sha: string;
  sessionId: string;
  state: string;
}

/** 未完成组列表（TransfersView 呈现；账本不存在/异常返回空，不阻塞 UI）。 */
export async function listJournalPending(): Promise<JournalGroupRow[]> {
  try {
    return (await invoke<JournalGroupRow[]>("lg_list_pending")) ?? [];
  } catch {
    return [];
  }
}

/** 继续一个未完成的账本组：同 gid 重建子任务入队（done 条目跳过；服务端会话
 *  仍在则自动断点续传，会话已废则全新开始——0.2.1 服务端命中坏会话会自建新会话）。 */
export async function resumeJournalGroup(g: JournalGroupRow): Promise<void> {
  let items: JournalItemRow[] = [];
  try {
    items = (await invoke<JournalItemRow[]>("lg_group_items", { gid: g.gid })) ?? [];
  } catch {
    return;
  }
  const todo = items.filter((i) => i.state !== "done" && i.state !== "canceled");
  if (todo.length === 0) {
    await invoke("lg_group_status", { gid: g.gid, status: "done" }).catch(() => {});
    return;
  }
  groupDbStatus.set(g.gid, "active");
  enqueueGroup({
    id: g.gid,
    label: g.label || "目录上传",
    serverId: g.serverId,
    rootId: g.rootId,
    children: todo.map((i) => ({
      name: i.name,
      remotePath: i.remotePath,
      localPath: i.localPath,
      size: i.size,
      // failed 可能因远端已存在（上次已完成但状态没落账）→ 覆盖语义（服务端
      // 覆盖前存版本）；pending/paused 仍按新文件断言（会话命中自动续传，
      // 未命中且真冲突时组"重试"仍可覆盖）。
      baseHash: i.state === "failed" ? "" : "-",
      journalRel: i.relPath,
    })),
  });
}

/** 放弃一个未完成组：作废服务端残留会话（清 staging 碎片）+ 账本置 canceled。 */
export async function abandonJournalGroup(g: JournalGroupRow): Promise<void> {
  let items: JournalItemRow[] = [];
  try {
    items = (await invoke<JournalItemRow[]>("lg_group_items", { gid: g.gid })) ?? [];
  } catch {
    items = [];
  }
  for (const i of items) {
    if (i.sessionId && i.state !== "done") {
      await srvCall(g.serverId, "DELETE", `/api/v1/upload/session?id=${encodeURIComponent(i.sessionId)}`).catch(() => {});
    }
  }
  await invoke("lg_group_status", { gid: g.gid, status: "canceled" }).catch(() => {});
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
