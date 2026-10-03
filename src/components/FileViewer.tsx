// 文件查看（0.1.7）：双击在主区（侧栏右侧）就地覆盖显示，非弹窗。
// 图片/视频/音频/PDF 经媒体缓存 + asset 协议（无大小限制，大图片可看）；
// 文本仍 data URL（≤8MiB）。全屏 = OS 级窗口全屏
// （core:window:allow-set-fullscreen，DOM requestFullscreen 因 webkitgtk
// 支持参差弃用）；双击图片关闭查看；Esc 先退全屏、再关查看。
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { FsEntry } from "../lib/types";
import * as api from "../lib/api";
import { fmtSize } from "../lib/format";
import { b64ToText, viewableType } from "../lib/preview";
import { kindIcon, IconX, IconExpand, IconCollapse, IconDownload } from "./icons";

interface Props {
  entry: FsEntry;
  onExit(): void;
  onDownload(e: FsEntry): void;
}

export default function FileViewer(p: Props) {
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState(""); // asset URL（图/媒体/PDF）或 data URL（文本）
  const [fs, setFs] = useState(false);
  // 仅记录"本查看器置过的"全屏：退出时只撤销自己开启的，绝不抢 WM 自设状态
  const fsApplied = useRef(false);
  const e = p.entry;
  const type = viewableType(e) ?? "image";

  useEffect(() => {
    let cancelled = false;
    const src = api.source();
    (async () => {
      setBusy(true);
      setErr("");
      setUrl("");
      try {
        if (type === "text") {
          const d = await src.previewData(e);
          if (!cancelled) setUrl(d);
        } else {
          const path = await src.mediaCache(e);
          if (!cancelled) setUrl(convertFileSrc(path));
        }
      } catch (ex) {
        if (!cancelled) setErr(String(ex));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.path, String(e.mtime), type]);

  const applyFs = async (next: boolean) => {
    try {
      await getCurrentWindow().setFullscreen(next);
      fsApplied.current = next;
    } catch {
      // 非 Tauri 运行时/权限缺失：退化为应用内覆盖层，不报错
    }
    setFs(next);
  };

  const exit = () => {
    if (fsApplied.current) void getCurrentWindow().setFullscreen(false).catch(() => undefined);
    fsApplied.current = false;
    p.onExit();
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // 弹窗/右键菜单同样监听 window Esc（如查看中收到 401 弹登录框）：让位优先关它们
      if (document.querySelector(".modal-mask, .ctx-menu")) return;
      if (fs) void applyFs(false);
      else exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs]);

  const anonymous = api.isAnonymous();
  const text = !busy && !err && type === "text" && url ? b64ToText(url) : "";

  return (
    <div className={fs ? "viewer viewer-fs" : "viewer"}>
      <div className="viewer-head">
        <span className={`ficon k-${e.kind}`}>{kindIcon(e.kind)}</span>
        <span className="viewer-name" title={e.name}>{e.name}</span>
        <span className="dim">{fmtSize(e.size)}</span>
        <div className="spacer" />
        <button
          className="icon-btn"
          title={anonymous ? "游客模式需登录才能下载" : "下载到本机"}
          disabled={anonymous}
          onClick={() => p.onDownload(e)}
        >
          <IconDownload size={15} />
        </button>
        <button className="icon-btn" title={fs ? "退出全屏" : "全屏"} onClick={() => void applyFs(!fs)}>
          {fs ? <IconCollapse size={15} /> : <IconExpand size={15} />}
        </button>
        <button className="icon-btn" title="关闭查看（Esc）" onClick={exit}>
          <IconX size={16} />
        </button>
      </div>
      <div className="viewer-body">
        {busy && (
          <div className="empty">
            <div className="spinner" /> 加载中…
          </div>
        )}
        {err && <div className="error-bar">{err}</div>}
        {!busy && !err && type === "image" && (
          <img
            className="viewer-img"
            src={url}
            alt={e.name}
            draggable={false}
            onDoubleClick={exit}
            onError={() => setErr("图片解码失败（格式可能不受支持），可下载后用本机看图工具打开")}
          />
        )}
        {!busy && !err && type === "video" && <video className="viewer-video" src={url} controls autoPlay />}
        {!busy && !err && type === "audio" && (
          <div className="viewer-audio">
            <audio src={url} controls autoPlay style={{ width: "100%" }} />
          </div>
        )}
        {!busy && !err && type === "pdf" && <embed className="viewer-pdf" src={url} type="application/pdf" />}
        {!busy && !err && type === "text" && text && <pre className="preview-text viewer-text">{text}</pre>}
      </div>
    </div>
  );
}
