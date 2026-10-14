// 0.3.7 需求3 第 4 档「ffmpeg 解码 + 原生渲染」播放器：
// 视频帧由用户配置的 ffmpeg **按需逐帧解码**（`ffmpeg_frame`：`-ss` 定位 + 单帧
// mjpeg 管道，不落盘产物），前端画布上屏；音轨单独一次性抽取（`ffmpeg_audio_track`
// → `<key>.audio.m4a` 入媒体缓存）用 <audio> 驱动时钟与对时——与「ffmpeg 转码」档的
// 本质区别是：不生成整文件 H.264 产物、边解边播、无等待整段转码。
// 有意的能力边界（面板如实声明）：帧率受逐帧解码 CPU 开销限制（约 2–4 fps，
// 定位"能看能听可控"而非流畅高帧）；不渲染字幕轨。
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import * as api from "../lib/api";

interface Props {
  /** 媒体缓存绝对路径（fs_media_cache/srv_media_cache 就绪后的产物） */
  mediaPath: string;
  onExternal(): void;
}

function fmtClock(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const sec = Math.floor(s % 60);
  const min = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(min)}:${p(sec)}` : `${p(min)}:${p(sec)}`;
}

export default function FfmRenderView(p: Props) {
  const [info, setInfo] = useState<{ codec: string; duration: number; audio: boolean } | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [hint, setHint] = useState(""); // 无音轨/提取失败 → 静音内部时钟
  const [err, setErr] = useState("");
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 单飞取帧：进行中记录"最新想要的时间"，完成即跳播到最新（拖拽不堆积请求）
  const flight = useRef({ busy: false, want: -1 });
  const clockRef = useRef<number | null>(null); // 无音轨内部时钟（setInterval 句柄）
  const tRef = useRef(0); // 时钟权威读数（state 仅驱动渲染）

  // 换文件复位
  useEffect(() => {
    setInfo(null);
    setAudioUrl("");
    setHint("");
    setErr("");
    setPlaying(false);
    setT(0);
    tRef.current = 0;
    flight.current = { busy: false, want: -1 };
  }, [p.mediaPath]);

  // 媒体信息 + 音轨抽取
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await api.videoMediaInfo(p.mediaPath);
        if (cancelled) return;
        setInfo(m);
        if (m.audio) {
          try {
            const track = await api.ffmpegAudioTrack(p.mediaPath);
            if (!cancelled) setAudioUrl(convertFileSrc(track));
          } catch (ex) {
            if (!cancelled) setHint("音轨提取不可用，静音播放（逐帧解码不受影响）");
          }
        } else {
          if (!cancelled) setHint("无音轨，静音播放");
        }
      } catch (ex) {
        if (!cancelled) setErr(String(ex));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [p.mediaPath]);

  // 解帧并上屏（单飞 + 跳播最新）
  async function pump(time: number) {
    const f = flight.current;
    if (f.busy) {
      f.want = time; // 覆盖为最新请求
      return;
    }
    f.busy = true;
    let cur = time;
    try {
      for (;;) {
        const buf = await api.ffmpegFrameBytes(p.mediaPath, cur);
        const bmp = await createImageBitmap(new Blob([buf], { type: "image/jpeg" }));
        const cv = canvasRef.current;
        if (cv) {
          if (cv.width !== bmp.width || cv.height !== bmp.height) {
            cv.width = bmp.width;
            cv.height = bmp.height;
          }
          cv.getContext("2d")?.drawImage(bmp, 0, 0);
        }
        bmp.close();
        if (f.want < 0 || Math.abs(f.want - cur) < 0.2) break;
        cur = f.want;
        f.want = -1;
      }
    } catch (ex) {
      setErr(String(ex));
    } finally {
      f.busy = false;
      f.want = -1;
    }
  }

  // 首帧海报（就绪即解码 0 秒）
  useEffect(() => {
    if (info && !err) void pump(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  // 有音轨：audio 时钟驱动（timeupdate 约 4Hz——逐帧档定位"可控"非高帧率）
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !audioUrl) return;
    const onTick = () => {
      const now = a.currentTime;
      tRef.current = now;
      setT(now);
      if (!a.paused) void pump(now);
    };
    a.addEventListener("timeupdate", onTick);
    return () => a.removeEventListener("timeupdate", onTick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // 无音轨：内部 500ms 时钟推进
  useEffect(() => {
    if (audioUrl) return;
    if (!playing) {
      if (clockRef.current) {
        window.clearInterval(clockRef.current);
        clockRef.current = null;
      }
      return;
    }
    clockRef.current = window.setInterval(() => {
      const dur = info?.duration ?? 0;
      let nt = tRef.current + 0.5;
      if (dur > 0 && nt >= dur) {
        nt = dur;
        setPlaying(false);
      }
      tRef.current = nt;
      setT(nt);
      void pump(nt);
    }, 500);
    return () => {
      if (clockRef.current) {
        window.clearInterval(clockRef.current);
        clockRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, audioUrl, info]);

  const togglePlay = () => {
    if (!info) return;
    const next = !playing;
    setPlaying(next);
    if (audioUrl && audioRef.current) {
      if (next) {
        if (info.duration > 0 && audioRef.current.currentTime >= info.duration - 0.3) seekTo(0, next);
        void audioRef.current.play().catch(() => undefined);
      } else audioRef.current.pause();
    }
  };

  const seekTo = (v: number, autoplay = playing) => {
    tRef.current = v;
    setT(v);
    if (audioRef.current) {
      try {
        audioRef.current.currentTime = v;
      } catch {
        /* 元数据未就绪时忽略，帧照常显示 */
      }
    }
    void pump(v);
    if (autoplay && !playing) setPlaying(true);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", gap: 8 }}>
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", borderRadius: 8, overflow: "hidden" }}>
        {!info && !err && (
          <div className="empty">
            <div className="spinner" /> 解码信息探测中…
          </div>
        )}
        {err && <div className="error-bar" style={{ margin: 12 }}>{err}</div>}
        {info && (
          <canvas
            ref={canvasRef}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: err ? "none" : "block" }}
          />
        )}
        {audioUrl && (
          <audio ref={audioRef} src={audioUrl} preload="auto" onEnded={() => setPlaying(false)} />
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button className="btn" disabled={!info} onClick={togglePlay}>
          {playing ? "⏸ 暂停" : "▶ 播放"}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0.1, info?.duration ?? 0.1)}
          step={0.25}
          value={t}
          disabled={!info || (info.duration ?? 0) <= 0}
          style={{ flex: 1 }}
          onChange={(ev) => seekTo(Number(ev.target.value))}
        />
        <span className="dim" style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {fmtClock(t)} / {info && info.duration > 0 ? fmtClock(info.duration) : "--:--"}
        </span>
        <button className="btn" onClick={p.onExternal}>
          外部播放器
        </button>
      </div>
      <div className="dim tip">
        ffmpeg 逐帧解码 + 原生渲染：帧不落盘、边解边播（帧率随 CPU 约 2–4 fps，不含字幕轨）
        {hint ? ` · ${hint}` : ""}
        {info?.codec ? ` · 源编码 ${info.codec}` : ""}
      </div>
    </div>
  );
}
