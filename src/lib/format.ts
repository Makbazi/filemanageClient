import type { TimeVal } from "./types";

export function fmtSize(n: number): string {
  if (!n || n < 0) return n ? "-" : "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtTime(t: TimeVal): string {
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (!ms || isNaN(ms)) return "-";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function dirParts(path: string): { name: string; path: string }[] {
  if (!path) return [];
  const acc: { name: string; path: string }[] = [];
  let cur = "";
  for (const seg of path.split("/")) {
    cur = cur ? `${cur}/${seg}` : seg;
    acc.push({ name: seg, path: cur });
  }
  return acc;
}

export const kindLabel: Record<string, string> = {
  dir: "文件夹",
  image: "图像",
  video: "视频",
  audio: "音频",
  document: "文档",
  archive: "压缩包",
  code: "代码",
  other: "文件",
};
