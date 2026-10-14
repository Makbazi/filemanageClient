// 文件查看（0.1.7）：双击在主区（侧栏右侧）就地覆盖显示，非弹窗。
// 图片/视频/音频/PDF 经媒体缓存 + asset 协议（无大小限制，大图片可看）；
// 文本仍 data URL（≤8MiB）。全屏 = OS 级窗口全屏
// （core:window:allow-set-fullscreen，DOM requestFullscreen 因 webkitgtk
// 支持参差弃用）；双击图片关闭查看；Esc 先退全屏、再关查看。
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { FsEntry } from "../lib/types";
import * as api from "../lib/api";
import { fmtSize } from "../lib/format";
import { b64ToText, viewableType } from "../lib/preview";
import { kindIcon, IconX, IconExpand, IconCollapse, IconDownload } from "./icons";
import FfmRenderView from "./FfmRenderView";

interface Props {
  entry: FsEntry;
  /** 视频播放方式（0.3.0 需求1；0.3.3 增 ffmpeg 档；0.3.7 需求3 四档；App 传
   *  cfg.ui.videoDecoder）：
   *  system=窗口内 <video> 走系统解码器（失败给外部播放器/ffmpeg 转码兜底入口）；
   *  ffmpeg=媒体缓存就绪后经用户配置的 ffmpeg 转码 H.264 MP4 再窗口内播（产物复用，
   *  0.3.7 起带进度与取消）；
   *  render=ffmpeg 逐帧解码 + 原生渲染（FfmRenderView，不落盘产物、音轨单独对时）；
   *  external=直接交外部播放器。 */
  decoder?: "system" | "ffmpeg" | "render" | "external";
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
  // 0.3.3 需求3：ffmpeg 转码状态（ffmBusy=首次转码中；ffmErr=ffmpeg 不可用/转码失败）
  const [ffmBusy, setFfmBusy] = useState(false);
  const [ffmErr, setFfmErr] = useState("");
  // 0.3.7 需求1：转码进度/取消——fm-ffmpeg 事件（按 path 过滤）驱动百分比与
  // 秒数显示；ffmNote 承载"转码已取消"中态（区别于失败面板的 ffmErr）；
  // ffmPathRef 供卸载/换文件清理时调用 ffmpeg_cancel。
  const [ffmPct, setFfmPct] = useState(0);
  const [ffmSecs, setFfmSecs] = useState(0);
  const [ffmTotal, setFfmTotal] = useState(0);
  const [ffmNote, setFfmNote] = useState("");
  const ffmBusyRef = useRef(false);
  const ffmPathRef = useRef("");
  const setFfmBusyBoth = (v: boolean) => {
    ffmBusyRef.current = v;
    setFfmBusy(v);
  };
  const autoOpened = useRef(""); // external 模式自动打开去重（含 StrictMode 双执行）
  // 0.3.6 需求1（图片放大缩小查看）：查看器图片缩放——滚轮以**光标为锚**缩放
  // （0.2x–16x）、放大后拖拽平移、头部 [－][比例][＋][适应]；双击图片关闭查看的
  // 既定契约不变（挂在缩放上，关闭行为同前）。zRef 镜像当前 (z,x,y) 供事件回调
  // 即时读取（原生 wheel 监听跨渲染周期，直接读 state 会拿旧值）。
  const [zoom, setZoom] = useState(1);
  const [zOff, setZOff] = useState({ x: 0, y: 0 });
  const zRef = useRef({ z: 1, x: 0, y: 0 });
  const zoomBoxRef = useRef<HTMLDivElement | null>(null);
  const zDrag = useRef<null | { sx: number; sy: number; ox: number; oy: number }>(null);

  const zApply = (nz: number, px: number, py: number) => {
    const cur = zRef.current;
    const z = Math.min(16, Math.max(0.2, nz));
    const k = z / cur.z;
    const x = k === 1 ? cur.x : px - (px - cur.x) * k;
    const y = k === 1 ? cur.y : py - (py - cur.y) * k;
    if (k === 1 && x === cur.x && y === cur.y) return;
    zRef.current = { z, x, y };
    setZoom(z);
    setZOff({ x, y });
  };
  const zReset = () => {
    zRef.current = { z: 1, x: 0, y: 0 };
    setZoom(1);
    setZOff({ x: 0, y: 0 });
  };

