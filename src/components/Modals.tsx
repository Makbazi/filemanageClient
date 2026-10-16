import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconAlert, IconX } from "./icons";
import { fmtSize } from "../lib/format";

export function Modal(props: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [props]);
  // 0.1.4 层级修复（需求1，Windows"添加服务端"被设置卡片遮挡）：对话框统一 portal 到
  // body——嵌套对话框（如分享/版本历史内的确认框、设置页内的服务端表单）不再被困在父
  // .modal-mask 内：父遮罩的 backdrop-filter 会为 fixed 后代建立包含块+层叠上下文，
  // 叠加 .modal-body 的 overflow 裁剪，WebView2 下子对话框即被压在父卡片之下。
  // React 树位置不变（state/事件不受影响），仅 DOM 挂点变为 body 直接子节点，
  // 挂载顺序=显示顺序，后开的对话框恒在先开的之上。
  return createPortal(
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={{ maxWidth: props.width ?? 480 }}>
        <div className="modal-head">
          <div className="modal-title">
            {props.icon}
            <span>{props.title}</span>
          </div>
          <button className="icon-btn" onClick={props.onClose} aria-label="关闭">
            <IconX size={16} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** 通用确认框；danger=true 用于删除等破坏性操作（红色按钮 + 警示图标）。 */
export function Confirm(props: {
  title: string;
  lines?: string[];
  danger?: boolean;
  confirmText?: string;
  /** 破坏性操作要求输入关键词后才能确认（二次确认强化） */
  typedConfirm?: string;
  onOk: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const blocked = !!props.typedConfirm && typed !== props.typedConfirm;
  return (
    <Modal title={props.title} onClose={props.onCancel} width={420}>
      {props.lines && props.lines.length > 0 && (
        <ul className="confirm-list">
          {props.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {props.danger && (
        <div className="confirm-warn">
          <IconAlert size={16} />
          <span>删除后文件将移入回收站，可在回收站中还原。</span>
        </div>
      )}
      {props.typedConfirm && (
        <div className="field">
          <label>
            请输入 <b>{props.typedConfirm}</b> 以确认此操作
          </label>
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={props.typedConfirm}
          />
        </div>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onCancel}>
          取消
        </button>
        <button
          className={props.danger ? "btn danger" : "btn primary"}
          disabled={blocked}
          onClick={props.onOk}
        >
          {props.confirmText ?? "确认"}
        </button>
      </div>
    </Modal>
  );
}

/** 单行输入框（新建文件夹 / 重命名）。 */
export function Prompt(props: {
  title: string;
  label: string;
  initial: string;
  placeholder?: string;
  onOk: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const ok = () => {
    const v = value.trim();
    if (v) props.onOk(v);
  };
  return (
    <Modal title={props.title} onClose={props.onCancel} width={400}>
      <div className="field">
        <label>{props.label}</label>
        <input
          autoFocus
          value={value}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ok()}
        />
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onCancel}>
          取消
        </button>
        <button className="btn primary" disabled={!value.trim()} onClick={ok}>
          确定
        </button>
      </div>
    </Modal>
  );
}

/** 0.3.2 目录重传差异询问：远端同名但内容不同（哈希不等）的文件清单，
 *  逐个选"覆盖/跳过"+批量按钮；取消=整次目录上传中止（onDecide(null)）。
 *  默认选择：覆盖（本地通常就是要更新的一方）。 */
export function UploadDiffDialog(p: {
  serverName: string;
  dirName: string;
  rows: { rel: string; name: string; size: number }[];
  onDecide(d: Record<string, "ovr" | "skip"> | null): void;
}) {
  const [choice, setChoice] = useState<Record<string, "ovr" | "skip">>(() => {
    const m: Record<string, "ovr" | "skip"> = {};
    for (const r of p.rows) m[r.rel] = "ovr";
    return m;
  });
  const setAll = (v: "ovr" | "skip") => {
    const m: Record<string, "ovr" | "skip"> = {};
    for (const r of p.rows) m[r.rel] = v;
    setChoice(m);
  };
  return (
    <Modal title="目录上传：发现同名但内容不同的文件" onClose={() => p.onDecide(null)} width={560}>
      <div className="field">
        <p className="dim">
          上传「{p.dirName}」到 {p.serverName}：以下 {p.rows.length} 个文件在服务端已存在且内容不同
          （大小相同但内容哈希不一致）。选择覆盖（服务端会先保存旧版本）或跳过（保留远端）。
        </p>
      </div>
      <div className="diff-list">
        {p.rows.map((r) => (
          <div key={r.rel} className="diff-row" title={r.rel}>
            <span className="diff-name">{r.name}</span>
            <span className="diff-size dim">{fmtSize(r.size)}</span>
            <label className="diff-opt">
              <input
                type="radio"
                name={`diff-${r.rel}`}
                checked={choice[r.rel] === "ovr"}
                onChange={() => setChoice((prev) => ({ ...prev, [r.rel]: "ovr" }))}
              />
              覆盖
            </label>
            <label className="diff-opt">
              <input
                type="radio"
                name={`diff-${r.rel}`}
                checked={choice[r.rel] === "skip"}
                onChange={() => setChoice((prev) => ({ ...prev, [r.rel]: "skip" }))}
              />
              跳过
            </label>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={() => p.onDecide(null)}>
          取消
        </button>
        <button className="btn" onClick={() => setAll("skip")}>
          全部跳过
        </button>
        <button className="btn" onClick={() => setAll("ovr")}>
          全部覆盖
        </button>
        <button className="btn primary" onClick={() => p.onDecide(choice)}>
          开始上传
        </button>
      </div>
    </Modal>
  );
}
