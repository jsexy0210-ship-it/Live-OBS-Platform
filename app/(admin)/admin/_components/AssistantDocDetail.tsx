"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { adminCan } from "../../../../lib/server/authz/permissions";
import { PageHead, useConfirm } from "../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../components/seller/States";
import { listReturnTo } from "./selection";
import { adminApi } from "./api";
import { AdminTopbar, useAdmin } from "./AdminShell";
type Doc = { id: string; title: string; body: string; published: boolean; version: number; updatedAt: string };
type Q = { id: string; question: string; answer: string | null; answered: boolean; createdAt: string };
type Draft = { id: string | null; title: string; body: string; published: boolean; version: number };
const EMPTY: Draft = { id: null, title: "", body: "", published: false, version: 0 };

export function AssistantDocDetail({ docId }: { docId: string }) {
  const { me } = useAdmin();
  const { confirm } = useConfirm();
  const router = useRouter();
  const [returnTo, setReturnTo] = useState("/admin/support/assistant");
  useEffect(() => setReturnTo(listReturnTo(new URLSearchParams(window.location.search).get("returnTo"), "/admin/support/assistant")), []);
  const canEdit = adminCan(me.role, "support.manage");
  const [doc, setDoc] = useState<Doc | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error" | "missing">("loading");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const load = useCallback(async () => {
    setConflict(false);
    if (docId === "new") { setDraft(EMPTY); setState("ok"); return; }
    const r = await adminApi<{ items: Doc[] }>("/api/admin/assistant/docs");
    if (!r.ok) return setState("error");
    const found = r.data.items.find(d => d.id === docId);
    if (!found) return setState("missing");
    setDoc(found); setDraft(found); setState("ok");
  }, [docId]);
  useEffect(() => { void load(); }, [load]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    const body = { title: draft.title, body: draft.body, published: draft.published, expectedVersion: draft.version };
    const r = draft.id ? await adminApi(`/api/admin/assistant/docs/${draft.id}`, { method: "PUT", json: body }) : await adminApi("/api/admin/assistant/docs", { method: "POST", json: body });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409) setConflict(true);
      return setError(r.message ?? "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오.");
    }
    router.push(returnTo);
  };
  const hide = async (d: Doc) => {
    const ok = await confirm({
      title: `「${d.title}」을(를) 숨기시겠습니까?`,
      body: "도우미가 이 자료로 더 이상 답하지 않습니다. 언제든 다시 쓸 수 있습니다",
      confirmLabel: "숨기기",
      danger: true,
      run: async () => {
        const r = await adminApi(`/api/admin/assistant/docs/${d.id}`, { method: "PUT", json: { title: d.title, body: d.body, published: false, expectedVersion: d.version } });
        if (!r.ok) {
          if (r.status === 409) setConflict(true);
          return r.message ?? "자료를 숨기지 못했습니다. 잠시 후 다시 시도해 주십시오.";
        }
        return undefined;
      },
    });
    if (ok) setToast("자료를 숨겼습니다.");
    void load();
  };
  const remove = async (d: Doc) => {
    let message = "";
    const ok = await confirm({
      title: `「${d.title}」을(를) 지우시겠습니까?`,
      body: "지운 자료는 도우미 답변에 더 이상 쓰이지 않으며 되돌릴 수 없습니다",
      confirmLabel: "지우기",
      danger: true,
      run: async () => {
        const r = await adminApi(`/api/admin/assistant/docs/${d.id}?expectedVersion=${d.version}`, { method: "DELETE" });
        if (!r.ok) {
          if (r.status === 409) setConflict(true);
          return r.message ?? "자료를 지우지 못했습니다. 잠시 후 다시 시도해 주십시오.";
        }
        message = "자료를 지웠습니다.";
        return undefined;
      },
    });
    if (ok) router.push(returnTo);
    else void load();
  };

  return <><AdminTopbar crumb="고객지원 › 도우미 답변 자료 › 상세" /><main className="main">
    <PageHead title={docId === "new" ? "문서 등록" : "답변 자료 상세"} actions={<Link className="btn btn-out" href={returnTo}>목록</Link>} />
    {state === "loading" ? <LoadingRows rows={3} /> : state !== "ok" ? <ErrorState title={state === "missing" ? "자료를 찾을 수 없습니다." : "자료를 불러오지 못했습니다."} onRetry={() => void load()} /> : canEdit && draft ? <>
                <form className="card pad-l col" style={{ gap: 10 }} onSubmit={save}>
                  <input className="inp" aria-label="제목" placeholder="제목" maxLength={100} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} disabled={busy} />
                  <textarea className="inp" aria-label="내용" placeholder="내용(4,000자까지)" rows={10} maxLength={4000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} disabled={busy} />
                  <label className="chk">
                    <input type="checkbox" checked={draft.published} onChange={(e) => setDraft({ ...draft, published: e.target.checked })} disabled={busy} />
                    도우미 답변에 사용
                  </label>
                  {error && <span className="t-c1" role="alert" style={{ color: "var(--neg-text, #c00)" }}>{error}</span>}
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn btn-pri" type="submit" disabled={busy}>저장</button>
                    <button className="btn btn-out" type="button" onClick={() => router.push(returnTo)} disabled={busy}>취소</button>
                  </div>
                </form>
    {conflict && <button className="btn btn-out" onClick={() => void load()}>최신 내용을 다시 불러오기</button>}
    {doc && <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      {doc.published ? <button className="btn btn-out" disabled={busy} onClick={() => void hide(doc)}>숨기기</button> : <button className="btn btn-out" disabled={busy} onClick={() => void remove(doc)}>삭제</button>}
    </div>}
    </> : doc && <section className="card pad-l"><h2>{doc.title}</h2><p style={{ whiteSpace: "pre-wrap" }}>{doc.body}</p></section>}
    {toast && <Toast text={toast} onDone={() => setToast(null)} />}
  </main></>;
}
