// 左侧导航（总结4）：可折叠——默认收成左缘小箭头标签（0.1.4 起贴左上角），点击标签显示/隐藏；
// 展开态折叠按钮同在左上角。展开态含 文件/搜索/回收站/传输/AI 助手/用户/设置 跳转 +
// 本地目录与服务端来源列表；设置为视图（0.1.4），本页在设置视图下保持可见并高亮"设置"。
import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../lib/types";
import { active } from "../lib/api";
import { subscribe, listJournalPending } from "../lib/transfer";
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

// 0.1.4：settings 并入视图体系（需求2 改版后设置为主区整页视图，左侧导航保持可见/可折叠）
export type View = "files" | "trash" | "transfers" | "ai" | "search" | "settings";

interface Props {
  cfg: AppConfig;
  view: View;
  roots: { id: string; name: string }[]; // 当前服务端的根列表（本地模式为 localRoots）
  /** 折叠态：只渲染一个小箭头标签（默认折叠） */
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
  // 0.3.7 需求2：重启后内存注册表为空，账本里"待恢复"的组此前只有进 Transfers
  // 页才可见（低可发现）；角标并入这些组（未进注册表的），点入即见 [继续][放弃]。
  const [journalPending, setJournalPending] = useState(0);
  useEffect(() => {
    void listJournalPending().then((gs) => setJournalPending(gs.length)).catch(() => setJournalPending(0));
  }, []);
  const lastIdsRef = useRef("");
  useEffect(
    () =>
      subscribe((list) => {
        const act = list.filter((t) => t.status === "running" || t.status === "queued" || t.status === "paused").length;
        setActiveTransfers(act);
        // 已在注册表的组不再重复计入账本角标；仅当注册表成员变化时才回查账本
        // （进度事件高频，逐事件查库浪费——成员集是低频变化量）
        const ids = list.map((t) => t.id).sort().join(",");
        if (ids === lastIdsRef.current) return;
        lastIdsRef.current = ids;
        const inRegistry = new Set(list.map((t) => t.id));
        void listJournalPending().then((gs) => setJournalPending(gs.filter((g) => !inRegistry.has(g.gid)).length)).catch(() => undefined);
      }),
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
      {/* 0.1.4：折叠按钮移至导航栏左上角（与折叠态左缘标签同角，位置可预期） */}
      <div className="brand">
        <button className="icon-btn brand-collapse" title="收起导航栏" onClick={p.onToggleCollapse}>
          <span className="flip">
            <IconChevronRight size={15} />
          </span>
        </button>
        <div className="brand-logo">
          <IconFolder size={22} />
        </div>
        <div>
          <div className="brand-name">FileManage</div>
          <div className="brand-sub">云盘式文件管理</div>
        </div>
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
          {activeTransfers + journalPending > 0 && (
            <span className="badge ok" title={journalPending > 0 ? `含 ${journalPending} 个待恢复的上传组` : undefined}>
              {activeTransfers + journalPending}
            </span>
          )}
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
        <button className={p.view === "settings" ? "nav-item active" : "nav-item"} onClick={p.onOpenSettings}>
          <IconSettings size={17} /> 设置
        </button>
      </div>
    </aside>
  );
}
