import type { AppConfig } from "../lib/types";
import { active } from "../lib/api";
import {
  IconHdd,
  IconServer,
  IconTrash,
  IconSparkles,
  IconSettings,
  IconHome,
  IconSearch,
  IconFolder,
} from "./icons";

export type View = "files" | "trash" | "ai" | "search";

interface Props {
  cfg: AppConfig;
  view: View;
  roots: { id: string; name: string }[]; // 当前服务端的根列表（本地模式为 localRoots）
  onView(v: View): void;
  onPickLocalRoot(id: string): void;
  onPickServer(id: string): Promise<void>;
  onPickRoot(id: string): void;
  onOpenSettings(): void;
}

export default function Sidebar(p: Props) {
  const a = active();
  const serverName = (id: string) => p.cfg.servers.find((s) => s.id === id)?.name ?? id;
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
        <button className={p.view === "ai" ? "nav-item active" : "nav-item"} onClick={() => p.onView("ai")}>
          <IconSparkles size={17} /> AI 助手
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
