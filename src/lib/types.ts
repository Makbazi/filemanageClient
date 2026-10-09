// 共享类型定义。时间字段：本地模式为 epoch 毫秒，服务端为 RFC3339 字符串。
export type TimeVal = number | string;

export interface FsEntry {
  name: string;
  path: string; // 相对根目录，正斜杠
  isDir: boolean;
  size: number;
  mtime: TimeVal;
  kind: string; // dir/image/video/audio/document/archive/code/other
  hash?: string; // 服务端 stat 返回的内容哈希（乐观并发校验用）
}

export interface TrashItem {
  trashId: string;
  rootId: string;
  relPath: string;
  name: string;
  isDir: boolean;
  size: number;
  deletedAt: TimeVal;
}

export interface RootConf {
  id: string;
  name: string;
  path: string;
}

export interface ServerConf {
  id: string;
  name: string;
  baseUrl: string;
  username?: string | null;
  token?: string | null;
  refreshToken?: string | null;
  /** 信任自签证书（服务端 TLS 自签时开启；不推荐，会跳过全部证书校验） */
  insecureTls?: boolean;
  /** 指定 CA 证书文件（PEM）；自签场景推荐，等效证书固定 */
  caFile?: string | null;
}

export type AIProvider = "none" | "openai" | "ollama";

export interface AIConf {
  provider: AIProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ActiveConf {
  kind: "local" | "server";
  serverId?: string | null;
  rootId: string;
}

/** 上次关闭时的位置（需求21） */
export interface LastLocation {
  active?: ActiveConf | null;
  view: string;
  path: string;
  viewMode: string;
}

/** 界面偏好（需求5/14/15/21） */
export interface UiConf {
  theme: string; // dark-glass | light | nord | dracula | ocean
  viewMode: "list" | "grid";
  restoreLastLocation: boolean;
  lastLocation?: LastLocation | null;
  groupByKind: boolean;
  /** 左侧导航栏折叠为小箭头标签（默认 true） */
  sidebarCollapsed: boolean;
  /** 启动时恢复各服务端登录状态（需求9，默认 true；关闭则启动即全部退出） */
  restoreSessions: boolean;
  /** 快速切换第二按钮指向的远程服务端 id（需求10） */
  lastServerId?: string | null;
  /** 关闭按钮(X)行为（0.3.0 需求2，默认 tray：隐藏到托盘；quit：退出程序） */
  closeAction: "tray" | "quit";
  /** 视频播放方式（0.3.0 需求1；0.3.3 增 ffmpeg 档。默认 system=WebView 系统解码器；
   *  ffmpeg=经配置的 ffmpeg 转码 H.264 MP4 后窗口内播放；external=外部播放器） */
  videoDecoder: "system" | "ffmpeg" | "external";
  /** 外部播放器命令（0.3.0 需求1；空=系统关联播放器，支持 {file} 占位符） */
  videoPlayerCmd?: string | null;
  /** ffmpeg 可执行文件路径（0.3.3 需求3；空=PATH 自动探测 "ffmpeg"，不内嵌） */
  ffmpegPath?: string | null;
}

/** 已记住密码的服务端账户索引（需求3；密码本体存系统凭证库） */
export interface CredRef {
  serverId: string;
  username: string;
}

/** 传输设置（需求18：KB/s，0=不限速） */
export interface TransferConf {
  uploadLimitKbps: number;
  downloadLimitKbps: number;
}

export interface AppConfig {
  localRoots: RootConf[];
  servers: ServerConf[];
  ai: AIConf;
  active?: ActiveConf | null;
  ui: UiConf;
  transfer: TransferConf;
  /** 本地回收站自动清理保留天数（默认 30；与服务端策略各自独立） */
  trashRetentionDays: number;
  /** 已记住密码的 服务端+账户 索引（需求3） */
  credentials: CredRef[];
  /** 媒体/缩略图缓存配额（0.3.2，需求3/4/5） */
  cache: CacheConf;
}

/** 媒体/缩略图缓存配额（0.3.2）：磁盘上限由 Rust LRU 执行、内存上限由前端
 *  thumbcache.ts LRU 执行；磁盘条目跨程序退出保留。 */
export interface CacheConf {
  /** 磁盘缓存上限 MB（默认 10240 = 10GB） */
  maxDiskMb: number;
  /** 缩略图内存缓存上限 MB（默认 2048 = 2GB） */
  maxMemMb: number;
}

export interface ServerRoot {
  id: string;
  name: string;
}

export interface DescRecord {
  rootId: string;
  path: string;
  name: string;
  kind: string;
  text: string;
  model: string;
  createdAt: TimeVal;
  updatedAt: TimeVal;
}

export interface SearchHit {
  path: string;
  rootId: string;
  name: string;
  kind: string;
  text: string;
  model?: string;
  updatedAt: TimeVal;
  score?: number;
}

/** 搜索条件（需求12） */
export interface SearchFilters {
  query: string;
  kinds: string[];
  sizeMin?: number;
  sizeMax?: number;
  /** epoch ms（本地）/ RFC3339（服务端），由数据源转换 */
  mtimeFrom?: number;
  mtimeTo?: number;
}

/** 文件版本（需求13；本地 id 为字符串，服务端为数字） */
export interface VersionInfo {
  id: number | string;
  versionNo: number;
  size: number;
  createdAt: TimeVal;
  createdBy?: number;
  hash?: string;
}

/** 临时分享链接（需求7） */
export interface ShareLinkInfo {
  id: number;
  token: string;
  url: string;
  rootId: string;
  path: string;
  isDir: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  disabled: boolean;
  createdBy: number;
  createdAt: string;
  expired?: boolean;
  /** 仅创建响应中携带（明文只显示一次） */
  password?: string;
}

/** 目录权限（需求8/9） */
export interface PermSet {
  view: boolean;
  download: boolean;
  upload: boolean;
  delete: boolean;
  share: boolean;
}

export interface AclEntry {
  id?: number;
  rootId?: string;
  path?: string;
  subjectType: "user" | "group" | "public";
  subjectId: number;
  perms: PermSet;
}

export interface AclSubjects {
  users: { id: number; username: string; role: string }[];
  groups: { id: number; name: string; members: number[] }[];
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
