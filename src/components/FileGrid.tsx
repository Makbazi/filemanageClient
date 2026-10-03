// 缩略图网格视图（需求14：可选目录浏览风格——按缩略图）。
// 网格缩略图即"预览"的最低一级；双击卡片=查看（0.1.7，主区内联显示）。
import type { FsEntry } from "../lib/types";
import { fmtSize } from "../lib/format";
import { viewableType } from "../lib/preview";
import { kindIcon, IconEye } from "./icons";

interface Props {
  entries: FsEntry[];
  sel: Set<string>;
  /** path → 缩略图 src（0.2.1：媒体缓存 ≤512px 图的 asset URL，RAW 为内嵌
   *  预览提取缩放；null=无缩略图，用类型图标） */
  thumbs: Record<string, string | null>;
  onToggle(e: FsEntry, multi: boolean): void;
  /** 双击=查看 */
  onOpen(e: FsEntry): void;
  /** 角标眼睛按钮=预览弹窗 */
  onPreview(e: FsEntry): void;
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
            title={e.isDir ? "双击打开；右键菜单" : viewableType(e) ? "双击查看；右键菜单" : "双击预览；右键菜单"}
          >
            {!e.isDir && (
              <button className="grid-preview-btn" title="预览" onClick={(ev) => { ev.stopPropagation(); p.onPreview(e); }}>
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
