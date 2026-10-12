// 设置：本地目录 / 服务端 / 外观（主题、浏览风格、位置恢复）/ 传输（限速）/ AI 能力 / 用户管理。
// 0.1.4（需求2）：由浮动模态卡片改为**主区整页视图**（view === "settings"，复用 .page 容器），
// 左侧导航栏保持可见与可折叠；页内"添加/编辑服务端"表单与明文 http 确认仍为对话框
// （Modals 遮罩已 portal 到 body，恒浮于本页之上）。
// 0.1.5：新增"关于"页签（版本信息：应用名/客户端版本/Tauri 版本/配套服务端版本），
// 页头右侧同时常驻显示版本号——版本一律取 Tauri 运行时元数据（非 import 常量），
// 因此与 build.sh -V 注入的产物版本一致（该通道不改三处版本源文件）。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import type { AIProvider, AppConfig, RootConf, ServerConf, ServerRoot } from "../lib/types";
import { uid } from "../lib/types";
import { fmtSize } from "../lib/format";
import { clearThumbCache } from "../lib/thumbcache";
import {
  active,
  credForget,
  fetchRoots,
  ffmpegProbe,
  serverChangePassword,
  serverLogout,
  testPlayerCommand,
} from "../lib/api";
import { THEMES } from "../lib/theme";
import { Confirm, Modal } from "./Modals";
import { IconPlus, IconTrash, IconPencil } from "./icons";

interface Props {
  cfg: AppConfig;
  /** 打开时定位的页签（侧栏"用户"按钮直达账户页） */
  initialTab?: Tab;
  onSave(next: AppConfig): Promise<void>;
  onClose(): void;
  onLogin(serverId: string): void;
}

type Tab = "local" | "servers" | "appearance" | "transfer" | "ai" | "account" | "about";

/** 运行时版本元数据（Tauri app 命令取得；非 Tauri 环境/取用失败时为空串，UI 自行回落） */
interface AppInfo {
  name: string;
  version: string;
  tauri: string;
}

