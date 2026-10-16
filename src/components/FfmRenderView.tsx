// 0.3.7 需求3 第 4 档「ffmpeg 解码 + 原生渲染」播放器；0.3.8 需求2 提速改版：
// 帧由 `ffmpeg_frames` **批量连续解码**供给（一次进程解出 ~1.5 秒的帧序列，
// 顺序解码免逐帧起进程/逐帧 seek），前端按源帧率节拍上屏——帧率从 0.3.7 的
// 2–4fps 提升到接近源帧率（1080p 软解 30fps 量级）。音轨仍一次性抽取
// （`ffmpeg_audio_track` → `<key>.audio.m4a` 入媒体缓存）用 <audio> 驱动时钟
// 与对时；与「ffmpeg 转码」档的本质区别不变：不生成整文件产物、边解边播。
// 有意的能力边界（面板如实声明）：帧率受 CPU 解码速度限制（快则源帧率、慢则
// 丢帧追赶，不积压）；音画对齐精度 ±0.5s 量级；不渲染字幕轨。
// 0.3.9（修黑屏）：①绘帧从"drawSeq 只认最新发起"改为**串行单飞 + 最新待绘
// 覆盖**——旧逻辑在 60fps 节拍（Windows 实测）下每张 createImageBitmap 还没
// resolve 就被下一张作废，**全部帧被丢弃=画面恒黑而音频照常走到片尾**；串行
// 方案保证解码慢时自动降上屏帧率但绝不一帧不画。②暂停态也绘制进度条 seek 后
// 的首帧（海报帧，旧实现 play 前恒黑）。③t=0 首批"无输出帧"不再静默判"已到
// 末尾"——改判错误可见（真到末尾的续批请求仍静默停批）。配套 Rust split_jpegs
// 段链校验修复（表字节里的 FF D9 假边界不再产出半帧坏 JPEG）。
import { useEffect, useRef, useState } from "react";
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

interface QueuedFrame {
  bytes: ArrayBuffer;
  t: number;
}

