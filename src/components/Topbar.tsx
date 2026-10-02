// 顶栏：视图标题 + 快速切换（0.6.0 需求10：本地 + 选中远程两按钮，其余收进"更多"）+ 登录状态。
import { useState } from "react";
import type { AppConfig } from "../lib/types";
import type { View } from "./Sidebar";
import { IconChevronRight, IconGlobe, IconHdd, IconLock, IconLogout } from "./icons";

interface Props {
  cfg: AppConfig;
  view: View;
  /** 当前激活来源 key："local" 或 serverId */
  activeKey: string;
  /** 快速切换第二按钮记忆的远程 id（ui.lastServerId，需求10） */
  lastServerId?: string | null;
  anonymous: boolean;
  username?: string | null;
  onSwitchLocal(): void;
  onSwitchServer(serverId: string): void;
  onLogin(serverId: string): void;
  onLogout(): void;
}

const TITLES: Record<View, string> = {
  files: "文件",
  trash: "回收站",
  transfers: "传输",
  ai: "AI 助手",
  search: "搜索",
  settings: "设置",
};

export default function Topbar(p: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const servers = p.cfg.servers;
  // 第二按钮 = 当前远程；本地模式下回落到"上次选中的远程"（lastServerId），再回落首个服务端
  const secondId =
    p.activeKey !== "local" ? p.activeKey : servers.some((s) => s.id === p.lastServerId) ? p.lastServerId ?? "" : servers[0]?.id ?? "";
  const second = servers.find((s) => s.id === secondId);
  const others = servers.filter((s) => s.id !== secondId);
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="topbar-title">{TITLES[p.view]}</div>
        {/* 快速切换（需求10）：本地 | 选中远程 | ⋯更多（其余远程，含登录态） */}
        <div className="quick-switch">
          <button
            className={p.activeKey === "local" ? "qs-item active" : "qs-item"}
            onClick={p.onSwitchLocal}
            title="切换到本地目录"
            disabled={p.cfg.localRoots.length === 0}
          >
            <IconHdd size={13} /> 本地
          </button>
          {second && (
            <button
              className={p.activeKey === second.id ? "qs-item active" : "qs-item"}
              onClick={() => p.onSwitchServer(second.id)}
              title={`${second.name}（${second.baseUrl}）${second.token ? "" : " · 未登录（游客只读）"}`}
            >
              <IconGlobe size={13} /> {second.name || "远程"}
              <span className={second.token ? "badge ok" : "badge"}>{second.token ? "已登录" : "未登录"}</span>
            </button>
          )}
          {others.length > 0 && (
            <span className="qs-more-wrap">
              <button className="qs-item" onClick={() => setMoreOpen((v) => !v)} title="其他远程服务端">
                更多 <IconChevronRight size={12} style={{ transform: moreOpen ? "rotate(90deg)" : undefined }} />
              </button>
              {moreOpen && (
                <>
                  <div className="qs-backdrop" onClick={() => setMoreOpen(false)} />
                  <div className="qs-menu">
                    {others.map((s) => (
                      <button
                        key={s.id}
                        className="qs-menu-item"
                        onClick={() => {
                          setMoreOpen(false);
                          p.onSwitchServer(s.id);
                        }}
                        title={s.baseUrl}
                      >
                        <IconGlobe size={13} />
                        <span className="src-name">{s.name || "(未命名)"}</span>
                        <span className={s.token ? "badge ok" : "badge"}>{s.token ? "已登录" : "未登录"}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </span>
          )}
          {!second && servers.length === 0 && <span className="dim small">未配置远程（设置 → 服务端）</span>}
        </div>
      </div>
      <div className="topbar-right">
        {p.activeKey !== "local" &&
          (p.anonymous ? (
            <button className="btn small ghost" onClick={() => p.onLogin(p.activeKey)}>
              <IconLock size={13} /> 游客只读 · 点击登录
            </button>
          ) : (
            <button className="btn small ghost" onClick={p.onLogout} title={`已登录：${p.username ?? ""}`}>
              <IconLogout size={13} /> {p.username ?? "已登录"} · 退出
            </button>
          ))}
      </div>
    </header>
  );
}
