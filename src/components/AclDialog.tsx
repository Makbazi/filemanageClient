// 目录权限与分享设置（需求8/9）：查看/下载/上传/删除/分享 五个权限位，
// 主体可为 用户 / 用户组 / 公开（匿名访客）。仅服务端模式。
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { AclEntry, AclSubjects, PermSet } from "../lib/types";
import { Modal } from "./Modals";
import { IconPlus, IconTrash } from "./icons";

interface Props {
  path: string; // 目录相对路径（"" = 根）
  onClose(): void;
  notify(msg: string): void;
}

const PERMS: [keyof PermSet, string][] = [
  ["view", "查看"],
  ["download", "下载"],
  ["upload", "上传"],
  ["delete", "删除"],
  ["share", "分享"],
];

function emptyPerms(): PermSet {
  return { view: true, download: false, upload: false, delete: false, share: false };
}

export default function AclDialog(p: Props) {
  const [entries, setEntries] = useState<AclEntry[]>([]);
  const [subjects, setSubjects] = useState<AclSubjects | null>(null);
  const [effective, setEffective] = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const rootId = api.active().rootId;
      const [acl, subs] = await Promise.all([api.getAcl(rootId, p.path), api.getAclSubjects()]);
      setEntries((acl.entries ?? []).map((e) => ({ ...e, perms: { ...e.perms } })));
      setEffective(acl.effective as Record<string, boolean>);
      setSubjects(subs);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.path]);

  const subjectOptions = subjects
    ? [
        { value: "public:0", label: "公开（匿名访客）" },
        ...subjects.users.map((u) => ({ value: `user:${u.id}`, label: `用户 · ${u.username}` })),
        ...subjects.groups.map((g) => ({ value: `group:${g.id}`, label: `用户组 · ${g.name}` })),
      ]
    : [];

  const usedSubjects = new Set(entries.map((e) => `${e.subjectType}:${e.subjectId}`));

  function addEntry() {
    const next = subjectOptions.find((o) => !usedSubjects.has(o.value));
    if (!next) {
      p.notify("所有主体都已配置");
      return;
    }
    const [t, id] = next.value.split(":");
    setEntries([
      ...entries,
      { subjectType: t as AclEntry["subjectType"], subjectId: Number(id), perms: emptyPerms() },
    ]);
  }

  function setEntry(i: number, patch: Partial<AclEntry>) {
    setEntries(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }

  function changeSubject(i: number, value: string) {
    const [t, id] = value.split(":");
    setEntry(i, { subjectType: t as AclEntry["subjectType"], subjectId: Number(id) });
  }

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await api.putAcl(api.active().rootId, p.path, entries);
      p.notify("权限已保存");
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`目录权限 · ${p.path || "/"}`} onClose={p.onClose} width={720}>
      <div className="notice">
        规则：未配置权限的目录，登录用户默认全权限，匿名访客默认只读浏览；子目录继承最近祖先的配置；
        公开（匿名）主体即使勾选下载/上传/删除也不生效——远程下载与修改必须登录。
      </div>
      {effective && (
        <div className="dim tip">
          我在此目录的有效权限：{PERMS.filter(([k]) => effective[k]).map(([, l]) => l).join(" / ") || "无"}
        </div>
      )}
      {err && <div className="error-bar">{err}</div>}
      {busy && !subjects && <div className="empty"><div className="spinner" /> 加载中…</div>}

      {subjects && (
        <div className="tab-body">
          <table className="table compact">
            <thead>
              <tr>
                <th style={{ width: 200 }}>主体</th>
                {PERMS.map(([, label]) => (
                  <th key={label} style={{ textAlign: "center", width: 56 }}>{label}</th>
                ))}
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const isPublic = e.subjectType === "public";
                return (
                  <tr key={i} className="row">
                    <td>
                      <select
                        value={`${e.subjectType}:${e.subjectId}`}
                        onChange={(ev) => changeSubject(i, ev.target.value)}
                      >
                        {subjectOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                    {PERMS.map(([k]) => (
                      <td key={k} style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={e.perms[k]}
                          disabled={isPublic && k !== "view"}
                          title={isPublic && k !== "view" ? "匿名访客不可授予该权限" : undefined}
                          onChange={(ev) => setEntry(i, { perms: { ...e.perms, [k]: ev.target.checked } })}
                        />
                      </td>
                    ))}
                    <td>
                      <button className="mini danger" onClick={() => setEntries(entries.filter((_, idx) => idx !== i))}>
                        <IconTrash size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">未配置（使用默认策略）</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="toolbar-inline">
            <button className="btn small" onClick={addEntry}><IconPlus size={13} /> 添加主体</button>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={p.onClose}>关闭</button>
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? "保存中…" : "保存权限"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
