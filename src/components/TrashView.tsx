import type { TrashItem } from "../lib/types";
import { fmtSize, fmtTime } from "../lib/format";
import { IconRestore, IconTrash, kindIcon } from "./icons";

interface Props {
  items: TrashItem[];
  loading: boolean;
  error: string;
  /** 本地模式（自动清理策略本机独立，0.4.0） */
  isLocal: boolean;
  /** 本地回收站保留天数 */
  retentionDays: number;
  onRestore(item: TrashItem): void;
  onRemove(item: TrashItem): void;
  onClear(): void;
  onRefresh(): void;
}

export default function TrashView(p: Props) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>回收站</h2>
          <p className="dim">
            删除的文件会先进入回收站，还原将回到原位置。
            {p.isLocal
              ? `本地条目超过 ${p.retentionDays} 天将自动彻底清理（启动时执行，独立于服务端策略）。`
              : "服务端条目按服务端保留策略自动清理。"}
          </p>
        </div>
        <div className="toolbar-inline">
          <button className="btn" onClick={p.onRefresh}>
            刷新
          </button>
          <button className="btn danger" disabled={!p.items.length} onClick={p.onClear}>
            <IconTrash size={15} /> 清空回收站
          </button>
        </div>
      </div>
      {p.error && <div className="error-bar">{p.error}</div>}
      <div className="card">
        {p.loading ? (
          <div className="empty">
            <div className="spinner" /> 加载中…
          </div>
        ) : p.items.length === 0 ? (
          <div className="empty">回收站是空的</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: "40%" }}>名称</th>
                <th>原路径</th>
                <th>大小</th>
                <th>删除时间</th>
                <th style={{ width: 130 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {p.items.map((t) => (
                <tr key={t.trashId} className="row">
                  <td className="cell-name">
                    <span className={`ficon k-${t.isDir ? "dir" : "other"}`}>
                      {kindIcon(t.isDir ? "dir" : "other")}
                    </span>
                    <span className="fname">{t.name}</span>
                  </td>
                  <td className="dim path-cell">{t.relPath}</td>
                  <td className="dim">{t.isDir ? "-" : fmtSize(t.size)}</td>
                  <td className="dim">{fmtTime(t.deletedAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button className="mini" title="还原" onClick={() => p.onRestore(t)}>
                        <IconRestore size={14} />
                      </button>
                      <button className="mini danger" title="彻底删除" onClick={() => p.onRemove(t)}>
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
