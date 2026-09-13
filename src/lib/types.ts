export interface FsEntry {
  name: string;
  path: string; // 相对根目录，正斜杠
  isDir: boolean;
  size: number;
  mtime: number; // epoch ms
  kind: string;
}

export interface TrashItem {
  trashId: string;
  rootId: string;
  relPath: string;
  name: string;
  isDir: boolean;
  size: number;
  deletedAt: number;
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

export interface AppConfig {
  localRoots: RootConf[];
  servers: ServerConf[];
  ai: AIConf;
  active?: ActiveConf | null;
}

export interface ServerRoot {
  id: string;
  name: string;
}

// 时间字段：本地模式为 epoch 毫秒，服务端为 RFC3339 字符串
export type TimeVal = number | string;

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

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
