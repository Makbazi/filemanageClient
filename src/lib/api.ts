// 统一数据访问门面：
// - 配置单例（loadConfig/getConfig/saveConfig，持久化在 Rust 侧 config.json）
// - source()：按当前激活来源构造 DataSource（本地/服务端，接口化设计）
// - 服务端专属能力：登录/根列表/分享链接/目录权限（经 srv_call 代理）
import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveConf,
  AclEntry,
  AclSubjects,
  AppConfig,
  DescRecord,
  SearchHit,
  ServerRoot,
  ShareLinkInfo,
} from "./types";
import type { DataSource } from "./datasource";
import { LocalSource } from "./local";
import { ServerSource, srvCall } from "./server";
import { setThumbBudgetMb } from "./thumbcache";
import { AuthError } from "./errors";

export { AuthError };

function defaultConfig(): AppConfig {
  return {
    localRoots: [],
    servers: [],
    ai: { provider: "none", baseUrl: "", apiKey: "", model: "" },
    active: null,
    ui: {
      theme: "dark-glass",
      viewMode: "list",
      restoreLastLocation: false,
      lastLocation: null,
      groupByKind: false,
      sidebarCollapsed: true,
      restoreSessions: true,
      lastServerId: null,
      closeAction: "tray",
      videoDecoder: "system",
      videoPlayerCmd: "",
      ffmpegPath: "",
    },
    transfer: { uploadLimitKbps: 0, downloadLimitKbps: 0 },
    trashRetentionDays: 30,
    credentials: [],
    cache: { maxDiskMb: 10240, maxMemMb: 2048 },
  };
}

let cfg: AppConfig = defaultConfig();

/** 兼容旧配置文件：补齐缺失的 ui/transfer 等字段。 */
function normalize(c: AppConfig): AppConfig {
  const base = defaultConfig();
  return {
    ...base,
    ...c,
    localRoots: c.localRoots ?? [],
    servers: (c.servers ?? []).map((s) => ({ insecureTls: false, caFile: null, ...s })),
    ai: c.ai ?? base.ai,
    ui: { ...base.ui, ...(c.ui ?? {}) },
    transfer: { ...base.transfer, ...(c.transfer ?? {}) },
    trashRetentionDays: c.trashRetentionDays && c.trashRetentionDays > 0 ? c.trashRetentionDays : 30,
    cache: { ...base.cache, ...(c.cache ?? {}) },
  };
}

export async function loadConfig(): Promise<AppConfig> {
  cfg = normalize((await invoke("get_config")) as AppConfig);
  setThumbBudgetMb(cfg.cache.maxMemMb); // 0.3.2：缩略图内存 LRU 预算随配置生效
  return cfg;
}

export function getConfig(): AppConfig {
  return cfg;
}

export async function saveConfig(next: AppConfig): Promise<AppConfig> {
  cfg = normalize((await invoke("save_config", { config: next })) as AppConfig);
  setThumbBudgetMb(cfg.cache.maxMemMb);
  return cfg;
}

export function active(): ActiveConf {
  if (cfg.active) return cfg.active;
  const r = cfg.localRoots[0];
  return { kind: "local", rootId: r?.id ?? "" };
}

// ---------- 数据源工厂（带缓存，登录态变化时失效） ----------

let src: DataSource | null = null;
let srcKey = "";

export function invalidateSource() {
  src = null;
  srcKey = "";
}

/** 当前激活来源的 DataSource。 */
export function source(): DataSource {
  const a = active();
  const srv = a.kind === "server" ? cfg.servers.find((s) => s.id === a.serverId) : null;
  const key = `${a.kind}|${a.serverId ?? ""}|${a.rootId}|${srv?.token ? 1 : 0}`;
  if (!src || srcKey !== key) {
    src =
      a.kind === "local"
        ? new LocalSource(a.rootId)
        : new ServerSource(a.serverId ?? "", a.rootId, !srv?.token);
    srcKey = key;
  }
  return src;
}

export function isServerMode(): boolean {
  return active().kind === "server";
}

export function isAnonymous(): boolean {
  return source().anonymous;
}

function activeServerId(): string {
  const a = active();
  if (a.kind !== "server" || !a.serverId) throw new Error("未选择服务端");
  return a.serverId;
}

// ---------- 服务端认证 / 根列表 ----------

export async function serverLogin(serverId: string, username: string, password: string, remember?: boolean) {
  const r = await invoke("srv_login", { serverId, username, password, remember: remember ?? null });
  await loadConfig();
  invalidateSource();
  return r;
}

// ---------- 记住的账户密码（需求3） ----------

/** 取回某服务端某账户已记住的密码（未记住/无凭证库时 null）。 */
export function credTake(serverId: string, username: string): Promise<string | null> {
  return invoke("cred_take", { serverId, username }) as Promise<string | null>;
}

export async function credForget(serverId: string, username: string) {
  await invoke("cred_forget", { serverId, username });
  await loadConfig();
}

export async function serverLogout(serverId: string) {
  await invoke("srv_logout", { serverId });
  await loadConfig();
  invalidateSource();
}

/** 自助改密（批次需求31）：Rust 侧同步更新已记住口令并清会话，成功后前端登录态作废。 */
export async function serverChangePassword(oldPassword: string, newPassword: string) {
  const r = await invoke<{ ok: boolean; reauthRequired: boolean; passwordSaved: boolean }>("srv_change_password", {
    oldPassword,
    newPassword,
  });
  await loadConfig();
  invalidateSource();
  return r;
}

// ---------- 外部播放器（0.3.0 需求1） ----------

