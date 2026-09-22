// 临时分享链接（需求7）：创建（有效期自定义、密码默认随机生成）与管理
// （改密码/改有效期/免密/禁用/删除）。仅服务端模式。
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { ShareLinkInfo } from "../lib/types";
import { fmtTime } from "../lib/format";
import { Modal, Confirm } from "./Modals";
import { IconLink, IconTrash, IconPencil, IconPlus, IconCopy } from "./icons";

interface Props {
  /** 创建目标；null 表示只管理已有链接 */
  target: { path: string; isDir: boolean } | null;
  onClose(): void;
  notify(msg: string): void;
}

const EXPIRY_PRESETS: [string, number | null][] = [
  ["1 小时", 1],
  ["24 小时", 24],
  ["7 天", 24 * 7],
  ["30 天", 24 * 30],
  ["永久有效", null],
];

type PwdMode = "auto" | "custom" | "none";

export default function ShareDialog(p: Props) {
  const [tab, setTab] = useState<"create" | "manage">(p.target ? "create" : "manage");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // 创建表单：number=小时数；null=永久；"custom"=自定义小时数
  const [expiry, setExpiry] = useState<number | null | "custom">(24);
  const [customHours, setCustomHours] = useState("48");
  const [pwdMode, setPwdMode] = useState<PwdMode>("auto");
  const [customPwd, setCustomPwd] = useState("");
  const [created, setCreated] = useState<ShareLinkInfo | null>(null);

  // 管理列表
  const [links, setLinks] = useState<ShareLinkInfo[] | null>(null);
  const [editing, setEditing] = useState<ShareLinkInfo | null>(null);
  const [delTarget, setDelTarget] = useState<ShareLinkInfo | null>(null);

  const baseUrl = (api.getConfig().servers.find((s) => s.id === api.active().serverId)?.baseUrl ?? "").replace(/\/+$/, "");

  async function loadLinks() {
    setBusy(true);
    try {
      setLinks((await api.listShareLinks()) ?? []);
      setErr("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (tab === "manage") loadLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function create() {
    if (!p.target) return;
    setBusy(true);
    setErr("");
    try {
      const hours =
        expiry === null ? undefined : expiry === "custom" ? Number(customHours) || undefined : expiry;
      const l = await api.createShareLink({
        rootId: api.active().rootId,
        path: p.target.path,
        expiresInHours: hours,
        noPassword: pwdMode === "none",
        password: pwdMode === "custom" ? customPwd : undefined,
      });
      setCreated(l);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const fullUrl = (token: string) => `${baseUrl}/s/${token}`;

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => p.notify("已复制"),
      () => p.notify("复制失败")
    );
  }

  return (
    <Modal title="临时分享链接" onClose={p.onClose} width={720}>
      <div className="tabs">
        {p.target && (
          <button className={tab === "create" ? "tab active" : "tab"} onClick={() => setTab("create")}>
            <IconPlus size={13} /> 创建链接
          </button>
        )}
        <button className={tab === "manage" ? "tab active" : "tab"} onClick={() => setTab("manage")}>
          <IconLink size={13} /> 管理链接
        </button>
      </div>

      {err && <div className="error-bar">{err}</div>}

      {tab === "create" && p.target && !created && (
        <div className="tab-body">
          <div className="field">
            <label>分享目标</label>
            <input readOnly value={`${p.target.isDir ? "[目录] " : ""}${p.target.path || "/"}`} />
          </div>
          <div className="field">
            <label>有效期</label>
            <div className="radio-row">
              {EXPIRY_PRESETS.map(([label, v]) => (
                <label key={label} className="radio-item">
                  <input type="radio" name="expiry" checked={expiry === v} onChange={() => setExpiry(v)} />
                  {label}
                </label>
              ))}
              <label className="radio-item">
                <input type="radio" name="expiry" checked={expiry === "custom"} onChange={() => setExpiry("custom")} />
                自定义
                <input
                  className="sf-num"
                  type="number"
                  min="1"
                  value={customHours}
                  onChange={(e) => setCustomHours(e.target.value)}
                  disabled={expiry !== "custom"}
                />
                小时
              </label>
            </div>
          </div>
          <div className="field">
            <label>访问密码</label>
            <div className="radio-row">
              <label className="radio-item">
                <input type="radio" name="pwd" checked={pwdMode === "auto"} onChange={() => setPwdMode("auto")} />
                随机生成（六位字母+数字，推荐）
              </label>
              <label className="radio-item">
                <input type="radio" name="pwd" checked={pwdMode === "custom"} onChange={() => setPwdMode("custom")} />
                自定义
                <input className="sf-input" value={customPwd} onChange={(e) => setCustomPwd(e.target.value)} disabled={pwdMode !== "custom"} placeholder="自定义访问密码" />
              </label>
              <label className="radio-item">
                <input type="radio" name="pwd" checked={pwdMode === "none"} onChange={() => setPwdMode("none")} />
                无需密码
              </label>
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={p.onClose}>取消</button>
            <button className="btn primary" disabled={busy || (pwdMode === "custom" && !customPwd)} onClick={create}>
              {busy ? "创建中…" : "创建链接"}
            </button>
          </div>
        </div>
      )}

      {tab === "create" && created && (
        <div className="tab-body">
          <div className="notice">链接创建成功！密码只显示这一次，请立即保存。</div>
          <div className="field">
            <label>访问 URL</label>
            <div className="copy-row">
              <input readOnly value={fullUrl(created.token)} />
              <button className="btn small" onClick={() => copy(fullUrl(created.token))}><IconCopy size={13} /> 复制</button>
            </div>
          </div>
          {created.password && (
            <div className="field">
              <label>访问密码（明文，仅本次显示）</label>
              <div className="copy-row">
                <input readOnly value={created.password} className="pwd-reveal" />
                <button className="btn small" onClick={() => copy(created.password!)}><IconCopy size={13} /> 复制</button>
              </div>
            </div>
          )}
          <div className="dim tip">
            有效期至：{created.expiresAt ? fmtTime(created.expiresAt) : "永久"} · 可在「管理链接」中修改密码/有效期或删除。
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => { setCreated(null); setTab("manage"); }}>管理链接</button>
            <button className="btn primary" onClick={p.onClose}>完成</button>
          </div>
        </div>
      )}

      {tab === "manage" && (
        <div className="tab-body">
          {busy && !links && <div className="empty"><div className="spinner" /> 加载中…</div>}
          {links && links.length === 0 && <div className="empty">还没有分享链接</div>}
          {links && links.length > 0 && (
            <table className="table compact">
              <thead>
                <tr>
                  <th>目标</th>
                  <th>密码</th>
                  <th>有效期</th>
                  <th>状态</th>
                  <th style={{ width: 150 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id} className="row">
                    <td className="path-cell" title={fullUrl(l.token)}>
                      {l.isDir ? "[目录] " : ""}{l.path || "/"}
                    </td>
                    <td>{l.hasPassword ? "有" : "免密"}</td>
                    <td className="dim">{l.expiresAt ? fmtTime(l.expiresAt) : "永久"}</td>
                    <td>
                      {l.disabled ? <span className="badge danger">已禁用</span> :
                        l.expired || (l.expiresAt && new Date(l.expiresAt) < new Date()) ?
                        <span className="badge danger">已过期</span> : <span className="badge ok">生效中</span>}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button className="mini" title="复制 URL" onClick={() => copy(fullUrl(l.token))}><IconCopy size={13} /></button>
                        <button className="mini" title="编辑" onClick={() => setEditing(l)}><IconPencil size={13} /></button>
                        <button className="mini danger" title="删除" onClick={() => setDelTarget(l)}><IconTrash size={13} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {editing && (
        <EditLink
          link={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadLinks(); }}
          notify={p.notify}
        />
      )}
      {delTarget && (
        <Confirm
          title="删除分享链接？"
          lines={[delTarget.path || "/", "删除后该链接立即失效。"]}
          danger
          onOk={async () => {
            setDelTarget(null);
            try {
              await api.deleteShareLink(delTarget.token);
              p.notify("链接已删除");
              loadLinks();
            } catch (e) {
              setErr(String(e));
            }
          }}
          onCancel={() => setDelTarget(null)}
        />
      )}
    </Modal>
  );
}

/** 编辑链接：改密码 / 免密 / 改有效期 / 禁用开关。 */
function EditLink(props: { link: ShareLinkInfo; onClose(): void; onSaved(): void; notify(m: string): void }) {
  const l = props.link;
  const [pwd, setPwd] = useState("");
  const [noPwd, setNoPwd] = useState(false);
  const [permanent, setPermanent] = useState(!l.expiresAt);
  const [when, setWhen] = useState(() => {
    if (!l.expiresAt) return "";
    const d = new Date(l.expiresAt);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  const [disabled, setDisabled] = useState(l.disabled);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      const patch: Record<string, unknown> = { disabled };
      if (noPwd) patch.noPassword = true;
      else if (pwd) patch.password = pwd;
      patch.expiresAt = permanent ? null : new Date(when).toISOString();
      await api.updateShareLink(l.token, patch);
      props.notify("链接已更新");
      props.onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="编辑分享链接" onClose={props.onClose} width={460}>
      <div className="field">
        <label>目标</label>
        <input readOnly value={`${l.isDir ? "[目录] " : ""}${l.path || "/"}`} />
      </div>
      <div className="field">
        <label>访问密码（留空不修改）</label>
        <input value={pwd} onChange={(e) => setPwd(e.target.value)} disabled={noPwd} placeholder="新密码" />
        <label className="check-item">
          <input type="checkbox" checked={noPwd} onChange={(e) => setNoPwd(e.target.checked)} /> 无需密码
        </label>
      </div>
      <div className="field">
        <label>有效期</label>
        <label className="check-item">
          <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} /> 永久有效
        </label>
        {!permanent && <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
      </div>
      <label className="check-item">
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} /> 禁用该链接
      </label>
      {err && <div className="error-bar">{err}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={props.onClose}>取消</button>
        <button className="btn primary" disabled={busy || (!permanent && !when)} onClick={save}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </Modal>
  );
}
