// 文件列表页：面包屑 + 操作工具栏 + 筛选/排序栏（需求15/16）+
// 列表/缩略图两种浏览风格（需求14）。
import { useEffect, useMemo, useState } from "react";
import type { FsEntry } from "../lib/types";
import type { SourceCapabilities } from "../lib/datasource";
import { fmtSize, fmtTime, dirParts, kindLabel, toMillis } from "../lib/format";
import * as api from "../lib/api";
import {
  kindIcon,
  IconFolder,
  IconChevronRight,
  IconHome,
  IconDownload,
  IconUpload,
  IconPencil,
  IconCopy,
  IconMove,
  IconTrash,
  IconRefresh,
  IconSparkles,
  IconList,
  IconGrid,
  IconLayers,
  IconFilter,
  IconLink,
  IconShield,
  IconHistory,
  IconLock,
  IconEye,
} from "./icons";
import FileGrid from "./FileGrid";

interface Props {
  path: string;
  rootName: string;
  entries: FsEntry[];
  loading: boolean;
  error: string;
  isServer: boolean;
  /** 游客只读（需求6） */
  anonymous: boolean;
  caps: SourceCapabilities;
  aiReady: boolean;
  viewMode: "list" | "grid";
  onViewMode(m: "list" | "grid"): void;
  groupByKind: boolean;
  onGroupByKind(v: boolean): void;
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
  onShare(entry: FsEntry): void;
  onAcl(entry: FsEntry | null): void;
  onVersions(entry: FsEntry): void;
  /** 右键菜单（需求7）：App 仅在本地模式且有已配置服务端时注入 */
  onCtxEntry?(e: FsEntry, x: number, y: number): void;
}

const KIND_ORDER = ["dir", "image", "video", "audio", "document", "archive", "code", "other"];
const KIND_CHIPS: [string, string][] = [
  ["", "全部"],
  ...KIND_ORDER.map((k) => [k, kindLabel[k] ?? k]) as [string, string][],
];