/** 用外部播放器/系统关联打开媒体缓存文件（参数为 mediaCache() 返回的绝对路径）。 */
export async function openMedia(path: string): Promise<void> {
  await invoke("open_media", { path });
}

/** 设置页测试外部播放器命令，返回实际打开的探测文件路径（可能是 0 字节样本）。 */
export async function testPlayerCommand(command: string): Promise<string> {
  return invoke("test_player_command", { command }) as Promise<string>;
}

// ---------- ffmpeg 转码播放（0.3.3 需求3） ----------

/** 探测配置的 ffmpeg 可用性（设置页），成功返回版本首行；失败抛可读错误。 */
export async function ffmpegProbe(): Promise<string> {
  return invoke("ffmpeg_probe") as Promise<string>;
}

/** 媒体缓存视频 → 窗口内可播路径：容器 WebView 可直放时原路返回
 *  （force=false）；否则 ffmpeg 转码 H.264 MP4 入媒体缓存（产物复用，
 *  受磁盘 LRU 上限）。force=true 强制转码（系统解码失败兜底——容器
 *  友好但编码不受支持的场景）。本命令不产生任何传输事件。 */
export async function ffmpegPlayable(path: string, force = false): Promise<string> {
  return invoke("ffmpeg_playable", { path, force: force ? true : null }) as Promise<string>;
}

/** 0.3.6（H.265 修复）：媒体缓存视频首轨编码探测——`ffmpeg -i` 窥真实编码
 *  （毫秒级；正向结果 Rust 侧缓存）。返回如 "hevc"/"h264"；空串=判不了
 *  （ffmpeg 未配置/无视频轨）。不产生任何传输事件。 */
export async function videoCodecProbe(path: string): Promise<string> {
  return invoke("video_codec_probe", { path }) as Promise<string>;
}

export function fetchRoots(serverId: string): Promise<ServerRoot[]> {
  return srvCall<ServerRoot[]>(serverId, "GET", "/api/v1/roots");
}

export function serverInfo(serverId: string) {
  return srvCall<{ ok: boolean; version: string; db: string; instanceId?: string }>(
    serverId,
    "GET",
    "/api/v1/health"
  );
}

/** 当前激活服务端的泛用调用（账户信息等）。async：未选服务端时返回 rejected Promise 而非同步 throw。 */
export async function serverCall(method: string, path: string, body?: unknown) {
  return srvCall(activeServerId(), method, path, body);
}

// ---------- 临时分享链接（需求7，服务端模式） ----------

export function createShareLink(opts: {
  rootId: string;
  path: string;
  expiresInHours?: number;
  password?: string;
  noPassword?: boolean;
}): Promise<ShareLinkInfo> {
  return srvCall<ShareLinkInfo>(activeServerId(), "POST", "/api/v1/share/links", opts);
}

export function listShareLinks(): Promise<ShareLinkInfo[]> {
  return srvCall<ShareLinkInfo[]>(activeServerId(), "GET", "/api/v1/share/links");
}

export function updateShareLink(
  token: string,
  patch: { password?: string; noPassword?: boolean; expiresAt?: string | null; disabled?: boolean }
): Promise<ShareLinkInfo> {
  return srvCall<ShareLinkInfo>(activeServerId(), "PUT", `/api/v1/share/links/${token}`, patch);
}

export function deleteShareLink(token: string): Promise<void> {
  return srvCall(activeServerId(), "DELETE", `/api/v1/share/links/${token}`);
}

// ---------- 目录权限（需求8/9，服务端模式） ----------

export function getAcl(rootId: string, path: string) {
  return srvCall<{ entries: AclEntry[]; effective: Record<string, boolean> }>(
    activeServerId(),
    "GET",
    `/api/v1/acl?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`
  );
}

export function putAcl(rootId: string, path: string, entries: AclEntry[]) {
  return srvCall(activeServerId(), "PUT", "/api/v1/acl", { rootId, path, entries });
}

export function deleteAclEntry(id: number) {
  return srvCall(activeServerId(), "DELETE", `/api/v1/acl/${id}`);
}

export function getAclSubjects(): Promise<AclSubjects> {
  return srvCall<AclSubjects>(activeServerId(), "GET", "/api/v1/acl/subjects");
}

// ---------- AI ----------

export async function aiDescribe(entryPath: string): Promise<DescRecord | { text: string }> {
  const a = active();
  if (a.kind === "local") {
    return (await invoke("ai_describe_local", { rootId: a.rootId, path: entryPath, ai: cfg.ai })) as DescRecord;
  }
  return srvCall<{ text: string }>(a.serverId!, "POST", "/api/v1/ai/describe", {
    rootId: a.rootId,
    path: entryPath,
  });
}

export async function aiSearch(query: string): Promise<SearchHit[]> {
  const a = active();
  if (a.kind === "local") {
    const recs = (await invoke("ai_search_local", { query })) as DescRecord[];
    return recs.map((r) => ({ ...r, score: 1 }));
  }
  const hits = await srvCall<SearchHit[]>(a.serverId!, "POST", "/api/v1/ai/search", { query });
  return hits ?? [];
}

// 辅助：把相对路径解析为当前本地根目录的绝对路径（仅本地模式）
export function joinLocalAbs(rel: string): string {
  const a = active();
  const root = cfg.localRoots.find((r) => r.id === a.rootId);
  if (!root) throw new Error("未选择本地目录");
  const clean = rel.replace(/^\/+/, "");
  return root.path.replace(/\/+$/, "") + "/" + clean;
}
