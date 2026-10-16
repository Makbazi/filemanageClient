// 预览/查看的统一分类与解码辅助（0.1.7：PreviewModal 与 FileViewer 共享同一
// "可预览集合"判定，保证双击查看与预览弹窗支持的文件类型严格一致）。
import type { FsEntry } from "./types";

/** 可内联显示的文本类扩展名（原 PreviewModal 私有表，现共享） */
export const TEXT_EXT = ["txt", "md", "log", "json", "yaml", "yml", "toml", "ini", "conf", "csv",
  "go", "py", "js", "ts", "tsx", "jsx", "rs", "java", "c", "cpp", "h", "css", "html", "sh", "sql", "xml"];

export type ViewableType = "image" | "video" | "audio" | "pdf" | "text";

/** 相机 RAW 扩展名（0.2.1；与 Rust thumb.rs is_raw_ext 一致，全小写）。
 *  浏览器不能直接解码 RAW——Rust 侧从文件内提取相机生成的内嵌 JPEG 预览入
 *  媒体缓存后按普通图片显示（查看/预览/网格缩略图全链路）。 */
export const RAW_EXT = [
  "nef", "nrw", // Nikon
  "cr2", "cr3", "crw", // Canon
  "arw", "srf", "sr2", // Sony
  "raf", // Fuji
  "rw2", "raw", // Panasonic
  "orf", // Olympus
  "pef", // Pentax
  "rwl", // Leica
  "3fr", // Hasselblad
  "srw", // Samsung
  "x3f", // Sigma
  "erf", "fff", // Epson / Phase One
  "mrw", "dcs", "kdc", // Minolta / Kodak
];

/** 视频扩展名（0.3.0 需求1；与 Rust localfs kind_of / player.rs VIDEO_EXT 同表）。
 *  H.264/H.265 常见容器与裸流（hevc/h265/h264/m2ts/mpg…），kind 不改、显示分流一律走
 *  viewableType（RAW 先例）。有意不含 `ts`——与 TypeScript 源文件冲突（TEXT_EXT/code）。 */
export const VIDEO_EXT = [
  "mp4", "m4v", "mkv", "mov", "webm", "avi", "flv", "wmv", "ogv", "ogm",
  "m2ts", "mts", "mpg", "mpeg", "mpe", "3gp", "vob", "hevc", "h265", "h264",
];

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** 可在主区"查看"（内联覆盖层）/弹窗"预览"/网格缩略图的类型；null=不支持（仅下载）。
 *  0.2.1：相机 RAW 按扩展名并入 image——服务端 kind 不含 RAW（kind=other），
 *  本地 kind_of 亦不改（两模式 kind 口径以服务端为准），显示分流一律走本函数。 */
export function viewableType(e: FsEntry): ViewableType | null {
  if (e.isDir) return null;
  const ext = extOf(e.name);
  if (e.kind === "image" || RAW_EXT.includes(ext)) return "image";
  if (e.kind === "video" || VIDEO_EXT.includes(ext)) return "video";
  if (e.kind === "audio") return "audio";
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
