// 左侧导航（总结4）：可折叠——默认收成左缘小箭头标签，点击标签显示/隐藏。
// 展开态含 文件/搜索/回收站/传输/AI 助手/用户/设置 跳转 + 本地目录与服务端来源列表。
import { useEffect, useState } from "react";
import type { AppConfig } from "../lib/types";
import { active } from "../lib/api";
import { subscribe } from "../lib/transfer";
import {
  IconHdd,
  IconServer,
  IconTrash,
  IconSparkles,
  IconSettings,
  IconHome,
  IconSearch,
  IconFolder,
  IconSwap,
  IconUsers,
  IconChevronRight,
} from "./icons";

export type View = "files" | "trash" | "transfers" | "ai" | "search";

interface Props {
  cfg: AppConfig;
  view: View;
  roots: { id: string; name: string }[]; // 当前服务端的根列表（本地模式为 localRoots）
  /** 折叠态：只渲染一个小箭头标签（0.4.0，默认折叠） */
  collapsed: boolean;
  onView(v: View): void;
  onToggleCollapse(): void;
  onPickLocalRoot(id: string): void;
  onPickServer(id: string): Promise<void>;
  onPickRoot(id: string): void;
  onOpenSettings(): void;
  onOpenUsers(): void;
}

export default function Sidebar(p: Props) {
  const a = active();
  const serverName = (id: string) => p.cfg.servers.find((s) => s.id === id)?.name ?? id;
  // "传输"角标：未完成任务数（排队/传输中/已暂停），注册表推送实时更新
  const [activeTransfers, setActiveTransfers] = useState(0);
  useEffect(
    () =>
      subscribe((list) =>
        setActiveTransfers(list.filter((t) => t.status === "running" || t.status === "queued" || t.status === "paused").length)
      ),
    []
  );

  if (p.collapsed) {
    return (
      <button className="sidebar-tab" title="显示导航栏" onClick={p.onToggleCollapse}>
        <IconChevronRight size={15} />
      </button>
    );
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">
          <IconFolder size={22} />
        </div>
        <div>
          <div className="brand-name">FileManage</div>
          <div className="brand-sub">云盘式文件管理</div>
        </div>
        <button className="icon-btn brand-collapse" title="收起导航栏" onClick={p.onToggleCollapse}>
          <span className="flip">
            <IconChevronRight size={15} />
          </span>
        </button>
      </div>

      <nav className="nav">
        <button className={p.view === "files" ? "nav-item active" : "nav-item"} onClick={() => p.onView("files")}>
          <IconHome size={17} /> 文件
        </button>
        <button className={p.view === "search" ? "nav-item active" : "nav-item"} onClick={() => p.onView("search")}>
          <IconSearch size={17} /> 搜索
        </button>
        <button className={p.view === "trash" ? "nav-item active" : "nav-item"} onClick={() => p.onView("trash")}>
          <IconTrash size={17} /> 回收站
        </button>
        <button
          className={p.view === "transfers" ? "nav-item active" : "nav-item"}
          onClick={() => p.onView("transfers")}
        >
          <IconSwap size={17} /> 传输
          {activeTransfers > 0 && <span className="badge ok">{activeTransfers}</span>}
        </button>
        <button className={p.view === "ai" ? "nav-item active" : "nav-item"} onClick={() => p.onView("ai")}>
          <IconSparkles size={17} /> AI 助手
        </button>
        <button className="nav-item" onClick={p.onOpenUsers}>
          <IconUsers size={17} /> 用户
        </button>
      </nav>

      <div className="side-section">
        <div className="side-label">
          <IconHdd size={13} /> 本地目录
        </div>
        {p.cfg.localRoots.length === 0 && <div className="side-empty">未配置（去设置添加）</div>}
        {p.cfg.localRoots.map((r) => (
          <button
            key={r.id}
            className={a.kind === "local" && a.rootId === r.id ? "src-item active" : "src-item"}
            onClick={() => p.onPickLocalRoot(r.id)}
            title={r.path}
          >
            <IconFolder size={15} />
            <span className="src-name">{r.name}</span>
            {a.kind === "local" && a.rootId === r.id && <span className="dot" />}
          </button>
        ))}
      </div>

      <div className="side-section grow">
        <div className="side-label">
          <IconServer size={13} /> 服务端
        </div>
        {p.cfg.servers.length === 0 && <div className="side-empty">未配置服务端</div>}
        {p.cfg.servers.map((s) => {
          const isActive = a.kind === "server" && a.serverId === s.id;
          return (
            <div key={s.id}>
              <button
                className={isActive ? "src-item active" : "src-item"}
                onClick={() => p.onPickServer(s.id)}
                title={s.baseUrl}
              >
                <IconServer size={15} />
                <span className="src-name">{s.name}</span>
                <span className={s.token ? "badge ok" : "badge"}>{s.token ? "已登录" : "未登录"}</span>
              </button>
              {isActive &&
                p.roots.map((r) => (
                  <button
                    key={r.id}
                    className={a.rootId === r.id ? "root-item active" : "root-item"}
                    onClick={() => p.onPickRoot(r.id)}
                  >
                    <IconFolder size={13} /> {r.name}
                  </button>
                ))}
            </div>
          );
        })}
      </div>

      <div className="side-foot">
        <div className="active-src">
          <span className="src-tag">{a.kind === "server" ? serverName(a.serverId ?? "") : "本地"}</span>
          {a.kind === "server" && !a.serverId ? "未选择" : ""}
        </div>
        <button className="nav-item" onClick={p.onOpenSettings}>
          <IconSettings size={17} /> 设置
        </button>
      </div>
    </aside>
  );
}
