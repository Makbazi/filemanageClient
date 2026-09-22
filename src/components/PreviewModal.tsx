// 文件预览（需求11）：图片/文本内联 data URL；视频/音频/PDF 经媒体缓存 +
// asset 协议播放（支持拖动进度）；其余类型提示下载。
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { FsEntry } from "../lib/types";
import * as api from "../lib/api";
import { fmtSize } from "../lib/format";
import { Modal } from "./Modals";
import { IconDownload } from "./icons";

const TEXT_EXT = ["txt", "md", "log", "json", "yaml", "yml", "toml", "ini", "conf", "csv",
  "go", "py", "js", "ts", "tsx", "jsx", "rs", "java", "c", "cpp", "h", "css", "html", "sh", "sql", "xml"];

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function b64ToText(dataUrl: string): string {
  const b = atob(dataUrl.split(",")[1] ?? "");
  const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

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
        if (e.kind === "image" || isText) {
          const d = await src.previewData(e);
          if (!cancelled) setDataUrl(d);
        } else if (isMedia || isPdf) {
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
        {!busy && !err && dataUrl.startsWith("data:image") && <img src={dataUrl} alt={e.name} />}
        {!busy && !err && dataUrl && !dataUrl.startsWith("data:image") && (
          <pre className="preview-text">{b64ToText(dataUrl)}</pre>
        )}
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
