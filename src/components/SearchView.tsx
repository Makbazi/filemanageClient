// 高级搜索页（需求12）：按文件名/类型/大小/修改时间搜索。
import { useState } from "react";
import type { FsEntry, SearchFilters } from "../lib/types";
import { fmtSize, fmtTime, kindLabel, parentOf } from "../lib/format";
import * as api from "../lib/api";
import { kindIcon, IconSearch } from "./icons";

interface Props {
  /** 双击=查看（0.1.7：可预览类型主区内联覆盖显示，搜索结果列表状态保留） */
  onOpen(e: FsEntry): void;
  /** "预览"按钮=弹窗缩略式 */
  onPreview(e: FsEntry): void;
  /** 定位到文件所在目录 */
  onLocate(e: FsEntry): void;
}

const KINDS: [string, string][] = [
  ["image", "图像"],
  ["video", "视频"],
  ["audio", "音频"],
  ["document", "文档"],
  ["archive", "压缩包"],
  ["code", "代码"],
  ["other", "其他"],
];

const SIZE_UNITS = [
  ["B", 1],
  ["KB", 1024],
  ["MB", 1024 * 1024],
  ["GB", 1024 * 1024 * 1024],
] as const;

export default function SearchView(p: Props) {
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [sizeMin, setSizeMin] = useState("");
  const [sizeMax, setSizeMax] = useState("");
  const [unit, setUnit] = useState<number>(1024 * 1024);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [res, setRes] = useState<FsEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const toggleKind = (k: string) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const hasCondition =
    query.trim() || kinds.length || sizeMin || sizeMax || dateFrom || dateTo;

  async function run() {
    if (!hasCondition) return;
    setBusy(true);
    setErr("");
    const f: SearchFilters = {
      query: query.trim(),
      kinds,
      sizeMin: sizeMin ? Number(sizeMin) * unit : undefined,
      sizeMax: sizeMax ? Number(sizeMax) * unit : undefined,
      mtimeFrom: dateFrom ? new Date(dateFrom + "T00:00:00").getTime() : undefined,
      mtimeTo: dateTo ? new Date(dateTo + "T23:59:59").getTime() : undefined,
    };
    try {
      setRes(await api.source().search(f));
    } catch (e) {
      setErr(String(e));
      setRes([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="search-hero card">
        <div className="search-row">
          <IconSearch size={16} />
          <input
            className="search-input"
            placeholder="按文件名搜索（留空则按其他条件；当前来源内递归查找）"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          <button className="btn primary" onClick={run} disabled={busy || !hasCondition}>
            {busy ? "搜索中…" : "搜索"}
          </button>
        </div>

        {/* 条件区 */}
        <div className="search-filters">
          <div className="sf-row">
            <span className="sf-label">类型</span>
            <div className="kind-chips">
              {KINDS.map(([k, label]) => (
                <button key={k} className={kinds.includes(k) ? "chip active" : "chip"} onClick={() => toggleKind(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="sf-row">
            <span className="sf-label">大小</span>
            <input className="sf-num" type="number" min="0" placeholder="最小" value={sizeMin} onChange={(e) => setSizeMin(e.target.value)} />
            <span className="dim">—</span>
            <input className="sf-num" type="number" min="0" placeholder="最大" value={sizeMax} onChange={(e) => setSizeMax(e.target.value)} />
            <select className="sf-unit" value={unit} onChange={(e) => setUnit(Number(e.target.value))}>
              {SIZE_UNITS.map(([label, v]) => (
                <option key={label} value={v}>{label}</option>
              ))}
            </select>
          </div>
          <div className="sf-row">
            <span className="sf-label">修改时间</span>
            <input className="sf-date" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <span className="dim">—</span>
            <input className="sf-date" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>

        {err && <div className="error-bar">{err}</div>}
        {res && (
          <div className="search-result">
            <div className="dim result-count">共 {res.length} 条结果{res.length >= 200 ? "（已截断至 200）" : ""}</div>
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>路径</th>
                  <th>大小</th>
                  <th>修改时间</th>
                  <th style={{ width: 120 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {res.map((e) => (
                  <tr key={e.path} className="row" onDoubleClick={() => p.onOpen(e)}>
                    <td className="cell-name">
                      <span className={`ficon k-${e.kind}`}>{kindIcon(e.kind)}</span>
                      <span className="fname">{e.name}</span>
                    </td>
                    <td className="dim path-cell">{e.path || "/"}</td>
                    <td className="dim">{e.isDir ? "-" : fmtSize(e.size)}</td>
                    <td className="dim">{fmtTime(e.mtime)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn small" onClick={() => p.onLocate({ ...e, path: parentOf(e.path) } as FsEntry)}>
                          定位
                        </button>
                        {!e.isDir && (
                          <button className="btn small" onClick={() => p.onPreview(e)}>
                            预览
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {res.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">
                      未找到匹配文件
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="dim tip">
        提示：类型/大小/时间条件作用于文件（目录仅在无这些条件时出现）；{kindLabel["dir"]}默认包含名称匹配。
      </div>
    </div>
  );
}