  // 换文件/重载 → 复位缩放
  useEffect(() => {
    zReset();
  }, [url]);
  // 仅记录"本查看器置过的"全屏：退出时只撤销自己开启的，绝不抢 WM 自设状态
  const fsApplied = useRef(false);
  const e = p.entry;
  const type = viewableType(e) ?? "image";

  // 原生 wheel（passive:false 才能 preventDefault——React onWheel 在文档根为
  // passive，滚动会穿透到 viewer-body）；0.3.6 需求1 图片缩放
  useEffect(() => {
    const el = zoomBoxRef.current;
    if (!el || type !== "image" || !url || err) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const px = ev.clientX - (r.left + r.width / 2);
      const py = ev.clientY - (r.top + r.height / 2);
      zApply(zRef.current.z * Math.exp(-ev.deltaY * 0.0018), px, py);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, url, err]);

  // 0.3.7 需求1：转码代际令牌——换文件/换档/卸载时 +1 作废本代，旧 promise 的
  // 落地写一律跳过（防"被取消的旧转码把状态泼到新文件的面板上"）。
  const genRef = useRef(0);
  const live = (gen: number) => gen === genRef.current;

  // 起转码（三处共用：ffmpeg 档自动、system 档 HEVC 自动、失败面板一键重试）。
  // force=true 连"容器友好但编码不受支持"也重转；"转码已取消"进 ffmNote 中态
  // 而非 ffmErr 失败面板；缓存条目被淘汰类错误 → 重新入缓存自动重试一次（修
  // "重开误报 ffmpeg 不可用"残面：旧媒体缓存路径失效时不把"不可访问"当不可用报）。
  async function runTranscode(path: string, force: boolean, gen: number, retried = false): Promise<void> {
    if (!live(gen)) return;
    ffmPathRef.current = path;
    setFfmNote("");
    setFfmErr("");
    setFfmPct(0);
    setFfmSecs(0);
    setFfmTotal(0);
    setFfmBusyBoth(true);
    try {
      const playable = await api.ffmpegPlayable(path, force);
      if (!live(gen)) return;
      setUrl(convertFileSrc(playable));
      setVErr(false);
      setVKey((k) => k + 1);
    } catch (ex) {
      if (!live(gen)) return;
      const m = String(ex);
      if (m.includes("已取消")) {
        setFfmNote("转码已取消，半成品已丢弃——可随时重试转码，或用外部播放器观看");
        return;
      }
      if (!retried && /文件不可访问|不是文件|缓存目录|仅允许打开媒体缓存/.test(m)) {
        try {
          const fresh = await api.source().mediaCache(e);
          return await runTranscode(fresh, force, gen, true);
        } catch {
          setFfmErr(m);
        }
        return;
      }
      setFfmErr(m);
    } finally {
      if (live(gen)) setFfmBusyBoth(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const gen = ++genRef.current;
    const src = api.source();
    (async () => {
      setBusy(true);
      setErr("");
      setUrl("");
      setMediaPath("");
      setVErr(false);
      setInlinePlay(false);
      setFfmErr("");
      setFfmNote("");
      setFfmBusyBoth(false);
      ffmPathRef.current = "";
      try {
        if (type === "text") {
          const d = await src.previewData(e);
          if (!cancelled) setUrl(d);
        } else {
          const path = await src.mediaCache(e);
          if (!cancelled) {
            setMediaPath(path);
            // 0.3.7 需求3 第 4 档：渲染档由 FfmRenderView 接管（逐帧解码+原生
            // 渲染，音轨单独提取对时）——不需要 url/转码产物。
            if (type === "video" && p.decoder === "render") {
              setBusy(false);
              return;
            }
            // 0.3.3 需求3：ffmpeg 档——先取媒体缓存（0.3.3 起静默、无传输行），
            // 再按需转码（容器 WebView 可直放时 Rust 侧原路返回，不起子进程）
            if (type === "video" && p.decoder === "ffmpeg") {
              setBusy(false);
              await runTranscode(path, false, gen);
              return;
            }
            // 0.3.6 需求1（修"H.265 依旧无法播放"）：system 档编码探测编排——
            // `ffmpeg -i` 窥真实编码（毫秒级）；HEVC 命中则**不再让 <video> 撞一次
            // 必然失败的系统解码**：ffmpeg 可用→自动转码窗口内播放（复用转圈 UI）；
            // 转码失败（含 ffmpeg 未配置）→ 直落 ffmErr 引导面板。判不了（ffmpeg
            // 缺失探测为空）/非 HEVC → 维持系统直试原行为。
            if (type === "video" && p.decoder === "system") {
              let hevc = false;
              try {
                const codec = await api.videoCodecProbe(path);
                hevc = codec === "hevc" || codec === "hvc1" || codec === "hev1";
              } catch {
                hevc = false; // 探测不可用（含 ffmpeg 缺失）→ 走系统直试
              }
              if (cancelled) return;
              if (hevc) {
                setBusy(false);
                await runTranscode(path, true, gen);
                return;
              }
            }
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
      genRef.current++; // 本代作废：在飞转码 promise 的落地写不再进入本组件
      // 0.3.7 需求1：卸载/换文件/换档即取消在飞转码——旧实现放任 ffmpeg 在后台
      // 续写半成品（"关闭重开误报 ffmpeg 不可用"的孤儿进程根因），现在直接打断。
      if (ffmBusyRef.current && ffmPathRef.current) {
        void api.ffmpegCancel(ffmPathRef.current).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.path, String(e.mtime), type, p.decoder]);

  // 0.3.7 需求1：fm-ffmpeg 进度事件（按当前转码路径过滤）——百分比/秒数驱动面板
  useEffect(() => {
    let dead = false;
    let un: (() => void) | undefined;
    listen<{ path?: string; orig?: string; status?: string; secs?: number; total?: number; pct?: number }>(
      "fm-ffmpeg",
      (ev) => {
        const d = ev.payload;
        // 按 orig（前端传入的媒体缓存路径，未规范化）过滤——与 ffmPathRef 同源
        if (!d || (d.orig ?? d.path) !== ffmPathRef.current) return;
        if (d.status === "progress") {
          setFfmPct(Math.max(0, Math.min(99, d.pct ?? 0)));
          setFfmSecs(d.secs ?? 0);
          setFfmTotal(d.total ?? 0);
        } else if (d.status === "done") {
          setFfmPct(100);
        }
      }
    )
      .then((f) => {
        if (dead) f();
        else un = f;
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      un?.();
    };
  }, []);

  // 0.3.3 需求3：用 ffmpeg 转码后在本窗口播放（系统解码失败的一键兜底；
  // ffmpeg 模式下重试也走它）。force=true 连"容器友好但编码不受支持"也重转。
  const transcodeWithFfmpeg = async (force: boolean) => {
    if (!mediaPath || ffmBusy) return;
    await runTranscode(mediaPath, force, genRef.current);
  };

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
  // 0.3.7 需求3：渲染档接管视频分段（转码面板/系统解码/video 让位）
  const isRender = p.decoder === "render" && type === "video";
  const fmtT = (s: number) => {
    if (!isFinite(s) || s < 0) s = 0;
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${p2(Math.floor(s / 60))}:${p2(Math.floor(s % 60))}`;
  };

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
        {/* 0.3.6 需求1：图片缩放工具条（滚轮=光标为锚缩放，放大后可拖拽平移） */}
        {!busy && !err && type === "image" && (
          <>
            <button className="icon-btn" title="缩小" disabled={zoom <= 0.2} onClick={() => zApply(zoom / 1.25, 0, 0)}>
              −
            </button>
            <span className="dim zlabel-zoom">{Math.round(zoom * 100)}%</span>
            <button className="icon-btn" title="放大" disabled={zoom >= 16} onClick={() => zApply(zoom * 1.25, 0, 0)}>
              ＋
            </button>
            <button className="icon-btn" title="适应窗口" disabled={zoom === 1 && zOff.x === 0 && zOff.y === 0} onClick={zReset}>
              适应
            </button>
          </>
        )}
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
          <div
            ref={zoomBoxRef}
            className="viewer-zoombox"
            style={{ cursor: zoom > 1.01 ? (zDrag.current ? "grabbing" : "grab") : undefined }}
            onDoubleClick={exit}
            onPointerDown={(ev) => {
              if (ev.button !== 0 || zoom <= 1.01) return;
              zDrag.current = { sx: ev.clientX, sy: ev.clientY, ox: zRef.current.x, oy: zRef.current.y };
              ev.currentTarget.setPointerCapture(ev.pointerId);
            }}
            onPointerMove={(ev) => {
              const d = zDrag.current;
              if (!d) return;
              const x = d.ox + (ev.clientX - d.sx);
              const y = d.oy + (ev.clientY - d.sy);
              zRef.current = { z: zRef.current.z, x, y };
              setZOff({ x, y });
            }}
            onPointerUp={() => { zDrag.current = null; }}
            onPointerCancel={() => { zDrag.current = null; }}
          >
            <img
              className="viewer-img"
              src={url}
              alt={e.name}
              draggable={false}
              style={{ transform: `translate(${zOff.x}px, ${zOff.y}px) scale(${zoom})` }}
              onError={() => setErr("图片解码失败（格式可能不受支持），可下载后用本机看图工具打开")}
            />
          </div>
        )}
        {/* 0.3.0 需求1 + 0.3.3 需求3：视频分段——外部播放面板（已按设置外起，可重开/
            回窗口内）、ffmpeg 转码中、ffmpeg 不可用/失败面板（外部播放器兜底+重试）、
            系统解码失败面板（ffmpeg 转码 + 外部播放器兜底 + 重试）、正常 <video>（onError 捕获解码失败） */}
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
        {/* 0.3.7 需求1：转码分段显示实时进度（fm-ffmpeg 事件驱动）且可取消；
            取消/失败/已取消中态分列——"已取消"不再冒充"不可用" */}
        {!busy && !err && type === "video" && !externalMode && !isRender && ffmBusy && (
          <div className="empty">
            <div className="spinner" /> 正在用 ffmpeg 转码（该文件首次播放需要转码，之后直接复用产物）…
            <div style={{ width: "min(360px, 80%)", height: 6, borderRadius: 3, background: "rgba(128,128,128,.25)", marginTop: 10 }}>
              <div
                style={{
                  width: `${ffmPct}%`,
                  height: "100%",
                  borderRadius: 3,
                  background: "var(--accent, #4a9eff)",
                  transition: "width .3s",
                }}
              />
            </div>
            <div className="dim">
              {ffmTotal > 0 ? `${ffmPct}% · ${fmtT(ffmSecs)} / ${fmtT(ffmTotal)}` : "进度探测中…"}
            </div>
            <div className="row-actions">
              <button
                className="btn"
                onClick={() => void api.ffmpegCancel(ffmPathRef.current || mediaPath).catch(() => undefined)}
              >
                取消转码
              </button>
              <button className="btn" disabled={!mediaPath} onClick={openExternal}>
                用外部播放器打开
              </button>
            </div>
          </div>
        )}
        {!busy && !err && type === "video" && !externalMode && !isRender && !ffmBusy && ffmNote && !ffmErr && (
          <div className="empty">
            {ffmNote}
            <div className="row-actions">
              <button className="btn primary" disabled={!mediaPath} onClick={() => void transcodeWithFfmpeg(true)}>
                重试转码
              </button>
              <button className="btn" disabled={!mediaPath} onClick={openExternal}>
                用外部播放器打开
              </button>
            </div>
          </div>
        )}
        {!busy && !err && type === "video" && !externalMode && !isRender && !ffmBusy && ffmErr && (
          <div className="empty">
            ffmpeg 转码播放不可用：{ffmErr}
            <div className="dim tip">请在「设置 → 外观 → 视频播放 → ffmpeg」填写 ffmpeg 可执行文件路径（或安装后留空走 PATH）</div>
            <div className="row-actions">
              <button className="btn primary" disabled={!mediaPath} onClick={openExternal}>
                用外部播放器打开
              </button>
              <button className="btn" onClick={() => void transcodeWithFfmpeg(true)}>
                重试转码
              </button>
            </div>
          </div>
        )}
        {!busy && !err && isRender && (
          <FfmRenderView mediaPath={mediaPath} onExternal={openExternal} />
        )}
        {!busy && !err && type === "video" && !externalMode && !isRender && !ffmBusy && !ffmErr && vErr && (
          <div className="empty">
            无法在窗口内解码该视频——可能缺少系统解码组件（Windows：安装「HEVC 视频扩展」；Linux：安装
            gstreamer HEVC 插件），或容器/编码不受支持
            <div className="row-actions">
              <button className="btn primary" disabled={!mediaPath} onClick={() => void transcodeWithFfmpeg(true)}>
                用 ffmpeg 转码播放
              </button>
              <button className="btn" disabled={!mediaPath} onClick={openExternal}>
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
        {!busy && !err && type === "video" && !externalMode && !isRender && !ffmBusy && !ffmErr && !vErr && (
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