export default function FfmRenderView(p: Props) {
  const [info, setInfo] = useState<api.VideoMediaInfo | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [hint, setHint] = useState(""); // 无音轨/提取失败 → 静音内部时钟
  const [err, setErr] = useState("");
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // —— 0.3.8 批量解码渲染引擎 ——
  const qRef = useRef<QueuedFrame[]>([]); // 已解码待上屏帧（时间升序）
  const reqRef = useRef({ busy: false, want: null as number | null }); // 批量取帧单飞
  const endedRef = useRef(false); // 末尾无更多帧（停发请求，seek 复位）
  const fpsRef = useRef(30); // 解码/节拍帧率（源 fps 夹 0.5..60，未知按 30）
  const genRef = useRef(0); // 文件代际：换文件/卸载作废全部在飞回调
  const tRef = useRef(0); // 静音模式内部时钟读数
  const playingRef = useRef(false);
  const audioUrlRef = useRef("");
  const durRef = useRef(0);
  // 0.3.9 串行绘帧通道：busy=当前有一张在解码；pending=解码期间最新到的一帧
  const drawBusyRef = useRef(false);
  const pendingDrawRef = useRef<QueuedFrame | null>(null);
  const hasDrawnRef = useRef(false); // 成功上屏过至少一帧
  playingRef.current = playing;
  audioUrlRef.current = audioUrl;

  // 换文件复位
  useEffect(() => {
    genRef.current++;
    qRef.current = [];
    reqRef.current = { busy: false, want: null };
    endedRef.current = false;
    pendingDrawRef.current = null;
    drawBusyRef.current = false; // 在飞 resolve 因 gen 失配走 drain()→释放 busy
    hasDrawnRef.current = false;
    tRef.current = 0;
    setInfo(null);
    setAudioUrl("");
    setHint("");
    setErr("");
    setPlaying(false);
    setT(0);
    return () => {
      genRef.current++; // 卸载：在飞批量/绘帧回调全部作废
    };
  }, [p.mediaPath]);

  // 媒体信息 + 音轨抽取
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await api.videoMediaInfo(p.mediaPath);
        if (cancelled) return;
        setInfo(m);
        durRef.current = m.duration;
        const f = m.fps && m.fps > 0 && m.fps <= 60 ? m.fps : 30;
        fpsRef.current = Math.max(0.5, Math.min(60, f));
        if (m.audio) {
          try {
            const track = await api.ffmpegAudioTrack(p.mediaPath);
            if (!cancelled) setAudioUrl(api.mediaUrl(track));
          } catch {
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

  // 0.3.9（修黑屏①）：串行单飞绘帧——同一时刻只解一张 JPEG，解码期间到达的
  // 更新帧进 pendingDrawRef（覆盖式，只留最新）；resolve 后画"当时最新的一张"。
  // 旧 drawSeq 作废式在 60fps 节拍 + 解码 >16ms 时每一张都被后继作废→全黑。
  function showFrame(bytes: ArrayBuffer, gen: number) {
    if (gen !== genRef.current) return;
    const frame = { bytes, t: 0 };
    if (drawBusyRef.current) {
      pendingDrawRef.current = frame;
      return;
    }
    drawBusyRef.current = true;
    const drain = () => {
      const next = pendingDrawRef.current;
      if (next && gen === genRef.current) {
        pendingDrawRef.current = null;
        paint(next);
      } else {
        pendingDrawRef.current = null;
        drawBusyRef.current = false;
      }
    };
    const paint = (f: QueuedFrame) => {
      void createImageBitmap(new Blob([f.bytes], { type: "image/jpeg" }))
        .then((bmp) => {
          if (gen === genRef.current) {
            const cv = canvasRef.current;
            if (cv) {
              if (cv.width !== bmp.width || cv.height !== bmp.height) {
                cv.width = bmp.width;
                cv.height = bmp.height;
              }
              cv.getContext("2d")?.drawImage(bmp, 0, 0);
            }
          }
          bmp.close();
          drain();
        })
        .catch(() => drain());
    };
    paint(frame);
  }

  // 批量取帧（单飞：进行中记录最新 want，完成即续取；末尾/取消静默）
  async function pumpBatch() {
    const r = reqRef.current;
    if (r.busy) return;
    const at = r.want;
    if (at == null || endedRef.current) return;
    r.want = null;
    r.busy = true;
    const gen = genRef.current;
    const fps = fpsRef.current;
    const n = Math.max(10, Math.round(fps * 1.5));
    try {
      const frames = await api.ffmpegFramesBatch(p.mediaPath, at, n, fps, 720);
      if (gen !== genRef.current) return;
      if (r.want == null) {
        // 无更新的 seek 请求：按序入队；时间戳取"请求时刻 + i/fps"近似
        for (let i = 0; i < frames.length; i++) {
          qRef.current.push({ bytes: frames[i], t: at + i / fps });
        }
      }
    } catch (ex) {
      const m = String(ex);
      // 0.3.9（修黑屏③）："已到末尾/无输出帧"只在**确实往后播过**（seek 点
      // >0.2s 或已成功上屏过帧）时才静默停批；起播首批就无帧=异常，必须可见
      // 报错——旧逻辑把一切空输出吞成 ended，黑屏无声无息。
      if (/已到末尾|无输出帧/.test(m) && (at > 0.2 || hasDrawnRef.current)) {
        endedRef.current = true; // 播到结尾：停止补帧直到 seek
      } else if (gen === genRef.current) {
        setErr(m);
      }
    } finally {
      r.busy = false;
      if (r.want != null && gen === genRef.current) void pumpBatch();
    }
  }

  // 从新位置重新解码（清队续取）
  function restartAt(time: number) {
    qRef.current = [];
    endedRef.current = false;
    reqRef.current.want = time;
    void pumpBatch();
  }

  // 渲染主循环：rAF 节拍（audio 时钟优先，无音轨走内部时钟）
  useEffect(() => {
    if (!info || err) return;
    const gen = genRef.current;
    let raf = 0;
    let lastWall = performance.now();
    const step = () => {
      raf = requestAnimationFrame(step);
      if (gen !== genRef.current) return;
      const a = audioRef.current;
      const audio = audioUrlRef.current && a;
      const now = performance.now();
      if (!audio && playingRef.current) {
        tRef.current += (now - lastWall) / 1000;
      }
      lastWall = now;
      const pos = audio ? a.currentTime : Math.min(tRef.current, durRef.current > 0 ? durRef.current : tRef.current);
      setT(pos);
      // 静音模式自然到终点：停表
      if (!audio && playingRef.current && durRef.current > 0 && tRef.current >= durRef.current - 0.05) {
        setPlaying(false);
      }
      const dt = 1 / fpsRef.current;
      const q = qRef.current;
      // 音画漂移过大（解码被 CPU 挤停/系统睡眠后唤醒）：直接以音轨时钟重启解码
      if (playingRef.current && audio && q.length > 2 && (q[0].t > pos + 2.5 || q[q.length - 1].t < pos - 2.5)) {
        restartAt(pos);
        return;
      }
      // 追帧：丢弃已过时帧、把最新的一张交给串行绘帧通道（0.3.9：暂停态也绘制
      // ——seek 后先出海报帧；解码慢时自动降帧率，但不再"全帧作废恒黑屏"）
      let latest: QueuedFrame | null = null;
      while (q.length && q[0].t <= pos + dt * 0.6) {
        latest = q.shift() ?? null;
      }
      if (latest) {
        hasDrawnRef.current = true;
        showFrame(latest.bytes, gen);
      }
      // 预取补队（仅播放中）：队尾不足 0.9 秒覆盖且无在飞批量时
      if (!playingRef.current) return;
      const tailT = q.length ? q[q.length - 1].t : pos - 1;
      if (tailT < pos + 0.9 && reqRef.current.want == null) {
        restartIfNeeded(q.length ? q[q.length - 1].t + dt : pos);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, err]);

  // 续取（队尾接应）：有在飞批量则记 want，完成即续
  function restartIfNeeded(time: number) {
    const r = reqRef.current;
    if (r.busy) {
      r.want = time;
      return;
    }
    r.want = time;
    void pumpBatch();
  }

  // 首帧海报：信息就绪即解 0 秒
  useEffect(() => {
    if (info && !err) restartAt(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  const togglePlay = () => {
    if (!info) return;
    const next = !playing;
    setPlaying(next);
    if (audioUrlRef.current && audioRef.current) {
      if (next) {
        if (info.duration > 0 && audioRef.current.currentTime >= info.duration - 0.3) seekTo(0, true);
        else void audioRef.current.play().catch(() => undefined);
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
    restartAt(v);
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
        ffmpeg 批量连续解码 + 原生渲染：帧不落盘、边解边播（节拍≈源帧率 {info && info.fps ? `${Math.round(info.fps)}fps` : ""}，
        CPU 慢时自适应丢帧追赶不积压，音画对齐 ±0.5s，不含字幕轨）
        {hint ? ` · ${hint}` : ""}
        {info?.codec ? ` · 源编码 ${info.codec}` : ""}
      </div>
    </div>
  );
}
