// 传输管理页（0.6.0 需求4/5/6）：任务注册表全量视图——
// 暂停→断点续传 / 失败重试 / 冲突覆盖重试 / 取消 / 移除 / 清除已完成。
// 与 TransferPanel（浮出小窗）共用 transfer.ts 注册表与 STATUS_LABEL。
// 0.2.0 需求41：目录上传聚合为一条组行（文件计数；动作经 rowActions 走组级 API，
// 移除/清除已完成会级联清理子任务）。
// 0.3.2：未完成上传账本——重启后进程内任务丢失，这里从 localdb 账本列出
// "未完成的目录上传组"，[继续]=重建子任务走会话续传+相同跳过，[放弃]=作废
// 服务端残留会话（清 staging 碎片）。
import { useCallback, useEffect, useState } from "react";
import {
  subscribe,
  rowActions,
  removeTask,
  clearFinished,
  listJournalPending,
  resumeJournalGroup,
  abandonJournalGroup,
  type JournalGroupRow,
  type TransferTask,
} from "../lib/transfer";
import { STATUS_LABEL } from "../lib/transtypes";
import type { AppConfig } from "../lib/types";
import { fmtSize } from "../lib/format";
import { IconDownload, IconPause, IconPlay, IconRefresh, IconTrash, IconUpload, IconX } from "./icons";

interface Props {
  cfg: AppConfig;
}

