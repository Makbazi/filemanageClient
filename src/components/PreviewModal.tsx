// 文件预览（需求11；0.1.7 查看/预览分离）：预览=本弹窗（缩放式"缩略图"观感），
// 图片/视频/音频/PDF 统一经媒体缓存 + asset 协议（无大小限制，大图片可预览）；
// 文本 data URL（≤8MiB）；其余类型提示下载。双击可预览类型在主区全屏查看（FileViewer）。
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { FsEntry } from "../lib/types";
import * as api from "../lib/api";
import { fmtSize } from "../lib/format";
import { TEXT_EXT, extOf, b64ToText } from "../lib/preview";
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
  const e = p.entry;
  const ext = extOf(e.name);
  const isText = TEXT_EXT.includes(ext);
  const isPdf = ext === "pdf";
  const isMedia = e.kind === "video" || e.kind === "audio";

  useEffect(() => {
    let cancelled = false;
    const src = api.source();
    (async () => {
      setBusy(true);
      setErr("");
      try {
        if (isText) {
          const d = await src.previewData(e);
          if (!cancelled) setDataUrl(d);
        } else if (e.kind === "image" || isMedia || isPdf) {
          // 0.1.7：图像改走缓存通道（fs/srv_media_cache 无大小上限），大图预览不再报"文件过大"
          const path = await src.mediaCache(e);
          if (!cancelled) setMediaUrl(convertFileSrc(path));
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

  return (
    <Modal title={`预览 · ${e.name}（${fmtSize(e.size)}）`} onClose={p.onClose} width={860}>
      <div className="preview-box">
        {busy && (
          <div className="empty">
            <div className="spinner" /> 加载预览…
          </div>
        )}
        {err && <div className="error-bar">{err}</div>}
        {!busy && !err && mediaUrl && e.kind === "image" && <img src={mediaUrl} alt={e.name} />}
        {!busy && !err && dataUrl && <pre className="preview-text">{b64ToText(dataUrl)}</pre>}
        {!busy && !err && mediaUrl && e.kind === "video" && (
          <video className="preview-video" src={mediaUrl} controls autoPlay />
        )}
        {!busy && !err && mediaUrl && e.kind === "audio" && (
          <div className="preview-audio-wrap">
            <audio src={mediaUrl} controls autoPlay style={{ width: "100%" }} />
          </div>
        )}
        {!busy && !err && mediaUrl && isPdf && (
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
