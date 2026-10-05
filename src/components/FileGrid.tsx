// 缩略图网格视图（需求14：可选目录浏览风格——按缩略图）。
// 网格缩略图即"预览"的最低一级；双击卡片=查看（0.1.7，主区内联显示）。
import type { FsEntry } from "../lib/types";
import { fmtSize } from "../lib/format";
import { viewableType } from "../lib/preview";
import { kindIcon, IconEye } from "./icons";

interface Props {
  entries: FsEntry[];
  sel: Set<string>;
  /** tkey → 缩略图 src（0.3.2：tkey=path@mtime；值为 thumbcache 内存 LRU 的
   *  blob: URL——字节不再走 asset 协议直挂；undefined=未就绪/null=无缩略图，
   *  用类型图标） */
  thumbs: Record<string, string | null>;
  /** 可出缩略图条目的 tkey（viewableType==="image"），非图像返回 undefined */
  tkeyOf(e: FsEntry): string | undefined;
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
        const tk = p.tkeyOf(e);
        const thumb = tk ? p.thumbs[tk] : undefined;
        return (
          <div
            key={e.path}
            // data-tkey：0.3.2 IntersectionObserver 视口调度锚点（FileView 的
            // IO 只观察带此属性的卡片；上下各 2 屏进入即排队出图）
            data-tkey={tk}
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
