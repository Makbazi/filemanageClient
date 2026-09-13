import { useEffect, useState } from "react";
import type { FsEntry } from "../lib/types";
import { fmtSize, fmtTime, dirParts } from "../lib/format";
import { kindIcon, IconFolder, IconChevronRight, IconHome, IconDownload, IconUpload, IconPencil, IconCopy, IconMove, IconTrash, IconRefresh, IconSparkles } from "./icons";

interface Props {
  path: string; // 当前相对路径（"" 为根）
  rootName: string;
  entries: FsEntry[];
  loading: boolean;
  error: string;
  isServer: boolean;
  aiReady: boolean;
  onOpen(entry: FsEntry): void;
  onBreadcrumb(path: string): void;
  onRefresh(): void;
  onMkdir(): void;
  onUpload(): void;
  onDownload(entries: FsEntry[]): void;
  onRename(entry: FsEntry): void;
  onCopyMove(entries: FsEntry[], mode: "copy" | "move"): void;
  onDelete(entries: FsEntry[]): void;
  onDescribe(entry: FsEntry): void;
}

export default function FileView(p: Props) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => setSel(new Set()), [p.path, p.rootName, p.isServer]);

  const selEntries = p.entries.filter((e) => sel.has(e.path));
  const toggle = (e: FsEntry, multi: boolean) => {
    setSel((prev) => {
      const n = new Set(multi ? prev : []);
      if (n.has(e.path)) n.delete(e.path);
      else n.add(e.path);
      return n;
    });
  };

  const crumbs = dirParts(p.path);

  return (
    <div className="page">
      <div className="crumbs">
        <button className="crumb" onClick={() => p.onBreadcrumb("")}>
          <IconHome size={14} /> {p.rootName}
        </button>
        {crumbs.map((c) => (
          <span key={c.path} className="crumb-wrap">
            <IconChevronRight size={13} />
            <button className="crumb" onClick={() => p.onBreadcrumb(c.path)}>
              {c.name}
            </button>
          </span>
        ))}
      </div>

      <div className="toolbar">
        <button className="btn" onClick={p.onMkdir}>
          <IconFolder size={15} /> 新建文件夹
        </button>
        <button className="btn" onClick={p.onUpload}>
          <IconUpload size={15} /> {p.isServer ? "上传文件…" : "导入本机文件"}
        </button>
        <div className="tool-sep" />
        <button className="btn" disabled={!selEntries.length} onClick={() => p.onDownload(selEntries)}>
          <IconDownload size={15} /> 下载
        </button>
        <button className="btn" disabled={selEntries.length !== 1} onClick={() => p.onRename(selEntries[0])}>
          <IconPencil size={15} /> 重命名
        </button>
        <button className="btn" disabled={!selEntries.length} onClick={() => p.onCopyMove(selEntries, "copy")}>
          <IconCopy size={15} /> 复制
        </button>
        <button className="btn" disabled={!selEntries.length} onClick={() => p.onCopyMove(selEntries, "move")}>
          <IconMove size={15} /> 移动
        </button>
        <div className="spacer" />
        <button
          className="btn danger"
          disabled={!selEntries.length}
          onClick={() => p.onDelete(selEntries)}
        >
          <IconTrash size={15} /> 删除
        </button>
        <button className="icon-btn" title="刷新" onClick={p.onRefresh}>
          <IconRefresh size={16} />
        </button>
      </div>

      {p.error && <div className="error-bar">{p.error}</div>}

      <div className="card table-wrap" onClick={() => setSel(new Set())}>
        {p.loading ? (
          <div className="empty">
            <div className="spinner" /> 加载中…
          </div>
        ) : p.entries.length === 0 ? (
          <div className="empty">此目录为空</div>
        ) : (
          <table className="table" onClick={(e) => e.stopPropagation()}>
            <thead>
              <tr>
                <th style={{ width: "46%" }}>名称</th>
                <th>大小</th>
                <th>修改时间</th>
                <th style={{ width: 90 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {p.entries.map((e) => (
                <tr
                  key={e.path}
                  className={sel.has(e.path) ? "row selected" : "row"}
                  onClick={(ev) => toggle(e, ev.ctrlKey || ev.metaKey)}
                  onDoubleClick={() => p.onOpen(e)}
                  title={e.isDir ? "双击打开；Ctrl+单击多选" : "双击预览；Ctrl+单击多选"}
                >
                  <td className="cell-name">
                    <span className={`ficon k-${e.kind}`}>{kindIcon(e.kind)}</span>
                    <span className="fname">{e.name}</span>
                  </td>
                  <td className="dim">{e.isDir ? "-" : fmtSize(e.size)}</td>
                  <td className="dim">{fmtTime(e.mtime)}</td>
                  <td>
                    <div className="row-actions">
                      {!e.isDir && (
                        <button
                          className="mini"
                          title="AI 生成描述"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            p.onDescribe(e);
                          }}
                        >
                          <IconSparkles size={14} />
                        </button>
                      )}
                      {p.isServer && !e.isDir && (
                        <button
                          className="mini"
                          title="下载到本机"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            p.onDownload([e]);
                          }}
                        >
                          <IconDownload size={14} />
                        </button>
                      )}
                      <button
                        className="mini danger"
                        title="删除（回收站）"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          p.onDelete([e]);
                        }}
                      >
                        <IconTrash size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
