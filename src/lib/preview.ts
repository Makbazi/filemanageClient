// 预览/查看的统一分类与解码辅助（0.1.7：PreviewModal 与 FileViewer 共享同一
// "可预览集合"判定，保证双击查看与预览弹窗支持的文件类型严格一致）。
import type { FsEntry } from "./types";

/** 可内联显示的文本类扩展名（原 PreviewModal 私有表，现共享） */
export const TEXT_EXT = ["txt", "md", "log", "json", "yaml", "yml", "toml", "ini", "conf", "csv",
  "go", "py", "js", "ts", "tsx", "jsx", "rs", "java", "c", "cpp", "h", "css", "html", "sh", "sql", "xml"];

export type ViewableType = "image" | "video" | "audio" | "pdf" | "text";

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** 可在主区"查看"（内联覆盖层）/弹窗"预览"的类型；null=不支持（仅下载） */
export function viewableType(e: FsEntry): ViewableType | null {
  if (e.isDir) return null;
  if (e.kind === "image") return "image";
  if (e.kind === "video") return "video";
  if (e.kind === "audio") return "audio";
  const ext = extOf(e.name);
  if (ext === "pdf") return "pdf";
  if (TEXT_EXT.includes(ext)) return "text";
  return null;
}

/** data URL（base64）→ 文本 */
export function b64ToText(dataUrl: string): string {
  const b = atob(dataUrl.split(",")[1] ?? "");
  const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
