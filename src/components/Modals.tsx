import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconAlert, IconX } from "./icons";

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
