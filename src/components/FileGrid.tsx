// 缩略图网格视图（需求14：可选目录浏览风格——按缩略图）。
import type { FsEntry } from "../lib/types";
import { fmtSize } from "../lib/format";
import { kindIcon, IconEye } from "./icons";

interface Props {
  entries: FsEntry[];
  sel: Set<string>;
  /** path → 缩略图 data URL（null=无缩略图，用类型图标） */
  thumbs: Record<string, string | null>;
  onToggle(e: FsEntry, multi: boolean): void;
  onOpen(e: FsEntry): void;
  /** 右键菜单（0.6.0 需求7），未提供则保持浏览器默认行为 */
  onCtx?(e: FsEntry, x: number, y: number): void;
}

export default function FileGrid(p: Props) {
  return (
    <div className="grid-view">
      {p.entries.map((e) => {
        const thumb = p.thumbs[e.path];
        return (
          <div
            key={e.path}
            className={p.sel.has(e.path) ? "grid-item selected" : "grid-item"}
            onClick={(ev) => p.onToggle(e, ev.ctrlKey || ev.metaKey)}
            onDoubleClick={() => p.onOpen(e)}
            onContextMenu={(ev) => {
              if (!p.onCtx) return;
              ev.preventDefault();
              p.onCtx(e, ev.clientX, ev.clientY);
            }}
            title={e.isDir ? "双击打开；右键菜单" : "双击预览；右键菜单"}
          >
            {!e.isDir && (
              <button className="grid-preview-btn" title="预览" onClick={(ev) => { ev.stopPropagation(); p.onOpen(e); }}>
                <IconEye size={13} />
              </button>
            )}
            <div className="grid-thumb">
              {thumb ? (
                <img src={thumb} alt={e.name} loading="lazy" />
              ) : (
                <span className={`ficon big k-${e.kind}`}>{kindIcon(e.kind, 34)}</span>
              )}
            </div>
            <div className="grid-name" title={e.name}>
              {e.name}
            </div>
            <div className="grid-meta dim">{e.isDir ? "文件夹" : fmtSize(e.size)}</div>
          </div>
        );
      })}
    </div>
  );
}
