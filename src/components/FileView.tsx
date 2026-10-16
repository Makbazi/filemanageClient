// 文件列表页：面包屑 + 操作工具栏 + 筛选/排序栏（需求15/16）+
// 列表/缩略图两种浏览风格（需求14）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { thumbBlobUrl } from "../lib/thumbcache";
import type { FsEntry } from "../lib/types";
import type { SourceCapabilities } from "../lib/datasource";
import { fmtSize, fmtTime, dirParts, kindLabel, toMillis } from "../lib/format";
import { viewableType } from "../lib/preview";
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
  /** 双击=查看（0.1.7：可预览类型主区内联全屏可看；目录进入；其余弹窗） */
  onOpen(entry: FsEntry): void;
  /** 预览按钮：弹窗缩略式（0.1.7 与查看分离） */
  onPreview(entry: FsEntry): void;
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
  /** 右键菜单（需求7）：App 仅在本地模式且有已配置服务端时注入。
   *  0.3.9 需求6：随条目一并交出**当前批量选择**（右键点中的条目在选择集内
   *  时 App 出"上传所选 N 项到远程…"整组菜单项）。 */
  onCtxEntry?(e: FsEntry, x: number, y: number, sel: FsEntry[]): void;
  /** 0.3.9 需求5：批量上传——把选中整组上传到所选服务端（目录走整树上传）。
   *  App 仅在本地模式且有已配置服务端时注入；工具栏 [批量操作] 态显示入口。 */
  onUploadRemote?(entries: FsEntry[]): void;
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
  // —— 0.3.2 网格缩略图视口调度（需求3/5："全量显示 + 可见±2屏预取 + 失败重试"） ——
  // 旧实现三宗罪：slice(0,60) 硬上限（目录大 → 后面的图永远不出图）、失败写死
  // null 永不重试、按 path 键粘住旧图/错误。新实现：
  //  · IntersectionObserver（root=.page 滚动容器，rootMargin 上下各 2 屏）只把
  //    "即将/正在可见"的条目排入队列——图片再多也全量覆盖（滚到哪出到哪）；
  //  · 键 = path@mtime（刷新/覆盖后自动换新键重取）；目录切换整体复位；
  //  · 并发 3；瞬时失败退避 2s/8s/30s 重试 ≤3 轮才落图标（thumbPath 语义：
  //    null=永久无图不重试，throw=瞬时重试）；
  //  · 字节经 thumbcache（≤2GB 内存 LRU blob），滚动回来零磁盘读。
  // 键 = 来源标识 + path@mtime（服务端虚拟根 id 可跨服务端重名，须带 serverId；
  // 与 Rust 媒体缓存键同构）；目录切换整体复位；
  const tkeyOf = (e: FsEntry) => {
    const a = api.active();
    const src = a.kind === "server" ? `${a.serverId ?? ""}|${a.rootId}` : a.rootId;
    return `${src}/${e.path}@${String(e.mtime)}`;
  };
  const thumbKeyOf = (e: FsEntry): string | undefined =>
    !e.isDir && viewableType(e) === "image" ? tkeyOf(e) : undefined;

  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const pageRef = useRef<HTMLDivElement | null>(null);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const queueRef = useRef<string[]>([]);
  const queuedRef = useRef<Set<string>>(new Set()); // 队列成员 O(1) 去重（0.3.5）
  const visibleRef = useRef<Set<string>>(new Set()); // 当前与视口±2屏相交的 tkey（0.3.5 优先级）
  const failedRef = useRef<Set<string>>(new Set()); // 瞬时耗尽（可随再可见重武装），≠永久无图（0.3.5）
  const rearmRef = useRef<Map<string, number>>(new Map()); // 每 key 重武装次数（≤3 防死循环）
  const runningRef = useRef(0);
  const settledRef = useRef<Set<string>>(new Set());
  const attemptsRef = useRef<Map<string, number>>(new Map());
  const entriesRef = useRef<Map<string, FsEntry>>(new Map());
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    setSel(new Set());
    setQ("");
    setKindFilter("");
    setBulk(false); // 0.3.8：换目录/换来源退出批量模式（批量是显式动作）
  }, [p.path, p.rootName, p.isServer]);

  // key→entry 索引（entries 变化即刷新；调度循环据此取条目）
  useEffect(() => {
    const m = new Map<string, FsEntry>();
    for (const e of p.entries) {
      const k = thumbKeyOf(e);
      if (k) m.set(k, e);
    }
    entriesRef.current = m;
    dispatchThumbs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.entries]);

  // 目录/来源切换：队列、结算表、观察器全部复位（防粘旧图、防跨目录串图）
  useEffect(() => {
    setThumbs({});
    queueRef.current = [];
    queuedRef.current = new Set();
    visibleRef.current = new Set();
    failedRef.current = new Set();
    rearmRef.current = new Map();
    // runningRef 不重置：在途 future 结束时各自减一（重置会致负值放大并发）
    settledRef.current = new Set();
    attemptsRef.current = new Map();
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    if (ioRef.current) {
      ioRef.current.disconnect();
      ioRef.current = null;
    }
  }, [p.path, p.rootName, p.isServer]);

  // 卸载清理
  useEffect(() => {
    return () => {
      ioRef.current?.disconnect();
      ioRef.current = null;
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    };
  }, []);

  function settleThumb(key: string, v: string | null) {
    settledRef.current.add(key);
    setThumbs((prev) => ({ ...prev, [key]: v }));
  }

  // 0.3.5 需求1/2：调度改造（Windows 后段全图标 / Linux 缩略图问题的根治）——
  //  ① 视口优先：旧 FIFO 下滚动新进入的格子排在全部预取旧格之后，被大文件
  //    整文件兜底通道饿死（池仅 3）。现在每次取任务优先取仍在视口(±2屏)内的
  //    队首项，滚到哪先出哪。
  //  ②（0.3.6 移除）慢通道隔离：旧 >16MiB 条目并发 ≤1 是为"整文件下载兜底"
  //    设置的限流；srv_thumb 浏览零整文件后 /thumb 响应恒为几十 KB，隔离失去
  //    存在理由，并发统一 3。
  //  ③ 瞬时失败不再永久化：3 轮退避耗尽只落图标（failedRef），单元格再次
  //    进入视口即重武装重入队（每 key ≤3 批，防真坏文件死循环）。
  function dispatchThumbs() {
    while (runningRef.current < 3) {
      const q = queueRef.current;
      let idx = -1;
      let purged = false;
      // 两遍扫描：先取仍在视口(±2屏)内的（滚到哪先出哪），再取预取区的（FIFO）
      for (let pass = 0; pass < 2 && idx < 0; pass++) {
        for (let i = 0; i < q.length; i++) {
          const k = q[i];
          if (settledRef.current.has(k)) {
            q.splice(i, 1);
            queuedRef.current.delete(k);
            purged = true;
            continue;
          }
          if (pass === 0 ? !visibleRef.current.has(k) : false) continue;
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        if (purged) continue; // 剔除了作废项，重扫队列
        break; // 无可运行项（或队列空）
      }
      const key = q.splice(idx, 1)[0];
      queuedRef.current.delete(key);
      const e = entriesRef.current.get(key);
      if (!e) continue; // 条目已被移除（刷新后消失）：丢弃
      if (api.isAnonymous()) {
        // 游客：/thumb 与旧预览通道一律需登录（匿名语义未变）——立即图标，不重试
        settledRef.current.add(key);
        setThumbs((prev) => ({ ...prev, [key]: null }));
        continue;
      }
      runningRef.current++;
      void (async () => {
        try {
          const path = await api.source().thumbPath(e);
          if (!path) {
            settleThumb(key, null); // Rust 明示无缩略图（415/404/413/403 永久面）：图标回退，不重试
            return;
          }
          const url = await thumbBlobUrl(key, path);
          settleThumb(key, url);
        } catch {
          const n = (attemptsRef.current.get(key) ?? 0) + 1;
          attemptsRef.current.set(key, n);
          if (n <= 3) {
            const delay = [2000, 8000, 30000][n - 1];
            const h = window.setTimeout(() => {
              if (!settledRef.current.has(key) && !queuedRef.current.has(key)) {
                queueRef.current.push(key);
                queuedRef.current.add(key);
              }
              dispatchThumbs();
            }, delay);
            timersRef.current.push(h);
          } else {
            // 瞬时耗尽：本轮落图标但不判永久——再次进入视口重武装（0.3.5）
            failedRef.current.add(key);
            setThumbs((prev) => ({ ...prev, [key]: null }));
          }
        } finally {
          runningRef.current--;
          dispatchThumbs();
        }
      })();
    }
  }

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

  // 渲染后把带 data-tkey 的卡片挂进观察器（IO 对当前相交状态会立刻回调一次；
  // 必须在 filtered/groups 之后注册——deps 直接引用这两个派生值）
  useLayoutEffect(() => {
    if (p.viewMode !== "grid") return;
    const root = pageRef.current;
    if (!root) return;
    if (!ioRef.current && typeof IntersectionObserver !== "undefined") {
      ioRef.current = new IntersectionObserver(
        (es) => {
          for (const en of es) {
            const k = (en.target as HTMLElement).dataset.tkey;
            if (!k) continue;
            if (!en.isIntersecting) {
              visibleRef.current.delete(k);
              continue;
            }
            visibleRef.current.add(k);
            if (settledRef.current.has(k) || queuedRef.current.has(k)) continue;
            // 0.3.5：瞬时耗尽的格子再次进入视口 → 重武装重入队（每 key ≤3 批，
            // 真坏/真慢文件也不会无限循环；永久无图 settled(null) 不重入）
            if (failedRef.current.has(k)) {
              const r = (rearmRef.current.get(k) ?? 0) + 1;
              if (r > 3) {
                settledRef.current.add(k);
                continue;
              }
              rearmRef.current.set(k, r);
              failedRef.current.delete(k);
              attemptsRef.current.set(k, 0);
            }
            queueRef.current.push(k);
            queuedRef.current.add(k);
          }
          dispatchThumbs();
        },
        // 上下各预取 2 屏（需求3"向上向下各缓存 2[屏]"）：margin 为 root 高的百分比
        { root, rootMargin: "200% 0px 200% 0px" }
      );
    }
    root.querySelectorAll<HTMLElement>("[data-tkey]").forEach((el) => ioRef.current?.observe(el));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.viewMode, filtered, groups]);

  const selEntries = filtered.filter((e) => sel.has(e.path));

  // 0.3.7 需求5：批量选择升级——复选框列（点框=增量勾选）、Ctrl/Cmd+点=加选、
  // Shift+点=锚点到当前的连续范围选、Ctrl/Cmd+A=全选筛选结果、表头框=全选/清空。
  // 选中集合按 path 存（与旧一致），故批量下载/复制/移动/删除等既有批量操作直接
  // 复用 selEntries，无需改动 App 层操作实现。anchorRef 记录最近一次"非范围"选中
  // 的条目下标（Shift 以它为起点）。
  const anchorRef = useRef<number>(-1);
  // 0.3.8 需求4：批量操作**不再默认开启**——复选框列/Ctrl+A/Shift 范围选/
  // "已选 N 项"状态条全部由工具栏 [批量操作] 按钮进出；默认态单击=单选
  // （重命名/复制/移动/删除等单文件操作路径不变）。退出批量模式即清空选择。
  const [bulk, setBulk] = useState(false);
  const selectAll = () => setSel(new Set(filtered.map((e) => e.path)));
  const clearSel = () => {
    setSel(new Set());
    anchorRef.current = -1;
  };
  const toggleBulk = () => {
    if (bulk) clearSel();
    setBulk(!bulk);
  };
  const toggleOne = (e: FsEntry) =>
    setSel((prev) => {
      const n = new Set(prev);
      const i = filtered.findIndex((x) => x.path === e.path);
      if (n.has(e.path)) n.delete(e.path);
      else n.add(e.path);
      anchorRef.current = i;
      return n;
    });
  // multi=加选(Ctrl)；shift=范围选；二者皆非=单选替换
  const toggle = (e: FsEntry, multi: boolean, shift = false) => {
    const i = filtered.findIndex((x) => x.path === e.path);
    setSel((prev) => {
      if (shift && anchorRef.current >= 0) {
        const [a, b] = [Math.min(anchorRef.current, i), Math.max(anchorRef.current, i)];
        const n = new Set(prev);
        for (let k = a; k <= b && k < filtered.length; k++) n.add(filtered[k].path);
        return n;
      }
      const n = new Set(multi ? prev : []);
      if (n.has(e.path)) n.delete(e.path);
      else n.add(e.path);
      anchorRef.current = i;
      return n;
    });
  };

  // 表头复选框三态（全选/半选/未选）
  const headCbRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!headCbRef.current) return;
    const n = filtered.length;
    const s = filtered.filter((e) => sel.has(e.path)).length;
    headCbRef.current.checked = n > 0 && s === n;
    headCbRef.current.indeterminate = s > 0 && s < n;
  }, [sel, filtered]);

  // Ctrl/Cmd+A 全选（仅批量模式内生效——0.3.8 需求4；且焦点不在输入框）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "a") return;
      if (!bulk) return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector(".modal-mask, .ctx-menu, .viewer")) return;
      ev.preventDefault();
      selectAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, bulk]);

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
        <button className="mini" title="预览" onClick={(ev) => { ev.stopPropagation(); p.onPreview(e); }}>
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
          {/* 0.3.7 需求5 复选框列（0.3.8 需求5…需求4 改版：仅批量模式显示） */}
          {bulk && (
            <th style={{ width: 30 }}>
              <input
                ref={headCbRef}
                type="checkbox"
                className="row-check"
                title="全选/清空本列筛选结果"
                onChange={() => (headCbRef.current?.checked ? selectAll() : clearSel())}
              />
            </th>
          )}
          <th style={{ width: "40%" }}>名称</th>
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
            // 0.3.9 需求4：批量态下单击行=**增量勾选/取消**（等价点勾选框，不清
            // 已选）；Shift=范围选；默认态单击仍=单选替换。
            onClick={(ev) => toggle(e, bulk, bulk && ev.shiftKey)}
            onDoubleClick={() => p.onOpen(e)}
            onContextMenu={(ev) => {
              if (!p.onCtxEntry) return;
              ev.preventDefault();
              p.onCtxEntry(e, ev.clientX, ev.clientY, selEntries);
            }}
            title={
              (e.isDir
                ? "双击打开；单击选择"
                : viewableType(e)
                  ? "双击查看；单击选择"
                  : "双击预览；单击选择") +
              (bulk ? "（增量勾选），Shift+单击范围选" : "（点［批量操作］进入多选）") +
              "；右键菜单"
            }
          >
            {bulk && (
              <td>
                <input
                  type="checkbox"
                  className="row-check"
                  checked={sel.has(e.path)}
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={() => toggleOne(e)}
                  title="勾选加入批量选择"
                />
              </td>
            )}
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
    <div className="page" ref={pageRef}>
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
        {/* 0.3.9 需求5：批量上传——批量态把选中整组（文件+目录）上传到远程 */}
        {p.onUploadRemote && (
          <button
            className="btn"
            disabled={!bulk || !selEntries.length}
            title={bulk ? "把选中项上传到所选服务端（目录按整树上传）" : "进入批量操作后可用"}
            onClick={() => p.onUploadRemote!(selEntries)}
          >
            <IconUpload size={15} /> 上传所选到远程…
          </button>
        )}
        {/* 0.3.8 需求4：批量操作显式开关 + 状态条（仅批量模式） */}
        <button
          className={bulk ? "btn small primary" : "btn small"}
          title={bulk ? "退出批量操作（清空选择）" : "进入批量操作：点行/点框都勾选、Shift 范围选、Ctrl+A 全选"}
          onClick={toggleBulk}
        >
          <IconLayers size={13} /> {bulk ? "退出批量" : "批量操作"}
        </button>
        {bulk && selEntries.length > 0 && (
          <span className="sel-count">
            已选 <b>{selEntries.length}</b> 项
            <button className="btn small" title="Ctrl+A 全选筛选结果" onClick={selectAll}>
              全选
            </button>
            <button className="btn small" onClick={clearSel}>
              取消选择
            </button>
          </span>
        )}
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

      {/* 0.3.9 需求4：批量态点空白区**不再清空**已选（"没点到文件其他已选中的
          被清空"的根因）；清空走状态条［取消选择］/退出批量。默认态维持单击空白取消选择。 */}
      <div className="card table-wrap" onClick={() => { if (!bulk) setSel(new Set()); }}>
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
                  <FileGrid
                    entries={list}
                    sel={sel}
                    thumbs={thumbs}
                    tkeyOf={thumbKeyOf}
                    bulk={bulk}
                    onToggle={toggle}
                    onOpen={p.onOpen}
                    onPreview={p.onPreview}
                    onCtx={p.onCtxEntry ? (e, x, y) => p.onCtxEntry!(e, x, y, selEntries) : undefined}
                  />
                ) : (
                  listBody(list)
                )}
              </div>
            ))}
          </div>
        ) : p.viewMode === "grid" ? (
          <div onClick={(ev) => ev.stopPropagation()}>
            <FileGrid
              entries={filtered}
              sel={sel}
              thumbs={thumbs}
              tkeyOf={thumbKeyOf}
              bulk={bulk}
              onToggle={toggle}
              onOpen={p.onOpen}
              onPreview={p.onPreview}
              onCtx={p.onCtxEntry ? (e, x, y) => p.onCtxEntry!(e, x, y, selEntries) : undefined}
            />
          </div>
        ) : (
          listBody(filtered)
        )}
      </div>
    </div>
  );
}
