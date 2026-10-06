// 文件预览（需求11；0.1.7 查看/预览分离）：预览=本弹窗（缩放式"缩略图"观感），
// 图片/视频/音频/PDF 统一经媒体缓存 + asset 协议（无大小限制，大图片可预览）；
// 文本 data URL（≤8MiB）；其余类型提示下载。双击可预览类型在主区全屏查看（FileViewer）。
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { FsEntry } from "../lib/types";
import * as api from "../lib/api";
import { fmtSize } from "../lib/format";
import { b64ToText, viewableType } from "../lib/preview";
import { Modal } from "./Modals";
import { IconDownload } from "./icons";

interface Props {
  entry: FsEntry;
  onClose(): void;
  onDownload(entry: FsEntry): void;
}

export default function PreviewModal(p: Props) {
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [dataUrl, setDataUrl] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  // 0.3.0 需求1：视频解码失败 → 外部播放器兜底入口（弹窗内不自动外起，防惊吓）
  const [mediaPath, setMediaPath] = useState("");
  const [vErr, setVErr] = useState(false);
  // 0.3.3 需求3：ffmpeg 转码兜底状态（弹窗不自动转码——只在失败面板给入口，防惊吓）
  const [ffmBusy, setFfmBusy] = useState(false);
  const [ffmErr, setFfmErr] = useState("");
  const e = p.entry;
  // 0.2.1：显示分流统一走 viewableType（与查看器同一支持集，含相机 RAW——
  // kind 为 other 但 Rust 可提取内嵌 JPEG 预览入媒体缓存，图像/媒体按图片通道）
  const vt = viewableType(e);

  useEffect(() => {
    let cancelled = false;
    const src = api.source();
    (async () => {
      setBusy(true);
      setErr("");
      setVErr(false);
      setMediaPath("");
      try {
        if (vt === "text") {
          const d = await src.previewData(e);
          if (!cancelled) setDataUrl(d);
        } else if (vt) {
          // 0.1.7：图像改走缓存通道（fs/srv_media_cache 无大小上限），大图预览不再报"文件过大"
          const path = await src.mediaCache(e);
          if (!cancelled) {
            setMediaPath(path);
            setMediaUrl(convertFileSrc(path));
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
  }, [e.path]);

  const unsupported = !busy && !err && !dataUrl && !mediaUrl;
  const openExternal = () => {
    if (!mediaPath) return;
    api.openMedia(mediaPath).catch((ex) => setErr(String(ex)));
  };
  // 0.3.3 需求3：预览失败面板的 ffmpeg 转码入口（force——容器友好但系统解不了也重转）
  const transcodeWithFfmpeg = async () => {
    if (!mediaPath || ffmBusy) return;
    setFfmErr("");
    setFfmBusy(true);
    try {
      const playable = await api.ffmpegPlayable(mediaPath, true);
      setMediaUrl(convertFileSrc(playable));
      setVErr(false);
    } catch (ex) {
      setFfmErr(String(ex));
    } finally {
      setFfmBusy(false);
    }
  };

  return (
    <Modal title={`预览 · ${e.name}（${fmtSize(e.size)}）`} onClose={p.onClose} width={860}>
      <div className="preview-box">
        {busy && (
          <div className="empty">
            <div className="spinner" /> 加载预览…
          </div>
        )}
        {err && <div className="error-bar">{err}</div>}
        {!busy && !err && mediaUrl && vt === "image" && <img src={mediaUrl} alt={e.name} />}
        {!busy && !err && dataUrl && <pre className="preview-text">{b64ToText(dataUrl)}</pre>}
        {/* 0.3.0 需求1 + 0.3.3 需求3：预览视频捕获系统解码失败（onError）→
            ffmpeg 转码 / 外部播放器兜底入口；弹窗内不自动外起/自动转码（防惊吓），
            需要双击进查看器或点下方按钮 */}
        {!busy && !err && mediaUrl && vt === "video" && !vErr && (
          <video className="preview-video" src={mediaUrl} controls autoPlay onError={() => setVErr(true)} />
        )}
        {!busy && !err && vt === "video" && vErr && (
          <div className="empty">
            无法在预览内解码该视频——可能缺少系统 HEVC/H.265 解码组件，或容器/编码不受支持
            <div className="row-actions">
              <button className="btn primary" disabled={!mediaPath || ffmBusy} onClick={() => void transcodeWithFfmpeg()}>
                {ffmBusy ? "ffmpeg 转码中…" : "用 ffmpeg 转码播放"}
              </button>
              <button className="btn" disabled={!mediaPath} onClick={openExternal}>
                用外部播放器打开
              </button>
            </div>
            {ffmErr && <div className="error-bar">{ffmErr}</div>}
          </div>
        )}
        {!busy && !err && mediaUrl && vt === "audio" && (
          <div className="preview-audio-wrap">
            <audio src={mediaUrl} controls autoPlay style={{ width: "100%" }} />
          </div>
        )}
        {!busy && !err && mediaUrl && vt === "pdf" && (
          <embed className="preview-pdf" src={mediaUrl} type="application/pdf" />
        )}
        {unsupported && (
          <div className="empty">
            该类型暂不支持预览
            <button
              className="btn primary"
              disabled={api.isAnonymous()}
              title={api.isAnonymous() ? "游客模式需登录才能下载" : undefined}
              onClick={() => p.onDownload(e)}
            >
              <IconDownload size={15} /> 下载到本机查看
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
