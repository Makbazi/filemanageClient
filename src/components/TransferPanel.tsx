// 传输面板（0.6.0 需求4/5/6）：任务注册表实时进度/速度，支持 暂停→继续 / 取消 / (覆盖)重试。
// 仅入队任务（serverId 非空）带完整参数，可暂停续传；事件自动注册的任务只能取消。
import { useEffect, useState } from "react";
import { subscribe, cancelTask, pauseTask, resumeTask, overwriteRetry, type TransferTask } from "../lib/transfer";
import { STATUS_LABEL } from "../lib/transtypes";
import { fmtSize } from "../lib/format";
import { IconDownload, IconPause, IconPlay, IconRefresh, IconUpload, IconX } from "./icons";

export default function TransferPanel() {
  const [items, setItems] = useState<TransferTask[]>([]);
  useEffect(() => subscribe(setItems), []);
  if (items.length === 0) return null;

  return (
    <div className="transfer-panel card">
      <div className="transfer-head">传输队列（{items.length}）</div>
      {items.map((t) => {
        const pct = t.total > 0 ? Math.min(100, Math.round((t.sent / t.total) * 100)) : 0;
        const resumable = t.serverId !== "";
        const conflict = t.message.includes("已存在");
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
                <button className="mini" title="暂停（保留进度，可继续）" onClick={() => void pauseTask(t.id)}>
                  <IconPause size={13} />
                </button>
              )}
              {t.status === "paused" && resumable && (
                <button className="mini" title="继续（断点续传）" onClick={() => resumeTask(t.id)}>
                  <IconPlay size={13} />
                </button>
              )}
              {t.status === "error" && resumable && (
                <button
                  className="mini"
                  title={conflict ? "覆盖重试（服务端覆盖前先存版本）" : "重试"}
                  onClick={() => (conflict ? overwriteRetry(t.id) : resumeTask(t.id))}
                >
                  <IconRefresh size={13} />
                </button>
              )}
              {(t.status === "running" || t.status === "queued") && (
                <button className="mini danger" title="取消" onClick={() => void cancelTask(t.id)}>
                  <IconX size={13} />
                </button>
              )}
            </div>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${t.status === "done" ? 100 : pct}%` }} />
            </div>
            <div className="transfer-meta dim">
              {fmtSize(t.sent)} / {t.total > 0 ? fmtSize(t.total) : "?"} · {pct}%
              {t.message && t.status !== "running" ? ` · ${t.message}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
