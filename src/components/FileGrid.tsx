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
  /** 0.3.8 需求4：批量模式开关（FileView 工具栏控制）——非批量态隐藏勾选框、
   *  单击=单选替换、Ctrl/Shift 修饰无效 */
  bulk?: boolean;
  /** 0.3.7 需求5：multi=Ctrl/Cmd 加选；shift=范围选 */
  onToggle(e: FsEntry, multi: boolean, shift?: boolean): void;
  /** 双击=查看 */
  onOpen(e: FsEntry): void;
  /** 角标眼睛按钮=预览弹窗 */
  onPreview(e: FsEntry): void;
  /** 右键菜单（需求7），未提供则保持浏览器默认行为 */
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
            onClick={(ev) => p.onToggle(e, !!p.bulk && (ev.ctrlKey || ev.metaKey), !!p.bulk && ev.shiftKey)}
            onDoubleClick={() => p.onOpen(e)}
            onContextMenu={(ev) => {
              if (!p.onCtx) return;
              ev.preventDefault();
              p.onCtx(e, ev.clientX, ev.clientY);
            }}
            title={
              (e.isDir
                ? "双击打开；单击选择"
                : viewableType(e)
                  ? "双击查看；单击选择"
                  : "双击预览；单击选择") +
              (p.bulk ? "，Shift+单击范围选，Ctrl+单击加选" : "") +
              "；右键菜单"
            }
          >
            {/* 0.3.7 需求5 勾选框（0.3.8 需求4：仅批量模式显示） */}
            {p.bulk && (
              <input
                type="checkbox"
                className="grid-check"
                checked={p.sel.has(e.path)}
                onClick={(ev) => ev.stopPropagation()}
                onChange={() => p.onToggle(e, true)}
                title="勾选加入批量选择"
              />
            )}
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
