// 传输面板（需求4/5/6）：任务注册表实时进度/速度，支持 暂停→继续 / 取消 / (覆盖)重试。
// 仅入队任务（serverId 非空）带完整参数，可暂停续传；事件自动注册的任务只能取消。
// 0.2.0 需求41：目录上传聚合为一条组行（文件计数进度；动作经 rowActions 走组级 API）。
// 0.3.3 需求4：右下角显隐开关——面板头部"隐藏"收起为悬浮圆钮（带任务数角标），
// 再点圆钮重新弹出（纯前端展示态，不影响队列执行；本会话内记忆）。
// 0.3.5 需求3：终态行（完成/已取消/失败）逐条"隐藏"按钮——仅把该条移出右下角
// 面板（panelHidden 展示标记），传输管理页仍完整保留；任务重新运行自动回到面板。
import { useEffect, useState } from "react";
import { subscribe, rowActions, dismissFromPanel, type TransferTask } from "../lib/transfer";
import { STATUS_LABEL } from "../lib/transtypes";
import { fmtSize } from "../lib/format";
import { IconDownload, IconPause, IconPlay, IconRefresh, IconTransfer, IconUpload, IconX } from "./icons";

export default function TransferPanel() {
  const [all, setAll] = useState<TransferTask[]>([]);
  const [open, setOpen] = useState(true);
  useEffect(() => subscribe(setAll), []);
  const items = all.filter((t) => !t.panelHidden); // 逐条隐藏只影响本面板
  if (items.length === 0) return null;

  if (!open) {
    // 收起态：仅右下角悬浮按钮（点击重新展开面板）
    return (
      <button className="transfer-fab" title="显示传输面板" onClick={() => setOpen(true)}>
        <IconTransfer size={18} />
        <span className="transfer-fab-badge">{items.length}</span>
      </button>
    );
  }

  return (
    <div className="transfer-panel card">
      <div className="transfer-head-row">
        <div className="transfer-head">传输队列（{items.length}）</div>
        <button className="mini" title="隐藏面板（右下角按钮可再次展开）" onClick={() => setOpen(false)}>
          <IconX size={13} />
        </button>
      </div>
      {items.map((t) => {
        const pct = t.total > 0 ? Math.min(100, Math.round((t.sent / t.total) * 100)) : 0;
        const resumable = t.serverId !== "";
        const conflict = t.message.includes("已存在");
        const act = rowActions(t); // 需求41：组行自动选路到组级 API
        return (
          <div key={t.id} className="transfer-item">
            <div className="transfer-row">
              <span className="transfer-icon">
                {t.kind === "upload" ? <IconUpload size={13} /> : <IconDownload size={13} />}
              </span>
              <span className="transfer-name" title={t.name}>
                {t.name}
              </span>
              <span className={`transfer-status s-${t.status}`}>
                {STATUS_LABEL[t.status]}
                {t.status === "running" && t.speed > 0 ? ` · ${fmtSize(t.speed)}/s` : ""}
              </span>
              {t.status === "running" && resumable && (
                <button className="mini" title="暂停（保留进度，可继续）" onClick={() => void act.pause()}>
                  <IconPause size={13} />
                </button>
              )}
              {t.status === "paused" && resumable && (
                <button className="mini" title={t.isGroup ? "继续（整组断点续传）" : "继续（断点续传）"} onClick={() => act.resume()}>
                  <IconPlay size={13} />
                </button>
              )}
              {t.status === "error" && resumable && (
                <button
                  className="mini"
                  title={t.isGroup ? "重试失败文件（冲突文件按覆盖重试）" : conflict ? "覆盖重试（服务端覆盖前先存版本）" : "重试"}
                  onClick={() => (conflict ? act.overwriteRetry() : act.retry())}
                >
                  <IconRefresh size={13} />
                </button>
              )}
              {(t.status === "running" || t.status === "queued") && (
                <button className="mini danger" title={t.isGroup ? "取消整组" : "取消"} onClick={() => void act.cancel()}>
                  <IconX size={13} />
                </button>
              )}
              {(t.status === "done" || t.status === "cancelled" || t.status === "error") && (
                <button className="mini" title="从面板隐藏（传输管理页仍保留该记录）" onClick={() => dismissFromPanel(t.id)}>
                  <IconX size={13} />
                </button>
              )}
            </div>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${t.status === "done" ? 100 : pct}%` }} />
            </div>
            <div className="transfer-meta dim">
              {fmtSize(t.sent)} / {t.total > 0 ? fmtSize(t.total) : "?"}
              {t.isGroup ? ` · ${t.files}/${t.filesTotal} 个文件` : ` · ${pct}%`}
              {t.message && t.status !== "running" ? ` · ${t.message}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
