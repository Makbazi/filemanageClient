// 0.3.9 需求8：复制/移动目标目录对话框——在原"手输相对路径"之上增加**目录
// 浏览选择**：面板内逐级进入当前数据源（本地根或服务端 jail 根）的目录树，
// [选择此目录] 回填目标；也可直接编辑文本框（留空=根目录）。
import { useEffect, useState } from "react";
import type { FsEntry } from "../lib/types";
import * as api from "../lib/api";
import { Modal } from "./Modals";
import { IconFolder, IconChevronRight } from "./icons";
import { dirParts } from "../lib/format";

interface Props {
  mode: "copy" | "move";
  items: FsEntry[];
  /** 默认目标（当前浏览目录，根相对） */
  initial: string;
  onOk(dest: string): void;
  onCancel(): void;
}

export default function CopyMoveDialog(p: Props) {
  const [dest, setDest] = useState(p.initial);
  const [browse, setBrowse] = useState(false);
  const [cwd, setCwd] = useState(p.initial.replace(/\/+$/, ""));
  const [dirs, setDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = (path: string) => {
    setLoading(true);
    setErr("");
    api
      .source()
      .list(path)
      .then((es) => setDirs(es.filter((e) => e.isDir).map((e) => e.name)))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (browse) load(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browse, cwd]);

  const enter = (name: string) => setCwd(cwd ? `${cwd}/${name}` : name);
  const up = () => {
    const i = cwd.lastIndexOf("/");
    setCwd(i < 0 ? "" : cwd.slice(0, i));
  };
  const crumbs = dirParts(cwd);

  const ok = () => {
    const v = dest.trim().replace(/\/+$/, "");
    p.onOk(v);
  };

  return (
    <Modal title={p.mode === "copy" ? "复制到…" : "移动到…"} onClose={p.onCancel} width={480}>
      <div className="dim tip" style={{ marginBottom: 8 }}>
        共 {p.items.length} 项：{p.items.map((i) => i.name).slice(0, 5).join("、")}
        {p.items.length > 5 ? ` 等 ${p.items.length} 项` : ""}
      </div>
      <div className="field">
        <label>目标目录（相对根目录，留空为根）</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            autoFocus
            value={dest}
            placeholder="（根目录）"
            onChange={(e) => setDest(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ok()}
            style={{ flex: 1 }}
          />
          <button className="btn" onClick={() => setBrowse(!browse)}>
            {browse ? "收起浏览" : "浏览…"}
          </button>
        </div>
      </div>
      {browse && (
        <div className="card" style={{ padding: 8, maxHeight: 260, overflowY: "auto", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
            <button className="crumb" onClick={() => setCwd("")}>
              根
            </button>
            {crumbs.map((c) => (
              <span key={c.path} className="crumb-wrap">
                <IconChevronRight size={12} />
                <button className="crumb" onClick={() => setCwd(c.path)}>
                  {c.name}
                </button>
              </span>
            ))}
            <div style={{ flex: 1 }} />
            {cwd !== "" && (
              <button className="btn small" onClick={up}>
                ↑ 上一级
              </button>
            )}
            <button className="btn small primary" title="把上面的当前目录设为目标" onClick={() => setDest(cwd)}>
              选择此目录
            </button>
          </div>
          {err && <div className="error-bar">{err}</div>}
          {loading ? (
            <div className="empty">
              <div className="spinner" /> 加载中…
            </div>
          ) : dirs.length === 0 ? (
            <div className="dim" style={{ padding: "6px 4px" }}>
              （此目录下没有子目录）
            </div>
          ) : (
            dirs.map((n) => (
              <button
                key={n}
                className="btn ghost dir-pick-row"
                style={{ display: "flex", width: "100%", justifyContent: "flex-start", gap: 6 }}
                onClick={() => enter(n)}
                title={`进入 ${n}`}
              >
                <IconFolder size={14} /> {n}
              </button>
            ))
          )}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={p.onCancel}>
          取消
        </button>
        <button className="btn primary" onClick={ok}>
          {p.mode === "copy" ? "复制" : "移动"}到此目录
        </button>
      </div>
    </Modal>
  );
}
