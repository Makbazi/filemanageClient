// 文件版本历史与回滚（需求13）。本地与服务端模式均支持。
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { FsEntry, VersionInfo } from "../lib/types";
import { fmtSize, fmtTime } from "../lib/format";
import { Modal, Confirm } from "./Modals";
import { IconHistory, IconRestore, IconTrash } from "./icons";

interface Props {
  entry: FsEntry;
  onClose(): void;
  onRolledBack(): void; // 回滚成功后刷新文件列表
  notify(msg: string): void;
}

export default function VersionsDialog(p: Props) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [rollback, setRollback] = useState<VersionInfo | null>(null);

  const src = api.source();

  async function load() {
    setBusy(true);
    setErr("");
    try {
      setVersions(await src.versionsList(p.entry.path));
    } catch (e) {
      setErr(String(e));
      setVersions([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.entry.path]);

  async function doRollback(v: VersionInfo) {
    setBusy(true);
    setErr("");
    try {
      await src.versionsRollback(p.entry.path, v.id);
      p.notify(`已回滚到 v${v.versionNo}（回滚前内容已自动存为新版本）`);
      setRollback(null);
      await load();
      p.onRolledBack();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRemove(v: VersionInfo) {
    if (!src.versionsRemove) return;
    try {
      await src.versionsRemove(v.id);
      p.notify(`版本 v${v.versionNo} 已删除`);
      await load();
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <Modal title={`版本历史 · ${p.entry.name}`} onClose={p.onClose} width={560}>
      <div className="notice">
        <IconHistory size={14} />
        覆盖上传/导入或回滚时会自动保存旧版本（默认保留最近 10 版），可随时回滚。
      </div>
      {err && <div className="error-bar">{err}</div>}
      {busy && !versions && <div className="empty"><div className="spinner" /> 加载中…</div>}
      {versions && versions.length === 0 && <div className="empty">暂无历史版本</div>}
      {versions && versions.length > 0 && (
        <table className="table compact">
          <thead>
            <tr>
              <th>版本</th>
              <th>大小</th>
              <th>保存时间</th>
              <th style={{ width: 90 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={String(v.id)} className="row">
                <td>v{v.versionNo}</td>
                <td className="dim">{fmtSize(v.size)}</td>
                <td className="dim">{fmtTime(v.createdAt)}</td>
                <td>
                  <div className="row-actions">
                    <button className="mini" title="回滚到此版本" onClick={() => setRollback(v)}>
                      <IconRestore size={13} />
                    </button>
                    {src.versionsRemove && (
                      <button className="mini danger" title="删除此版本" onClick={() => doRemove(v)}>
                        <IconTrash size={13} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rollback && (
        <Confirm
          title={`回滚到 v${rollback.versionNo}？`}
          lines={[`当前内容会先被保存为新版本，然后用 v${rollback.versionNo} 的内容覆盖 ${p.entry.name}。`]}
          onOk={() => doRollback(rollback)}
          onCancel={() => setRollback(null)}
        />
      )}
    </Modal>
  );
}
