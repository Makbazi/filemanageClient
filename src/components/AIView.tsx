import { useState } from "react";
import type { AppConfig, SearchHit } from "../lib/types";
import { aiSearch } from "../lib/api";
import { fmtTime } from "../lib/format";
import { IconSearch, IconSparkles, kindIcon } from "./icons";

interface Props {
  cfg: AppConfig;
  onOpenSettings(): void;
  onJump(hit: SearchHit): void;
}

export default function AIView(p: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const ready = p.cfg.ai.provider !== "none" && p.cfg.ai.model !== "";

  async function search() {
    if (!query.trim()) return;
    setBusy(true);
    setErr("");
    try {
      setHits(await aiSearch(query.trim()));
    } catch (e) {
      setErr(String(e));
      setHits(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>
            <IconSparkles size={20} /> AI 助手
          </h2>
          <p className="dim">为文件生成内容描述（图像 / 视频 / 音频 / 文档），并按文字描述查找文件。</p>
        </div>
      </div>

      {!ready && (
        <div className="notice">
          <IconSparkles size={15} />
          <span>AI 能力未配置（接口已预留，支持 OpenAI 兼容云服务与本地 Ollama）。</span>
          <button className="btn small" onClick={p.onOpenSettings}>
            去设置
          </button>
        </div>
      )}

      <div className="search-hero card">
        <div className="search-row">
          <IconSearch size={16} />
          <input
            className="search-input"
            placeholder="用一句话描述你要找的文件，例如「去年在海边拍的日落照片」"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
          <button className="btn primary" onClick={search} disabled={busy || !query.trim()}>
            {busy ? "检索中…" : "按描述查找"}
          </button>
        </div>
        {err && <div className="error-bar">{err}</div>}
        {hits && (
          <div className="hit-list">
            {hits.length === 0 && <div className="empty">没有匹配的描述结果，可先在文件列表中用 ✨ 生成描述。</div>}
            {hits.map((h, i) => (
              <div key={i} className="hit">
                <span className={`ficon k-${h.kind}`}>{kindIcon(h.kind)}</span>
                <div className="hit-main">
                  <div className="hit-name">{h.name}</div>
                  <div className="hit-text">{h.text}</div>
                  <div className="hit-meta dim">
                    {h.path} · {fmtTime(h.updatedAt)} {h.model ? `· ${h.model}` : ""}
                  </div>
                </div>
                <button className="btn small" onClick={() => p.onJump(h)}>
                  定位文件
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
