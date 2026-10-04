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
  /** 视频播放方式（0.3.0 需求1；App 传 cfg.ui.videoDecoder）：system=窗口内 <video>
   *  走系统解码器（失败给外部播放器兜底入口）；external=直接交外部播放器。 */
  decoder?: "system" | "external";
  onExit(): void;
  onDownload(e: FsEntry): void;
}

export default function FileViewer(p: Props) {
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [url, setUrl] = useState(""); // asset URL（图/媒体/PDF）或 data URL（文本）
  const [fs, setFs] = useState(false);
  // 0.3.0 需求1：视频解码/外部播放状态（mediaPath=媒体缓存绝对路径，外部播放器开它）
  const [mediaPath, setMediaPath] = useState("");
  const [vErr, setVErr] = useState(false); // 系统解码失败（onError）
  const [vKey, setVKey] = useState(0); // 重试时重挂 <video>
  const [inlinePlay, setInlinePlay] = useState(false); // external 模式下手动回窗口内播
  const autoOpened = useRef(""); // external 模式自动打开去重（含 StrictMode 双执行）
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
      setMediaPath("");
      setVErr(false);
      setInlinePlay(false);
      try {
        if (type === "text") {
          const d = await src.previewData(e);
          if (!cancelled) setUrl(d);
        } else {
          const path = await src.mediaCache(e);
          if (!cancelled) {
            setMediaPath(path);
            setUrl(convertFileSrc(path));
          }
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

  // external 模式：缓存路径就绪后自动打开一次（同一文件不重复起播放器）
  useEffect(() => {
    if (type !== "video" || p.decoder !== "external" || busy || !mediaPath) return;
    if (autoOpened.current === mediaPath) return;
    autoOpened.current = mediaPath;
    api.openMedia(mediaPath).catch((ex) => setErr(String(ex)));
  }, [type, p.decoder, busy, mediaPath]);

  const openExternal = () => {
    if (!mediaPath) return;
    api.openMedia(mediaPath).catch((ex) => setErr(String(ex)));
  };
  // external 且未手动切回窗口内播放 → 交给外部播放器面板
  const externalMode = p.decoder === "external" && !inlinePlay;

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
        {/* 0.3.0 需求1：视频三段式——外部播放面板（已按设置外起，可重开/回窗口内）、
            系统解码失败面板（外部播放器兜底 + 重试）、正常 <video>（onError 捕获解码失败） */}
        {!busy && !err && type === "video" && externalMode && (
          <div className="empty">
            已按设置在外部播放器中播放；若未看到播放器窗口，请检查「设置 → 外观 → 视频播放」的外部播放器命令
            <div className="row-actions">
              <button className="btn" disabled={!mediaPath} onClick={openExternal}>
                重新打开
              </button>
              <button className="btn primary" onClick={() => setInlinePlay(true)}>
                在本窗口播放
              </button>
            </div>
          </div>
        )}
        {!busy && !err && type === "video" && !externalMode && vErr && (
          <div className="empty">
            无法在窗口内解码该视频——可能缺少系统解码组件（Windows：安装「HEVC 视频扩展」；Linux：安装
            gstreamer HEVC 插件），或容器/编码不受支持
            <div className="row-actions">
              <button className="btn primary" disabled={!mediaPath} onClick={openExternal}>
                用外部播放器打开
              </button>
              <button
                className="btn"
                onClick={() => {
                  setVErr(false);
                  setVKey((k) => k + 1);
                }}
              >
                重试
              </button>
            </div>
          </div>
        )}
        {!busy && !err && type === "video" && !externalMode && !vErr && (
          <video key={vKey} className="viewer-video" src={url} controls autoPlay onError={() => setVErr(true)} />
        )}
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
