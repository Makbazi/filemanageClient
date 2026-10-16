// 缩略图内存缓存（0.3.2 需求3/5）：可见区及预取的缩略图字节驻留内存，
// 滚动回来零磁盘读零服务端往返；预算 cfg.cache.maxMemMb（默认 2GB），
// 超限按"最近使用序"淘汰并 revokeObjectURL。
//
// 取字节走 media_read_bytes IPC（返回 ArrayBuffer）——**不走**
// fetch(convertFileSrc)：CSP connect-src 不含 asset 协议，且 Windows/Linux
// 的 asset URL 形态不一；img-src 已含 blob:，双引擎一致、CSP 零改动。
// 键 = `${path}@${mtime}`（与缓存键同语义：覆盖后自然换键，不粘旧图）。
import { invoke } from "@tauri-apps/api/core";

interface Entry {
  url: string;
  bytes: number;
}

let budget = 2048 * 1024 * 1024;
const map = new Map<string, Entry>(); // 插入序=访问序（get 命中即重插）
let total = 0;

/** App 初始化/配置变更时设预算（MB）。 */
export function setThumbBudgetMb(mb: number): void {
  const next = Math.max(64, mb | 0) * 1024 * 1024;
  if (next === budget) return;
  budget = next;
  evict();
}

/** 取得某缓存文件的 blob URL（内存命中直接返回；未命中读字节建条目）。
 *  filePath = fs_thumb/srv_thumb 返回的本机路径。失败抛错（调用方队列退避）。 */
export async function thumbBlobUrl(key: string, filePath: string): Promise<string> {
  const hit = map.get(key);
  if (hit) {
    map.delete(key);
    map.set(key, hit); // 触碰=移到访问序末尾（最近使用）
    return hit.url;
  }
  const buf = (await invoke("media_read_bytes", { path: filePath })) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
  const ent: Entry = { url, bytes: buf.byteLength };
  map.set(key, ent);
  total += ent.bytes;
  evict();
  return url;
}

/** 服务端/磁盘缓存被清空时联动（cache_clear 后调用，防止 blob 悬空认知）。 */
export function clearThumbCache(): void {
  for (const e of map.values()) URL.revokeObjectURL(e.url);
  map.clear();
  total = 0;
}

function evict(): void {
  if (total <= budget) return;
  const it = map.keys();
  while (total > budget) {
    const k = it.next();
    if (k.done) break;
    const v = map.get(k.value);
    if (v) {
      total -= v.bytes;
      URL.revokeObjectURL(v.url);
      map.delete(k.value);
    }
  }
}
