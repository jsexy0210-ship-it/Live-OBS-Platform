"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { PageHead } from "../../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../../../components/seller/States";
import { confirmLeave, useSmartBack, useUnsavedGuard } from "../../../../../../../../lib/client/navigation";
import { adminCan } from "../../../../../../../../lib/server/authz/permissions";
import { adminApi, failMessage } from "../../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../../_components/AdminShell";
import { listReturnTo } from "../../../../../_components/selection";

type Connection = { key: string; name: string; purpose: string; expiresOn: string | null; version: number };
type Load = "loading" | "error" | "missing" | Connection;
const LIST = "/admin/ops/infra";

export default function ConnectionExpiryPage() {
  const { connectionKey } = useParams<{ connectionKey: string }>();
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "infra.manage");
  const [returnTo, setReturnTo] = useState(LIST);
  const smartBack = useSmartBack(returnTo);
  const [state, setState] = useState<Load>("loading");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const reqId = useRef(0);
  const connection = typeof state === "string" ? null : state;
  const dirty = connection !== null && expiry !== (connection.expiresOn ?? "");
  const release = useUnsavedGuard(dirty);
  useEffect(() => setReturnTo(listReturnTo(new URLSearchParams(window.location.search).get("returnTo"), LIST)), []);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState("loading");
    const r = await adminApi<{ connections: Connection[] }>("/api/admin/infra/connections");
    if (id !== reqId.current) return;
    if (!r.ok) return setState("error");
    const found = r.data.connections.find(c => c.key === connectionKey);
    setState(found ?? "missing");
    setExpiry(found?.expiresOn ?? "");
    setError(null);
  }, [connectionKey]);
  useEffect(() => { void load(); return () => { ++reqId.current; }; }, [load]);
  const leave = async (next = smartBack) => {
    if (busy || !confirmLeave(dirty)) return;
    await release();
    next();
  };
  const refresh = async () => {
    if (busy || !confirmLeave(dirty)) return;
    await release();
    await load();
  };
  const saveExpiry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connection || !dirty || busy || !canEdit) return;
    setBusy(true);
    setError(null);
    const c = connection;
    const r = await adminApi(`/api/admin/infra/connections/${encodeURIComponent(c.key)}/expiry`, { method: "PUT", json: { expiresOn: expiry || null, expectedVersion: c.version } });
    if (!r.ok) {
      setBusy(false);
      setError(r.status === 409 ? `${c.name}: 다른 곳에서 먼저 바뀌었습니다. 새로 불러온 뒤 다시 입력해 주십시오.` : `${c.name}: ${failMessage(r, "저장하지 못했습니다.")}`);
      return;
    }
    await release();
    setBusy(false);
    setToast("만료일을 저장했습니다 · 로그 추적에 남겼습니다");
    await load();
  };
  return <><AdminTopbar crumb="운영 › 인프라 · 비용 › 연결 만료일" /><main className="main">
    <PageHead title="연결 만료일 상세" back={returnTo} onBack={() => leave()} actions={<Link className="btn btn-out" href={returnTo}>목록</Link>} />
    {typeof state === "string" ? state === "loading" ? <LoadingRows rows={2} /> : <ErrorState title={state === "missing" ? "연결을 찾을 수 없습니다." : "연결을 불러오지 못했습니다."} onRetry={() => void load()} /> : <section className="card pad-l col" style={{ gap: 16 }}>
      <h2>{state.name}</h2><p>{state.purpose}</p>
      {canEdit ? <form className="col" style={{ gap: 16 }} onSubmit={saveExpiry}>
        <label className="fld">{state.name} 만료일<input className="inp" type="date" aria-label={`${state.name} 만료일`} value={expiry} onChange={e => setExpiry(e.target.value)} disabled={busy} /></label>
        <span className="t-c1 c-alt">만료일을 바꾸면 로그 추적에 남습니다 · 남은 일수는 매일 00:00 다시 계산</span>
        {error && <span className="err" role="alert">{error}</span>}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}><button className="btn btn-out" type="button" disabled={busy} onClick={() => void leave()}>취소</button><button className="btn btn-out" type="button" disabled={busy} onClick={() => void refresh()}>새로 불러오기</button><button className="btn" type="submit" disabled={busy || !dirty}>{busy ? "저장 중" : "만료일 저장"}</button></div>
      </form> : <p>만료일 {state.expiresOn ?? "—"} · 최고관리자만 바꿀 수 있습니다.</p>}
    </section>}
    {toast && <Toast text={toast} onDone={() => setToast(null)} />}
  </main></>;
}