export default function TransfersView(p: Props) {
  const [tasks, setTasks] = useState<TransferTask[]>([]);
  useEffect(() => subscribe(setTasks), []);
  // 未完成账本组（挂载即查；操作后刷新）
  const [journal, setJournal] = useState<JournalGroupRow[]>([]);
  const refreshJournal = useCallback(() => {
    void listJournalPending().then(setJournal);
  }, []);
  useEffect(() => {
    refreshJournal();
  }, [refreshJournal]);
  const serverName = (id: string) => p.cfg.servers.find((s) => s.id === id)?.name ?? id;
  const hasFinished = tasks.some((t) => t.status === "done" || t.status === "cancelled");
  // 需求6：上传/下载在同一界面，可筛选区分
  const [kindF, setKindF] = useState<"all" | "upload" | "download">("all");
  const shown = kindF === "all" ? tasks : tasks.filter((t) => t.kind === kindF);
  const nUp = tasks.filter((t) => t.kind === "upload").length;
  const nDn = tasks.length - nUp;
  const kindBtn = (k: "all" | "upload" | "download", label: string) => (
    <button className={kindF === k ? "chip active" : "chip"} onClick={() => setKindF(k)}>
      {label}
    </button>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>传输</h2>
          <p className="dim">
            服务端上传/下载统一管理：暂停保留进度（上传保服务端会话、下载保 .part），可断点续传；
            失败可重试，覆盖冲突可覆盖重试（服务端覆盖前先存历史版本）。事件直达的本地导入/导出仅展示不可续传。
          </p>
        </div>
        <div className="toolbar-inline">
          <span className="kind-chips">
            {kindBtn("all", `全部 ${tasks.length}`)}
            {kindBtn("upload", `上传 ${nUp}`)}
            {kindBtn("download", `下载 ${nDn}`)}
          </span>
          <button className="btn" disabled={!hasFinished} onClick={clearFinished}>
            <IconTrash size={15} /> 清除已完成
          </button>
        </div>
      </div>
      {journal.filter((g) => !tasks.some((t) => t.id === g.gid)).length > 0 && (
        <div className="card">
          <div className="page-head">
            <p className="dim">未完成的上传（上次退出/中断遗留，可从断点继续；已传相同的文件自动跳过）</p>
          </div>
          {journal
            .filter((g) => !tasks.some((t) => t.id === g.gid))
            .map((g) => (
              <div key={g.gid} className="journal-row">
                <span className="ficon k-other">
                  <IconUpload size={14} />
                </span>
                <span className="journal-label" title={`${g.localAbs} → ${serverName(g.serverId)}/${g.remotePrefix}`}>
                  {g.label || g.remotePrefix} <span className="dim">→ {serverName(g.serverId)}</span>
                </span>
                <span className="dim">
                  {g.doneFiles}/{g.totalFiles} 个文件
                </span>
                <button
                  className="btn small primary"
                  onClick={() => {
                    void resumeJournalGroup(g).then(() => setTimeout(refreshJournal, 300));
                  }}
                >
                  继续
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    void abandonJournalGroup(g).then(refreshJournal);
                  }}
                >
                  放弃
                </button>
              </div>
            ))}
        </div>
      )}
      {tasks.length === 0 ? (
        <div className="card">
          <div className="empty">暂无传输任务</div>
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 56 }}>方向</th>
                <th style={{ width: "24%" }}>名称</th>
                <th>来源</th>
                <th style={{ width: 70 }}>状态</th>
                <th style={{ width: 150 }}>进度</th>
                <th style={{ width: 90 }}>速度</th>
                <th>说明</th>
                <th style={{ width: 150 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const pct = t.total > 0 ? Math.min(100, Math.round((t.sent / t.total) * 100)) : 0;
                const resumable = t.serverId !== ""; // 入队任务参数完整才可暂停/续传/重试
                const conflict = t.message.includes("已存在");
                const removable = t.status !== "running" && t.status !== "queued";
                const act = rowActions(t); // 需求41：组行自动选路到组级 API
                return (
                  <tr key={t.id} className="row">
                    <td className="dim">{t.kind === "upload" ? "上传" : "下载"}</td>
                    <td className="cell-name">
                      <span className="ficon k-other">
                        {t.kind === "upload" ? <IconUpload size={14} /> : <IconDownload size={14} />}
                      </span>
                      <span className="fname" title={`${t.remotePath || t.name} ⇄ ${t.localPath}`}>
                        {t.name}
                      </span>
                    </td>
                    <td className="dim">
                      {resumable ? serverName(t.serverId) : t.kind === "upload" ? "本地导入" : "本地导出"}
                    </td>
                    <td>
                      <span className={`transfer-status s-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    </td>
                    <td>
                      <div className="progress">
                        <div className="progress-bar" style={{ width: `${t.status === "done" ? 100 : pct}%` }} />
                      </div>
                      <div className="transfer-meta dim">
                        {fmtSize(t.sent)} / {t.total > 0 ? fmtSize(t.total) : "?"}
                        {t.isGroup ? ` · ${t.files}/${t.filesTotal} 个文件` : ` · ${pct}%`}
                      </div>
                    </td>
                    <td className="dim">{t.status === "running" && t.speed > 0 ? `${fmtSize(t.speed)}/s` : "-"}</td>
                    <td className="dim path-cell" title={t.message}>
                      {t.message}
                    </td>
                    <td>
                      <div className="row-actions">
                        {t.status === "running" && resumable && (
                          <button className="mini" title="暂停（保留进度，可继续）" onClick={() => void act.pause()}>
                            <IconPause size={14} />
                          </button>
                        )}
                        {t.status === "paused" && resumable && (
                          <button className="mini" title={t.isGroup ? "继续（整组断点续传）" : "继续（断点续传）"} onClick={() => act.resume()}>
                            <IconPlay size={14} />
                          </button>
                        )}
                        {t.status === "error" && resumable && (
                          <button
                            className="mini"
                            title={t.isGroup ? "重试失败文件（冲突文件按覆盖重试）" : conflict ? "覆盖重试（服务端覆盖前先存版本）" : "重试"}
                            onClick={() => (conflict ? act.overwriteRetry() : act.retry())}
                          >
                            <IconRefresh size={14} />
                          </button>
                        )}
                        {(t.status === "running" || t.status === "queued") && (
                          <button className="mini danger" title={t.isGroup ? "取消整组" : "取消"} onClick={() => void act.cancel()}>
                            <IconX size={14} />
                          </button>
                        )}
                        {removable && (
                          <button className="mini danger" title="从列表移除" onClick={() => removeTask(t.id)}>
                            <IconTrash size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="dim">
                    无符合筛选的任务
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
