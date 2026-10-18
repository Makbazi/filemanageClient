// "上传到远程"对话框（需求7）：勾选一个/多个服务端，文件上传到各自的分配根目录；
// 未登录或无可见目录的服务端不可勾选；多根服务端可选目标目录。提交后由传输队列执行。
// 0.2.0 需求41：目录条目为整树上传——重建到所选根下的同名子目录（<目录名>/…）。
// 0.3.9 需求5/6：改收**条目数组**（批量上传整组选择；单项=长度 1）。
import { useEffect, useState } from "react";
import type { AppConfig, FsEntry, ServerRoot } from "../lib/types";
import * as api from "../lib/api";
import { Modal } from "./Modals";
import { IconUpload } from "./icons";

interface Props {
  cfg: AppConfig;
  entries: FsEntry[];
  onCancel(): void;
  onSubmit(targets: { serverId: string; rootId: string }[]): void;
}

export default function UploadToDialog(p: Props) {
  const multi = p.entries.length > 1;
  const isDir = !!p.entries[0]?.isDir && !multi; // 目录整树上传文案仅单项时贴合
  const fileName = multi ? `${p.entries.length} 项` : p.entries[0]?.name ?? "";
  const [roots, setRoots] = useState<Record<string, ServerRoot[]>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rootSel, setRootSel] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    p.cfg.servers.forEach((s) => {
      if (!s.token) return;
      api
        .fetchRoots(s.id)
        .then((rs) => {
          if (cancelled) return;
          const list = rs ?? [];
          setRoots((prev) => ({ ...prev, [s.id]: list }));
          setRootSel((prev) => ({ ...prev, [s.id]: list[0]?.id ?? "" }));
        })
        .catch(() => {
          if (!cancelled) setRoots((prev) => ({ ...prev, [s.id]: [] }));
        });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const submit = () => {
    const targets = [...picked]
      .map((sid) => ({ serverId: sid, rootId: rootSel[sid] || roots[sid]?.[0]?.id || "" }))
      .filter((t) => t.rootId);
    if (targets.length) p.onSubmit(targets);
  };

  return (
    <Modal
      title={`${isDir ? "上传目录到远程" : multi ? "批量上传到远程" : "上传到远程"} · ${fileName}`}
      onClose={p.onCancel}
      width={460}
    >
      {p.cfg.servers.length === 0 ? (
        <div className="dim tip">尚未配置服务端，请先在设置 → 服务端中添加。</div>
      ) : (
        p.cfg.servers.map((s) => {
          const loaded = s.id in roots;
          const rs = roots[s.id] ?? [];
          const usable = !!s.token && loaded && rs.length > 0;
          return (
            <div className="list-row" key={s.id}>
              <label className="radio-item">
                <input type="checkbox" disabled={!usable} checked={picked.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                <span>{s.name || s.baseUrl}</span>
              </label>
              {!s.token ? (
                <span className="badge">未登录，不可上传</span>
              ) : !loaded ? (
                <span className="dim">加载目录…</span>
              ) : rs.length === 0 ? (
                <span className="badge">无可见目录</span>
              ) : rs.length > 1 ? (
                <select className="sort-select" value={rootSel[s.id] ?? ""} onChange={(e) => setRootSel((prev) => ({ ...prev, [s.id]: e.target.value }))}>
                  {rs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="dim">{rs[0].name}</span>
              )}
            </div>
          );
        })
      )}
      <div className="dim tip">
        {isDir
          ? `目录结构将整树复制到所选服务端的根目录下（${fileName}/…，含空目录；符号链接不上传；同名文件冲突可在"传输"界面整组重试覆盖）。`
          : multi
            ? `所选 ${p.entries.length} 项将上传到所选服务端的根目录（其中目录按整树上传）；同名冲突可在"传输"界面用覆盖重试。`
            : "文件将上传到所选服务端的根目录（同名冲突可在\"传输\"界面用覆盖重试）。"}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={p.onCancel}>
          取消
        </button>
        <button className="btn primary" disabled={!picked.size} onClick={submit}>
          <IconUpload size={14} /> 上传{isDir ? "目录" : multi ? ` ${p.entries.length} 项` : ""}到 {picked.size} 个服务端
        </button>
      </div>
    </Modal>
  );
}