export default function FileView(p: Props) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [sortField, setSortField] = useState<"name" | "size" | "mtime">("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});

  useEffect(() => {
    setSel(new Set());
    setQ("");
    setKindFilter("");
  }, [p.path, p.rootName, p.isServer]);

  // 网格视图缩略图懒加载（仅图像、限前 60 个）
  useEffect(() => {
    if (p.viewMode !== "grid") return;
    let cancelled = false;
    const src = api.source();
    const targets = p.entries.filter((e) => e.kind === "image" && e.size <= 8 << 20).slice(0, 60);
    targets.forEach(async (e) => {
      if (thumbs[e.path] !== undefined) return;
      const d = await src.thumbData(e).catch(() => null);
      if (!cancelled) setThumbs((prev) => ({ ...prev, [e.path]: d }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.viewMode, p.entries]);

  const filtered = useMemo(() => {
    const lq = q.trim().toLowerCase();
    let out = p.entries.filter((e) => {
      if (lq && !e.name.toLowerCase().includes(lq)) return false;
      if (kindFilter && e.kind !== kindFilter) return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 目录始终在前
      let r = 0;
      if (sortField === "name") r = a.name.localeCompare(b.name, "zh-CN");
      else if (sortField === "size") r = a.size - b.size;
      else r = toMillis(a.mtime) - toMillis(b.mtime);
      return sortAsc ? r : -r;
    });
    return out;
  }, [p.entries, q, kindFilter, sortField, sortAsc]);

  const groups = useMemo(() => {
    if (!p.groupByKind) return null;
    const map = new Map<string, FsEntry[]>();
    for (const e of filtered) {
      const arr = map.get(e.kind) ?? [];
      arr.push(e);
      map.set(e.kind, arr);
    }
    return KIND_ORDER.filter((k) => map.has(k)).map((k) => [k, map.get(k)!] as [string, FsEntry[]]);
  }, [filtered, p.groupByKind]);

  const selEntries = filtered.filter((e) => sel.has(e.path));
  const toggle = (e: FsEntry, multi: boolean) => {
    setSel((prev) => {
      const n = new Set(multi ? prev : []);
      if (n.has(e.path)) n.delete(e.path);
      else n.add(e.path);
      return n;
    });
  };

  const crumbs = dirParts(p.path);
  const readOnly = p.anonymous;
  const roTip = readOnly ? "游客模式只读，登录后才能修改（需求：远程必须登录）" : undefined;

  const rowActions = (e: FsEntry) => (
    <div className="row-actions">
      {!e.isDir && p.aiReady && (
        <button className="mini" title="AI 生成描述" onClick={(ev) => { ev.stopPropagation(); p.onDescribe(e); }}>
          <IconSparkles size={14} />
        </button>
      )}
      {!e.isDir && (
        <button className="mini" title="预览" onClick={(ev) => { ev.stopPropagation(); p.onOpen(e); }}>
          <IconEye size={14} />
        </button>
      )}
      {!e.isDir && (
        <button
          className="mini"
          title={readOnly ? "游客模式需登录才能下载" : "下载到本机"}
          disabled={readOnly}
          onClick={(ev) => { ev.stopPropagation(); p.onDownload([e]); }}
        >
          <IconDownload size={14} />
        </button>
      )}
      {p.caps.versions && !e.isDir && !readOnly && (
        <button className="mini" title="版本历史/回滚" onClick={(ev) => { ev.stopPropagation(); p.onVersions(e); }}>
          <IconHistory size={14} />
        </button>
      )}
      {p.caps.share && !readOnly && (
        <button className="mini" title="生成临时分享链接" onClick={(ev) => { ev.stopPropagation(); p.onShare(e); }}>
          <IconLink size={14} />
        </button>
      )}
      {p.caps.acl && !readOnly && (
        <button className="mini" title="权限与分享设置" onClick={(ev) => { ev.stopPropagation(); p.onAcl(e); }}>
          <IconShield size={14} />
        </button>
      )}
      {!readOnly && (
        <button className="mini danger" title="删除（回收站）" onClick={(ev) => { ev.stopPropagation(); p.onDelete([e]); }}>
          <IconTrash size={14} />
        </button>
      )}
    </div>
  );

  const listBody = (entries: FsEntry[]) => (
    <table className="table" onClick={(ev) => ev.stopPropagation()}>
      <thead>
        <tr>
          <th style={{ width: "42%" }}>名称</th>
          <th>大小</th>
          <th>修改时间</th>
          <th style={{ width: 170 }}>操作</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr
            key={e.path}
            className={sel.has(e.path) ? "row selected" : "row"}
            onClick={(ev) => toggle(e, ev.ctrlKey || ev.metaKey)}
            onDoubleClick={() => p.onOpen(e)}
            onContextMenu={(ev) => {
              if (!p.onCtxEntry) return;
              ev.preventDefault();
              p.onCtxEntry(e, ev.clientX, ev.clientY);
            }}
            title={e.isDir ? "双击打开；Ctrl+单击多选；右键菜单" : "双击预览；Ctrl+单击多选；右键菜单"}
          >
            <td className="cell-name">
              <span className={`ficon k-${e.kind}`}>{kindIcon(e.kind)}</span>
              <span className="fname">{e.name}</span>
            </td>
            <td className="dim">{e.isDir ? "-" : fmtSize(e.size)}</td>
            <td className="dim">{fmtTime(e.mtime)}</td>
            <td>{rowActions(e)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

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
        <button className="btn" disabled={readOnly} title={roTip} onClick={p.onMkdir}>
          <IconFolder size={15} /> 新建文件夹
        </button>
        <button className="btn" disabled={readOnly} title={roTip} onClick={p.onUpload}>
          <IconUpload size={15} /> {p.isServer ? "上传文件…" : "导入本机文件"}
        </button>
        <div className="tool-sep" />
        <button
          className="btn"
          disabled={!selEntries.length || readOnly}
          title={readOnly ? roTip : undefined}
          onClick={() => p.onDownload(selEntries)}
        >
          <IconDownload size={15} /> 下载
        </button>
        <button className="btn" disabled={readOnly || selEntries.length !== 1} title={roTip} onClick={() => p.onRename(selEntries[0])}>
          <IconPencil size={15} /> 重命名
        </button>
        <button className="btn" disabled={readOnly || !selEntries.length} title={roTip} onClick={() => p.onCopyMove(selEntries, "copy")}>
          <IconCopy size={15} /> 复制
        </button>
        <button className="btn" disabled={readOnly || !selEntries.length} title={roTip} onClick={() => p.onCopyMove(selEntries, "move")}>
          <IconMove size={15} /> 移动
        </button>
        <div className="spacer" />
        {p.caps.acl && !readOnly && (
          <button className="btn" title="当前目录权限与分享设置" onClick={() => p.onAcl(null)}>
            <IconShield size={15} /> 目录权限
          </button>
        )}
        <button className="btn danger" disabled={readOnly || !selEntries.length} title={roTip} onClick={() => p.onDelete(selEntries)}>
          <IconTrash size={15} /> 删除
        </button>
        <button
          className={p.viewMode === "list" ? "icon-btn active" : "icon-btn"}
          title="按行浏览"
          onClick={() => p.onViewMode("list")}
        >
          <IconList size={16} />
        </button>
        <button
          className={p.viewMode === "grid" ? "icon-btn active" : "icon-btn"}
          title="按缩略图浏览"
          onClick={() => p.onViewMode("grid")}
        >
          <IconGrid size={16} />
        </button>
        <button className="icon-btn" title="刷新" onClick={p.onRefresh}>
          <IconRefresh size={16} />
        </button>
      </div>

      {/* 筛选/排序/分类（需求15/16） */}
      <div className="filter-bar">
        <span className="filter-icon">
          <IconFilter size={14} />
        </span>
        <input className="filter-input" placeholder="筛选当前目录（按名称）…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="kind-chips">
          {KIND_CHIPS.map(([k, label]) => (
            <button key={k} className={kindFilter === k ? "chip active" : "chip"} onClick={() => setKindFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <select
          className="sort-select"
          value={`${sortField}:${sortAsc ? "asc" : "desc"}`}
          onChange={(e) => {
            const [f, d] = e.target.value.split(":");
            setSortField(f as "name" | "size" | "mtime");
            setSortAsc(d === "asc");
          }}
          title="排序"
        >
          <option value="name:asc">名称 ↑</option>
          <option value="name:desc">名称 ↓</option>
          <option value="size:desc">大小 ↓</option>
          <option value="size:asc">大小 ↑</option>
          <option value="mtime:desc">时间 ↓</option>
          <option value="mtime:asc">时间 ↑</option>
        </select>
        <button
          className={p.groupByKind ? "btn small primary" : "btn small"}
          title="按文件类型分组显示（需求15）"
          onClick={() => p.onGroupByKind(!p.groupByKind)}
        >
          <IconLayers size={13} /> 分类
        </button>
      </div>

      {p.error && <div className="error-bar">{p.error}</div>}
      {readOnly && (
        <div className="notice">
          <IconLock size={14} /> 游客模式：可浏览（受目录权限约束），下载/上传/修改/删除需登录。
        </div>
      )}

      <div className="card table-wrap" onClick={() => setSel(new Set())}>
        {p.loading ? (
          <div className="empty">
            <div className="spinner" /> 加载中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty">{p.entries.length === 0 ? "此目录为空" : "无符合筛选条件的条目"}</div>
        ) : groups ? (
          <div className="group-wrap" onClick={(ev) => ev.stopPropagation()}>
            {groups.map(([kind, list]) => (
              <div key={kind} className="kind-group">
                <div className="kind-group-title">
                  <span className={`ficon small k-${kind}`}>{kindIcon(kind, 13)}</span>
                  {kindLabel[kind] ?? kind} · {list.length}
                </div>
                {p.viewMode === "grid" ? (
                  <FileGrid entries={list} sel={sel} thumbs={thumbs} onToggle={toggle} onOpen={p.onOpen} onCtx={p.onCtxEntry} />
                ) : (
                  listBody(list)
                )}
              </div>
            ))}
          </div>
        ) : p.viewMode === "grid" ? (
          <div onClick={(ev) => ev.stopPropagation()}>
            <FileGrid entries={filtered} sel={sel} thumbs={thumbs} onToggle={toggle} onOpen={p.onOpen} onCtx={p.onCtxEntry} />
          </div>
        ) : (
          listBody(filtered)
        )}
      </div>
    </div>
  );
}
