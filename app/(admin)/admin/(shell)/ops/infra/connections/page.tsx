"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormRow, FormSection, PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../../components/seller/States";
import { confirmLeave, useSmartBack, useUnsavedGuard } from "../../../../../../../lib/client/navigation";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { adminApi, failMessage } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { listReturnTo } from "../../../../_components/selection";

type Connection = { key: string; name: string; purpose: string; expiresOn: string | null; version: number };
const LIST = "/admin/ops/infra";
export default function ConnectionExpiriesPage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "infra.manage");
  const [returnTo, setReturnTo] = useState(LIST);
  const smartBack = useSmartBack(returnTo);
  const [state, setState] = useState<"loading" | "error" | { conns: Connection[] }>("loading");
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [savingExpiry, setSavingExpiry] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const reqId = useRef(0);
  const data = typeof state === "string" ? null : state;
  const dirty = data !== null && data.conns.some(c => (expiry[c.key] ?? "") !== (c.expiresOn ?? ""));
  const release = useUnsavedGuard(dirty);
  useEffect(() => setReturnTo(listReturnTo(new URLSearchParams(window.location.search).get("returnTo"), LIST)), []);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState("loading");
    const r = await adminApi<{ connections: Connection[] }>("/api/admin/infra/connections");
    if (id !== reqId.current) return;
    if (!r.ok) return setState("error");
    setExpiry(Object.fromEntries(r.data.connections.map(c => [c.key, c.expiresOn ?? ""])));
    setState({ conns: r.data.connections });
  }, []);
  useEffect(() => { void load(); return () => { ++reqId.current; }; }, [load]);
  const leave = async () => {
    if (savingExpiry || !confirmLeave(dirty)) return;
    await release();
    smartBack();
  };
  const saveExpiry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data || !canEdit || savingExpiry) return;
    const changed = data.conns.filter((c) => (expiry[c.key] ?? "") !== (c.expiresOn ?? ""));
    if (changed.length === 0) return;
    setSavingExpiry(true);
    let failed = "";
    for (const c of changed) {
      const r = await adminApi(`/api/admin/infra/connections/${encodeURIComponent(c.key)}/expiry`, { method: "PUT", json: { expiresOn: expiry[c.key] || null, expectedVersion: c.version } });
      if (!r.ok) {
        failed = r.status === 409 ? `${c.name}: 다른 곳에서 먼저 바뀌었습니다. 새로 불러옵니다.` : `${c.name}: ${failMessage(r, "저장하지 못했습니다.")}`;
        break;
      }
    }
    await release();
    setSavingExpiry(false);
    setToast(failed ? { text: failed, neg: true } : { text: "만료일을 저장했습니다 · 로그 추적에 남겼습니다" });
    await load();
  };
  return <><AdminTopbar crumb="운영 › 인프라 · 비용 › 전체 만료일 설정" /><main className="main">
    <PageHead title="전체 연결 만료일 설정" back={returnTo} onBack={leave} description="여러 연결의 만료일을 한 번에 저장합니다. 기존 연결 순서대로 처리하고 첫 실패에서 중단한 뒤 최신 값을 불러옵니다." actions={<Link className="btn btn-out" href={returnTo}>목록</Link>} />
    {typeof state === "string" ? state === "loading" ? <LoadingRows rows={3} /> : <ErrorState title="연결을 불러오지 못했습니다." onRetry={() => void load()} /> : <form className="col" style={{ gap: 16 }} onSubmit={saveExpiry}>
      <FormSection title="연결별 만료일">{state.conns.map(c => <FormRow key={c.key} label={c.name} htmlFor={`expiry-${c.key}`} help={c.purpose}>{canEdit ? <input id={`expiry-${c.key}`} className="inp" type="date" aria-label={`${c.name} 만료일`} value={expiry[c.key] ?? ""} onChange={e => setExpiry({ ...expiry, [c.key]: e.target.value })} disabled={savingExpiry} /> : <span>{c.expiresOn ?? "—"}</span>}</FormRow>)}</FormSection>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}><button className="btn btn-out" type="button" onClick={() => void leave()} disabled={savingExpiry}>취소</button>{canEdit && <button className="btn" type="submit" disabled={savingExpiry || !dirty}>{savingExpiry ? "저장 중" : "만료일 저장"}</button>}</div>
    </form>}
    {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
  </main></>;
}
