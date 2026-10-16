// 轻量右键菜单（需求7）：受控渲染，点击遮罩/Escape 关闭。
import { useEffect, type ReactNode } from "react";

export interface CtxItem {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** disabled 时的悬停解释 */
  hint?: string;
  onSelect?(): void;
}

interface Props {
  x: number;
  y: number;
  items: CtxItem[];
  onClose(): void;
}

export default function ContextMenu(p: Props) {
  useEffect(() => {
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && p.onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [p]);
  return (
    <>
      <div
        className="ctx-backdrop"
        onClick={p.onClose}
        onContextMenu={(ev) => {
          ev.preventDefault();
          p.onClose();
        }}
      />
      <div
        className="ctx-menu"
        style={{ left: Math.min(p.x, window.innerWidth - 230), top: Math.min(p.y, window.innerHeight - p.items.length * 34 - 20) }}
      >
        {p.items.map((it) => (
          <button
            key={it.label}
            className="ctx-item"
            disabled={it.disabled}
            title={it.disabled ? it.hint : undefined}
            onClick={() => {
              if (it.disabled) return;
              p.onClose();
              it.onSelect?.();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </div>
    </>
  );
}