export default function Settings(p: Props) {
  const [tab, setTab] = useState<Tab>(p.initialTab ?? "local");
  const [cfg, setCfg] = useState<AppConfig>({
    ...p.cfg,
    localRoots: [...p.cfg.localRoots],
    servers: [...p.cfg.servers],
    ai: { ...p.cfg.ai },
    ui: { ...p.cfg.ui },
    transfer: { ...p.cfg.transfer },
    cache: { ...p.cfg.cache },
  });
  const [saving, setSaving] = useState(false);
  // 0.3.2：媒体/缩略图缓存用量（进"传输"页签时刷新）与清空状态
  const [cacheStats, setCacheStats] = useState<{ files: number; bytes: number; limitBytes: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [srvForm, setSrvForm] = useState<{ idx: number; conf: ServerConf } | null>(null);
  // 明文 http 保存前的二次确认
  const [httpWarn, setHttpWarn] = useState<ServerConf | null>(null);
  const [info, setInfo] = useState<AppInfo>({ name: "FileManage", version: "", tauri: "" });
  // 0.3.0 需求1：外部播放器命令草稿（Enter/失焦提交 uiSet）与测试按钮状态
  const [playerDraft, setPlayerDraft] = useState(p.cfg.ui.videoPlayerCmd ?? "");
  const [testMsg, setTestMsg] = useState("");
  const [testErr, setTestErr] = useState("");
  // 0.3.3 需求3：ffmpeg 路径草稿（同 Enter/失焦提交）与探测按钮状态
  const [ffmpegDraft, setFfmpegDraft] = useState(p.cfg.ui.ffmpegPath ?? "");
  const [ffmMsg, setFfmMsg] = useState("");
  const [ffmErr, setFfmErr] = useState("");

  // 版本信息：走 Tauri app 命令（core:app:default 已含 allow-version/allow-name/
  // allow-tauri-version，无需扩权限），故 -V 覆盖产物版本时这里同步变化；
  // 纯浏览器预览（非 Tauri 运行时）invoke 失败 → 保留默认名、版本留空由 UI 显示"未知"。
  useEffect(() => {
    let cancelled = false;
    const safe = <T,>(p: Promise<T>, d: T) => p.catch(() => d);
    void Promise.all([
      safe(getName(), "FileManage"),
      safe(getVersion(), ""),
      safe(getTauriVersion(), ""),
    ]).then(([name, version, tauri]) => {
      if (!cancelled) setInfo({ name, version, tauri });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 需求8：外部登录态/凭证变化（fm-config-changed → App cfg → props）同步进内部状态；
  // 编辑中的表单草稿在 srvForm/httpWarn 独立 state，不会被此同步打断。
  useEffect(() => setCfg({ ...p.cfg }), [p.cfg]);

  // Esc 离开设置视图回文件页；页内子对话框（服务端表单/明文 http 确认）打开时让位给
  // 子对话框自己处理，避免一次 Esc 同时关掉两层（旧版两层 Modal 各挂 window 监听会连带关闭）。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !srvForm && !httpWarn) p.onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [srvForm, httpWarn, p]);

  async function persist(next: AppConfig) {
    setCfg(next);
    setSaving(true);
    try {
      await p.onSave(next);
    } finally {
      setSaving(false);
    }
  }

  // ---------- 本地目录 ----------
  async function addLocalRoot() {
    const picked = await open({ directory: true, multiple: false, title: "选择要管理的本地目录" });
    if (!picked) return;
    const path = String(picked);
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    const root: RootConf = { id: uid(), name, path };
    await persist({ ...cfg, localRoots: [...cfg.localRoots, root] });
  }
  const removeLocalRoot = (id: string) =>
    persist({ ...cfg, localRoots: cfg.localRoots.filter((r) => r.id !== id) });

  // ---------- 服务端 ----------
  function addServer() {
    setSrvForm({
      idx: -1,
      conf: { id: uid(), name: "", baseUrl: "", token: null, username: null, insecureTls: false, caFile: null },
    });
  }
  const removeServer = (id: string) =>
    persist({ ...cfg, servers: cfg.servers.filter((s) => s.id !== id) });

  function mergeServers(conf: ServerConf, idx: number): AppConfig {
    const servers =
      idx < 0 ? [...cfg.servers, conf] : cfg.servers.map((s, i) => (i === idx ? { ...s, ...conf } : s));
    return { ...cfg, servers };
  }

  function isLocalHostUrl(u: string): boolean {
    try {
      const h = new URL(u).hostname;
      return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local");
    } catch {
      return false;
    }
  }

  async function saveSrvForm() {
    if (!srvForm) return;
    // 0.1.3 修复：裸 host:port 缺协议头会让 reqwest URL 解析失败（报不透明的 "builder error"），
    // 一律补全为 http://，随后照常走明文 http 的保存二次确认
    let baseUrl = srvForm.conf.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(baseUrl)) baseUrl = `http://${baseUrl}`;
    const conf = { ...srvForm.conf, baseUrl };
    if (!conf.name || !conf.baseUrl) return;
    // 安全升级：非本机地址的明文 http 传输（口令/文件可被嗅探）需显式二次确认
    if (conf.baseUrl.startsWith("http://") && !isLocalHostUrl(conf.baseUrl)) {
      setHttpWarn(conf);
      return;
    }
    const idx = srvForm.idx;
    setSrvForm(null);
    await persist(mergeServers(conf, idx));
  }

  async function applyHttpWarn() {
    if (!httpWarn || !srvForm) return;
    const idx = srvForm.idx;
    setHttpWarn(null);
    setSrvForm(null);
    await persist(mergeServers(httpWarn, idx));
  }

  const aiSet = (patch: Partial<AppConfig["ai"]>) => setCfg({ ...cfg, ai: { ...cfg.ai, ...patch } });
  const uiSet = (patch: Partial<AppConfig["ui"]>) => {
    const next = { ...cfg, ui: { ...cfg.ui, ...patch } };
    setCfg(next);
    void p.onSave(next); // 即时生效并持久化
  };
  const trSet = (patch: Partial<AppConfig["transfer"]>) =>
    setCfg({ ...cfg, transfer: { ...cfg.transfer, ...patch } });
  const cacheSet = (patch: Partial<AppConfig["cache"]>) =>
    setCfg({ ...cfg, cache: { ...cfg.cache, ...patch } });

  // 0.3.2：进"传输"页签拉一次媒体缓存用量
  useEffect(() => {
    if (tab !== "transfer") return;
    invoke<{ files: number; bytes: number; limitBytes: number }>("cache_stats")
      .then(setCacheStats)
      .catch(() => setCacheStats(null));
  }, [tab]);

  const commitPlayer = () => {
    const v = playerDraft.trim();
    if (v !== (cfg.ui.videoPlayerCmd ?? "")) uiSet({ videoPlayerCmd: v });
  };

  async function runPlayerTest() {
    setTestMsg("");
    setTestErr("");
    try {
      const opened = await testPlayerCommand(playerDraft.trim());
      setTestMsg(`已启动外部播放器，探测文件：${opened}`);
    } catch (ex) {
      setTestErr(String(ex));
    }
  }

  // 0.3.3 需求3：ffmpeg 路径提交（Enter/失焦）与可用性探测
  const commitFfmpeg = () => {
    const v = ffmpegDraft.trim();
    if (v !== (cfg.ui.ffmpegPath ?? "")) uiSet({ ffmpegPath: v });
  };

  async function runFfmpegProbe() {
    setFfmMsg("");
    setFfmErr("");
    try {
      const ver = await ffmpegProbe();
      setFfmMsg(`ffmpeg 可用：${ver}`);
    } catch (ex) {
      setFfmErr(String(ex));
    }
  }

  return (
    <div className="page">
      <div className="settings-inner">
      <div className="page-head">
        <div>
          <h2>设置</h2>
          <p className="dim">本地目录、服务端、外观、传输、AI 能力、账户与版本信息。</p>
        </div>
        <div className="settings-ver">
          <span className="dim">版本</span>
          <span className="ver">{info.version ? `v${info.version}` : "未知"}</span>
        </div>
      </div>
      <div className="tabs">
        {(
          [
            ["local", "本地目录"],
            ["servers", "服务端"],
            ["appearance", "外观"],
            ["transfer", "传输"],
            ["ai", "AI 能力"],
            ["account", "账户"],
            ["about", "关于"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "local" && (
        <div className="tab-body">
          <p className="dim tip">客户端可脱离服务端独立部署：配置一个本地目录即可全功能管理（本地文件无需登录）。</p>
          {cfg.localRoots.map((r) => (
            <div className="list-row" key={r.id}>
              <div>
                <div className="list-name">{r.name}</div>
                <div className="dim path-cell">{r.path}</div>
              </div>
              <button className="mini danger" onClick={() => removeLocalRoot(r.id)}>
                <IconTrash size={14} />
              </button>
            </div>
          ))}
          <button className="btn" onClick={addLocalRoot}>
            <IconPlus size={15} /> 添加目录…
          </button>
        </div>
      )}

      {tab === "servers" && (
        <div className="tab-body">
          <p className="dim tip">
            可配置多个服务端，主界面顶部可快速切换。未登录时以游客身份只读浏览（受目录权限约束）；
            登录后可上传/下载/修改。强烈建议使用 https 地址；服务端为自签证书时优先「导入 CA 证书」
            （仅信任该 CA），"信任自签证书"会跳过全部证书校验、存在中间人风险。登录令牌存于系统凭证库。
          </p>
          {cfg.servers.map((s, i) => (
            <div className="list-row" key={s.id}>
              <div>
                <div className="list-name">
                  远程{i + 1} · {s.name || "(未命名)"}{" "}
                  {s.token ? <span className="badge ok">已登录 {s.username}</span> : <span className="badge">未登录</span>}
                  {s.caFile ? <span className="badge ok">CA 已导入</span> : s.insecureTls ? <span className="badge">跳过证书校验</span> : null}
                  {s.baseUrl.startsWith("http://") && <span className="badge">明文 HTTP</span>}
                </div>
                <div className="dim path-cell">{s.baseUrl}</div>
              </div>
              <div className="row-actions">
                {!s.token && (
                  <button className="btn small" onClick={() => p.onLogin(s.id)}>
                    登录
                  </button>
                )}
                <button className="mini" title="编辑" onClick={() => setSrvForm({ idx: i, conf: { ...s } })}>
                  <IconPencil size={13} />
                </button>
                <button className="mini danger" onClick={() => removeServer(s.id)}>
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
          ))}
          <button className="btn" onClick={addServer}>
            <IconPlus size={15} /> 添加服务端…
          </button>
        </div>
      )}

      {tab === "appearance" && (
        <div className="tab-body">
          <div className="field">
            <label>主题风格（需求：预置多套主题）</label>
            <div className="theme-grid">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={cfg.ui.theme === t.id ? "theme-card active" : "theme-card"}
                  onClick={() => uiSet({ theme: t.id })}
                >
                  <span className="theme-swatch">
                    {t.swatch.map((c) => (
                      <i key={c} style={{ background: c }} />
                    ))}
                  </span>
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>目录浏览风格</label>
            <div className="radio-row">
              <label className="radio-item">
                <input type="radio" checked={cfg.ui.viewMode === "list"} onChange={() => uiSet({ viewMode: "list" })} />
                按行（列表）
              </label>
              <label className="radio-item">
                <input type="radio" checked={cfg.ui.viewMode === "grid"} onChange={() => uiSet({ viewMode: "grid" })} />
                按缩略图（网格）
              </label>
            </div>
          </div>
          {/* 0.3.0 需求2：托盘常住 + 关闭按钮行为（默认托盘） */}
          <div className="field">
            <label>关闭按钮（X）行为</label>
            <select
              value={cfg.ui.closeAction}
              onChange={(e) => uiSet({ closeAction: e.target.value as "tray" | "quit" })}
            >
              <option value="tray">最小化到托盘（默认）</option>
              <option value="quit">退出程序</option>
            </select>
            <p className="dim tip">
              常驻托盘：点 X 隐藏窗口到系统托盘，经托盘图标左键/双击（Windows）或托盘菜单「显示主窗口」恢复；
              重复启动应用只会唤起已打开的窗口（不产生第二个实例）；无 AppIndicator 宿主等托盘不可用的环境
              自动退回「退出程序」，不会把窗口藏丢。
            </p>
          </div>
          <label className="check-item">
            <input
              type="checkbox"
              checked={cfg.ui.groupByKind}
              onChange={(e) => uiSet({ groupByKind: e.target.checked })}
            />
            按文件类型自动分组显示
          </label>
          <label className="check-item">
            <input
              type="checkbox"
              checked={cfg.ui.restoreLastLocation}
              onChange={(e) => uiSet({ restoreLastLocation: e.target.checked })}
            />
            启动时恢复上次关闭时的位置（来源/目录/视图）
          </label>
          <label className="check-item">
            <input
              type="checkbox"
              checked={!cfg.ui.sidebarCollapsed}
              onChange={(e) => uiSet({ sidebarCollapsed: !e.target.checked })}
            />
            始终展开左侧导航栏（取消则折叠为左缘小箭头标签，点击标签显隐）
          </label>
          <label className="check-item">
            <input
              type="checkbox"
              checked={cfg.ui.restoreSessions !== false}
              onChange={(e) => uiSet({ restoreSessions: e.target.checked })}
            />
            启动时恢复各服务端登录状态（需求9：上次保持登录的重开后仍是登录态；
            关闭则每次启动全部退出——已记住的密码保留，退出状态的服务端可一键快速重登）
          </label>
          {/* 0.3.0 需求1 / 0.3.3 需求3：H.264/H.265 播放三档——系统解码器（默认）/
              ffmpeg 转码（用户配置 ffmpeg，不内嵌）/ 外部播放器 */}
          <div className="field">
            <label>视频播放（H.264 / H.265）</label>
            <div className="radio-row">
              <label className="radio-item">
                <input
                  type="radio"
                  checked={cfg.ui.videoDecoder === "system"}
                  onChange={() => uiSet({ videoDecoder: "system" })}
                />
                系统解码器（默认，窗口内播放）
              </label>
              <label className="radio-item">
                <input
                  type="radio"
                  checked={cfg.ui.videoDecoder === "ffmpeg"}
                  onChange={() => uiSet({ videoDecoder: "ffmpeg" })}
                />
                ffmpeg 转码（窗口内播放）
              </label>
              <label className="radio-item">
                <input
                  type="radio"
                  checked={cfg.ui.videoDecoder === "external"}
                  onChange={() => uiSet({ videoDecoder: "external" })}
                />
                外部播放器
              </label>
            </div>
            <p className="dim tip">
              0.3.6 起三档共用真实编码探测（`ffmpeg -i` 窥首轨编码，毫秒级）：检测到 H.265/HEVC 时——
              配置了可用 ffmpeg（本设置「ffmpeg 路径」或 PATH）就<b>自动转码后窗口内播放</b>（首次转码有
              等待、之后复用产物），不再先撞一次必然失败的系统解码；未配置 ffmpeg 则维持系统解码尝试，
              失败面板给「用 ffmpeg 转码播放 / 用外部播放器打开」一键兜底。
              系统解码器 = 操作系统自带的视频组件（Windows：WebView2/Media Foundation；Linux：GStreamer；
              H.265 需「HEVC 视频扩展」/gstreamer HEVC 插件才可能直接播出）。
              ffmpeg 转码档 = 凡无法直接解码的视频一律先转 H.264 MP4 再窗口内播放（HEVC-in-MP4 也会转，
              旧版被容器后缀放行导致播放失败的问题已修复）；转码产物入媒体缓存、受缓存上限自动淘汰。
            </p>
            {cfg.ui.videoDecoder === "external" && (
              <>
                <div className="field">
                  <label>播放器命令（留空 = 系统关联的播放器）</label>
                  <input
                    placeholder={'mpv ／ vlc ／ "C:\\Program Files\\mpv\\mpv.exe" {file}'}
                    value={playerDraft}
                    onChange={(e) => setPlayerDraft(e.target.value)}
                    onBlur={commitPlayer}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitPlayer();
                    }}
                  />
                </div>
                <button className="btn small" disabled={!playerDraft.trim()} onClick={() => void runPlayerTest()}>
                  测试外部播放器
                </button>
                {testMsg && <p className="dim tip">{testMsg}</p>}
                {testErr && <div className="error-bar">{testErr}</div>}
                <p className="dim tip">
                  命令直接启动（不经 shell，故不支持 &amp;&amp;/管道）；程序路径含空格请整体加引号；
                  {'{file}'} 代表视频文件路径，未写则作为末位参数自动追加。测试会打开媒体缓存中最近的视频文件，
                  缓存为空时改用 0 字节探测文件——播放器报"无法解码"属正常，仅验证命令与参数链路。
                </p>
              </>
            )}
            {/* 0.3.3 需求3：ffmpeg 可执行路径（不内嵌 ffmpeg）；选"ffmpeg 转码"档时
                用于播放，选"系统解码器"档时作为解码失败面板的转码兜底——两档共用本路径 */}
            <div className="field">
              <label>ffmpeg 路径（留空 = 自动在 PATH 中查找 ffmpeg）</label>
              <input
                placeholder={'留空走 PATH ／ /usr/bin/ffmpeg ／ "C:\\ffmpeg\\bin\\ffmpeg.exe"'}
                value={ffmpegDraft}
                onChange={(e) => setFfmpegDraft(e.target.value)}
                onBlur={commitFfmpeg}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitFfmpeg();
                }}
              />
              <div className="toolbar-inline">
                <button className="btn small" onClick={() => void runFfmpegProbe()}>
                  探测 ffmpeg
                </button>
              </div>
              {ffmMsg && <p className="dim tip">{ffmMsg}</p>}
              {ffmErr && <div className="error-bar">{ffmErr}</div>}
              <p className="dim tip">
                「ffmpeg 转码」档：窗口播不了的视频（如缺系统 HEVC 组件的 H.265）先用本机 ffmpeg 转成
                H.264 MP4 再播放——转码产物落媒体缓存（同预览缓存受磁盘上限与 LRU 管理），
                同一文件只转一次、之后直接复用；首次转码耗时随视频长度增大。「系统解码器」档下
                若窗口解码失败，查看/预览的失败面板也提供「用 ffmpeg 转码播放」一键兜底。
                本程序不内置 ffmpeg，需自备并在上方配置路径。
              </p>
            </div>
          </div>
        </div>
      )}

      {tab === "transfer" && (
        <div className="tab-body">
          <p className="dim tip">
            客户端上传/下载限速（0 = 不限速，默认）。服务端也可全局限速（server.json 的 rateLimit），两者取更严格者生效。
          </p>
          <div className="field">
            <label>上传限速（KB/s，0 不限）</label>
            <input
              type="number"
              min={0}
              value={cfg.transfer.uploadLimitKbps}
              onChange={(e) => trSet({ uploadLimitKbps: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
          <div className="field">
            <label>下载限速（KB/s，0 不限）</label>
            <input
              type="number"
              min={0}
              value={cfg.transfer.downloadLimitKbps}
              onChange={(e) => trSet({ downloadLimitKbps: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
          <div className="field">
            <label>本地回收站保留天数（超期启动时自动彻底清理；默认 30，独立于服务端策略）</label>
            <input
              type="number"
              min={1}
              value={cfg.trashRetentionDays}
              onChange={(e) => setCfg({ ...cfg, trashRetentionDays: Math.max(1, Number(e.target.value) || 30) })}
            />
          </div>

          {/* 0.3.2 媒体/缩略图缓存（需求3/4/5）：磁盘 LRU 上限 + 内存预算 + 用量/清空 */}
          <h3 className="form-section">媒体/缩略图缓存</h3>
          <div className="field">
            <label>磁盘缓存上限（MB，默认 10240 = 10GB）</label>
            <input
              type="number"
              min={256}
              value={cfg.cache.maxDiskMb}
              onChange={(e) => cacheSet({ maxDiskMb: Math.max(256, Number(e.target.value) || 10240) })}
            />
          </div>
          <div className="field">
            <label>缩略图内存缓存上限（MB，默认 2048 = 2GB）</label>
            <input
              type="number"
              min={64}
              value={cfg.cache.maxMemMb}
              onChange={(e) => cacheSet({ maxMemMb: Math.max(64, Number(e.target.value) || 2048) })}
            />
          </div>
          <p className="dim tip">
            缓存内容：网格缩略图、图片/视频预览与查看落盘（跨程序退出保留，超限按最久未访问自动淘汰；
            本地模式的链接条目不会移动/删除你的源文件）。
            {cacheStats && (
              <>
                {" "}
                当前用量 <b>{fmtSize(cacheStats.bytes)}</b>（{cacheStats.files} 个条目），
                上限 {fmtSize(cacheStats.limitBytes)}。
              </>
            )}
          </p>
          <div className="toolbar-inline">
            <button
              className="btn"
              onClick={() =>
                void invoke<{ files: number; bytes: number; limitBytes: number }>("cache_stats")
                  .then(setCacheStats)
                  .catch(() => setCacheStats(null))
              }
            >
              刷新用量
            </button>
            <button
              className="btn danger"
              disabled={clearing}
              onClick={() => {
                setClearing(true);
                void invoke("cache_clear")
                  .then(() => {
                    clearThumbCache();
                    return invoke<{ files: number; bytes: number; limitBytes: number }>("cache_stats");
                  })
                  .then(setCacheStats)
                  .catch(() => {})
                  .finally(() => setClearing(false));
              }}
            >
              清空缓存
            </button>
          </div>

          <button className="btn primary" onClick={() => persist(cfg)} disabled={saving}>
            保存传输设置
          </button>
        </div>
      )}

      {tab === "ai" && (
        <div className="tab-body">
          <p className="dim tip">
            AI 能力：支持 OpenAI 兼容协议（任意云厂商 / 本地网关）与本地 Ollama。本地模式存本机文件库；
            服务端模式走服务端 AI 配置。
          </p>
          <div className="field">
            <label>Provider</label>
            <select value={cfg.ai.provider} onChange={(e) => aiSet({ provider: e.target.value as AIProvider })}>
              <option value="none">未启用</option>
              <option value="openai">OpenAI 兼容（云厂商 / vLLM / one-api…）</option>
              <option value="ollama">Ollama（本地部署）</option>
            </select>
          </div>
          {cfg.ai.provider !== "none" && (
            <>
              <div className="field">
                <label>Base URL</label>
                <input
                  placeholder={cfg.ai.provider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1"}
                  value={cfg.ai.baseUrl}
                  onChange={(e) => aiSet({ baseUrl: e.target.value })}
                />
              </div>
              <div className="field">
                <label>API Key（Ollama 可留空）</label>
                <input type="password" value={cfg.ai.apiKey} onChange={(e) => aiSet({ apiKey: e.target.value })} />
              </div>
              <div className="field">
                <label>模型（需支持视觉时填 vision 模型）</label>
                <input
                  placeholder="gpt-4o-mini / qwen2.5-vl / llama3.2-vision…"
                  value={cfg.ai.model}
                  onChange={(e) => aiSet({ model: e.target.value })}
                />
              </div>
            </>
          )}
          <button className="btn primary" onClick={() => persist(cfg)} disabled={saving}>
            保存 AI 配置
          </button>
        </div>
      )}

      {tab === "account" && <AccountTab cfg={cfg} onLogin={p.onLogin} />}
      {tab === "about" && <AboutTab info={info} />}
      </div>

      {httpWarn && (
        <Confirm
          title="保存明文 HTTP 地址？"
          danger
          lines={[
            `${httpWarn.baseUrl} 未使用 HTTPS：登录口令与文件内容将以明文传输，局域网内可被嗅探/篡改。`,
            "建议在服务端启用 TLS（自签证书可在上一表单导入对应 CA），仅完全可信的局域网才使用 http。",
          ]}
          confirmText="仍要保存"
          onOk={applyHttpWarn}
          onCancel={() => setHttpWarn(null)}
        />
      )}
      {srvForm && (
        <Modal title={srvForm.idx < 0 ? "添加服务端" : "编辑服务端"} onClose={() => setSrvForm(null)} width={440}>
          <div className="field">
            <label>名称（如：家中 NAS）</label>
            <input
              autoFocus
              value={srvForm.conf.name}
              onChange={(e) => setSrvForm({ ...srvForm, conf: { ...srvForm.conf, name: e.target.value } })}
            />
          </div>
          <div className="field">
            <label>服务地址（推荐 https://…；省略协议头按 http:// 处理，仅限可信局域网，保存时需确认）</label>
            <input
              value={srvForm.conf.baseUrl}
              placeholder="https://192.168.1.10:8484"
              onChange={(e) => setSrvForm({ ...srvForm, conf: { ...srvForm.conf, baseUrl: e.target.value } })}
            />
          </div>
          <div className="field">
            <label>CA 证书（PEM；自签场景推荐——仅信任该证书，等效证书固定）</label>
            <div className="inline-form">
              <input readOnly placeholder="（未选择：使用系统默认证书信任链）" value={srvForm.conf.caFile ?? ""} />
              <button
                className="btn small"
                onClick={async () => {
                  const picked = await open({
                    multiple: false,
                    title: "选择服务端 CA 证书",
                    filters: [{ name: "证书", extensions: ["pem", "crt", "cer"] }],
                  });
                  if (picked) setSrvForm({ ...srvForm, conf: { ...srvForm.conf, caFile: String(picked) } });
                }}
              >
                选择…
              </button>
              {!!srvForm.conf.caFile && (
                <button className="btn small ghost" onClick={() => setSrvForm({ ...srvForm, conf: { ...srvForm.conf, caFile: null } })}>
                  清除
                </button>
              )}
            </div>
          </div>
          <label className="check-item">
            <input
              type="checkbox"
              checked={!!srvForm.conf.insecureTls}
              onChange={(e) => setSrvForm({ ...srvForm, conf: { ...srvForm.conf, insecureTls: e.target.checked } })}
            />
            信任自签证书（不推荐：跳过全部证书校验，存在中间人风险；建议改为导入上方 CA 证书）
          </label>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setSrvForm(null)}>取消</button>
            <button
              className="btn primary"
              disabled={!srvForm.conf.name || !srvForm.conf.baseUrl}
              onClick={saveSrvForm}
            >
              保存
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- 账户页：当前来源登录态管理 ----------
// 未登录 → 点击登录；已登录 → 显示账户名与可访问目录，可切换账户（登出并换身份
// 重登）/退出登录。**0.3.6 认证契约：客户端只持 token、不查询自身身份/角色**——
// 账户名取本地配置（登录时 Rust 权威落存），服务端 /auth/me 亦不再回 role/id。

function AccountTab(p: { cfg: AppConfig; onLogin(serverId: string): void }) {
  const a = active();
  const srv = a.kind === "server" ? p.cfg.servers.find((s) => s.id === a.serverId) : undefined;
  const [roots, setRoots] = useState<ServerRoot[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const tokenKey = srv?.token ? "1" : "";
  // 自助改密（批次需求31）
  const [showPw, setShowPw] = useState(false);
  const [pwOld, setPwOld] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [pwErr, setPwErr] = useState("");

  useEffect(() => {
    setRoots([]);
    setErr("");
    if (!srv?.token) return;
    let cancelled = false;
    // 不查 /auth/me（客户端无身份查询）；roots 是业务数据（可访问目录清单）
    fetchRoots(srv.id)
      .then((rs) => { if (!cancelled) setRoots(rs ?? []); })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srv?.id, tokenKey]);

  async function logout(relogin: boolean) {
    if (!srv) return;
    setBusy(true);
    try {
      await serverLogout(srv.id);
      setRoots([]);
      if (relogin) p.onLogin(srv.id); // 切换账户：登出后立即弹登录框换身份
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  // 自助改密（批次需求31）：服务端校验旧密码并作废全部会话；Rust 侧已更新
  // 已记住的口令并清本地 token，成功后回到"未登录"态、提示用新密码重登。
  async function submitPw() {
    if (!srv) return;
    setPwErr("");
    setPwMsg("");
    if (pwNew.length < 6) { setPwErr("新密码至少 6 位"); return; }
    if (pwOld === pwNew) { setPwErr("新密码不能与旧密码相同"); return; }
    setBusy(true);
    try {
      const r = await serverChangePassword(pwOld, pwNew);
      setPwMsg(r.passwordSaved
        ? "密码已修改，记住的口令已同步更新；请使用新密码重新登录。"
        : "密码已修改，请使用新密码重新登录。");
      setPwOld("");
      setPwNew("");
      setRoots([]);
    } catch (e) {
      setPwErr(String(e).replace(/^AUTH_REQUIRED:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  if (a.kind !== "server") {
    return (
      <div className="tab-body">
        <p className="dim tip">
          当前为本地模式：本机文件无需登录即可全功能管理；本页管理远程服务器的登录身份。
          请在顶栏快速切换或左侧服务端列表选择一个服务端后再使用账户功能。
        </p>
      </div>
    );
  }
  if (!srv) {
    return <div className="tab-body"><p className="dim tip">未选择服务端（请先在顶栏切换）。</p></div>;
  }
  return (
    <div className="tab-body">
      <div className="list-row">
        <div>
          <div className="list-name">{srv.name || "(未命名)"}　<span className="dim path-cell">{srv.baseUrl}</span></div>
          <div className="dim">
            {srv.token
              ? `已登录为：${srv.username ?? "—"}`
              : "未登录（游客：可浏览公开内容，登录后可下载/上传/修改）"}
          </div>
        </div>
        {!srv.token && (
          <button className="btn primary" onClick={() => p.onLogin(srv.id)}>登录…</button>
        )}
      </div>
      {err && <div className="error-bar">{err}</div>}
      {p.cfg.credentials.some((c) => c.serverId === srv.id) && (
        <div className="field">
          <label>该服务端已记住密码的账户（系统凭证库，需求3）</label>
          {p.cfg.credentials
            .filter((c) => c.serverId === srv.id)
            .map((c) => (
              <div className="list-row" key={c.username}>
                <div className="list-name">{c.username}</div>
                <button className="btn small ghost" onClick={() => void credForget(srv.id, c.username)}>
                  忘记密码
                </button>
              </div>
            ))}
        </div>
      )}
      {srv.token && (
        <>
          <div className="field">
            <label>该身份可访问的目录（由服务端管理员分配）</label>
            {roots.length ? (
              roots.map((r) => (
                <div className="list-row" key={r.id}>
                  <div className="list-name">{r.name}</div>
                  <div className="dim mono small">{r.id}</div>
                </div>
              ))
            ) : (
              <div className="dim tip">暂无分配目录——管理员在服务端管理台（/admin/，仅服务端本机可达）为你分配后即可看到。</div>
            )}
          </div>
          <div className="field">
            <button className="btn small ghost" disabled={busy} onClick={() => { setShowPw(!showPw); setPwMsg(""); setPwErr(""); }}>
              {showPw ? "收起修改密码" : "修改我的密码…"}
            </button>
            {showPw && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <input type="password" autoComplete="current-password" placeholder="当前密码" value={pwOld} onChange={(e) => setPwOld(e.target.value)} />
                <input type="password" autoComplete="new-password" placeholder="新密码（至少 6 位）" value={pwNew} onChange={(e) => setPwNew(e.target.value)} />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="btn primary small" disabled={busy || !pwOld || pwNew.length < 6} onClick={() => void submitPw()}>
                    {busy ? "提交中…" : "确认修改"}
                  </button>
                  <span className="dim">修改后当前会话即失效，需用新密码重新登录</span>
                </div>
                {pwMsg && <div className="dim tip" style={{ color: "var(--ok, #4caf7d)" }}>{pwMsg}</div>}
                {pwErr && <div className="error-bar">{pwErr}</div>}
              </div>
            )}
          </div>
          <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn" disabled={busy} onClick={() => logout(true)}>切换账户…</button>
            <button className="btn ghost" disabled={busy} onClick={() => logout(false)}>退出登录</button>
          </div>
        </>
      )}
      <p className="dim tip">
        账户会话最长保留 3 周（活跃自动续期）。用户创建、目录分配与权限管理均在服务端独立端口的
        管理台完成，客户端不提供用户管理服务。
      </p>
    </div>
  );
}

// ---------- 关于（0.1.5）：版本信息 ----------
// 客户端版本/Tauri 版本取自运行时 app 命令（与安装包注入版本一致，非编译期常量）；
// 配套服务端版本为兼容矩阵事实，随 CHANGELOG 一起维护，改矩阵时同步这里的文案。
function AboutTab(p: { info: AppInfo }) {
  const ver = p.info.version ? `v${p.info.version}` : "未知";
  return (
    <div className="tab-body">
      <div className="about-hero">
        <div className="about-name">{p.info.name}</div>
        <div className="about-ver">{ver}</div>
        <div className="dim">Tauri 2 桌面客户端 · 本地目录 / 服务端双数据源</div>
      </div>
      <div className="list-row">
        <span className="dim">客户端版本</span>
        <span className="about-val">{ver}</span>
      </div>
      <div className="list-row">
        <span className="dim">Tauri 框架版本</span>
        <span className="about-val">{p.info.tauri ? `v${p.info.tauri}` : "未知"}</span>
      </div>
      <div className="list-row">
        <span className="dim">配套服务端</span>
        <span className="about-val">0.2.x（推荐，当前 0.2.4）· 0.1.x 可用</span>
      </div>
      <p className="dim tip">
        版本号读自安装包自身元数据：构建脚本以 -V 指定产物版本时，这里显示的就是该注入值（不改动工程版本源文件）。
      </p>
    </div>
  );
}
