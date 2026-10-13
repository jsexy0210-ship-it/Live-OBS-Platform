"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { dayTime } from "../../../_components/partners";

// MA-055 도우미 답변 자료 관리. API: /api/admin/assistant/docs(·/{id}), /api/admin/assistant/questions.
// 게시한 자료만 답변 근거가 된다. 공개 자료(공지·자주 묻는 질문·도움말)만 넣고 파트너스 개인정보·주문 데이터는 넣지 않는다.
type Doc = { id: string; title: string; body: string; published: boolean; version: number; updatedAt: string };
type Q = { id: string; question: string; answer: string | null; answered: boolean; createdAt: string };
type Draft = { id: string | null; title: string; body: string; published: boolean; version: number };
type Tab = "docs" | "qs" | "unanswered";
type Chip = "all" | "on" | "draft";
const EMPTY: Draft = { id: null, title: "", body: "", published: false, version: 0 };

export default function AssistantDocsPage() {
  const { me } = useAdmin();
  const { confirm } = useConfirm();
  const canEdit = adminCan(me.role, "support.manage");
  const [docs, setDocs] = useState<Doc[] | "loading" | "error">("loading");
  const [qs, setQs] = useState<{ items: Q[]; next: string | null } | "loading" | "error">("loading");
  const [tab, setTab] = useState<Tab>("docs");
  const [chip, setChip] = useState<Chip>("all");
  const unanswered = tab === "unanswered";
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadDocs = useCallback(async () => {
    const r = await adminApi<{ items: Doc[] }>("/api/admin/assistant/docs");
    setDocs(r.ok ? r.data.items : "error");
  }, []);
  const loadQs = useCallback(async (cursor?: string) => {
    const r = await adminApi<{ items: Q[]; nextCursor: string | null }>(`/api/admin/assistant/questions?${unanswered ? "unanswered=1&" : ""}${cursor ? `cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!r.ok) return setQs("error");
    setQs((prev) => ({ items: [...(cursor && typeof prev === "object" ? prev.items : []), ...r.data.items], next: r.data.nextCursor }));
  }, [unanswered]);
  useEffect(() => void loadDocs(), [loadDocs]);
  useEffect(() => {
    if (tab !== "docs") void loadQs();
  }, [loadQs, tab]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    const body = { title: draft.title, body: draft.body, published: draft.published, expectedVersion: draft.version };
    const r = draft.id ? await adminApi(`/api/admin/assistant/docs/${draft.id}`, { method: "PUT", json: body }) : await adminApi("/api/admin/assistant/docs", { method: "POST", json: body });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409) void loadDocs();
      return setError(r.message ?? "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오.");
    }
    setDraft(null);
    setToast("저장했습니다.");
    void loadDocs();
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
          if (r.status === 409) void loadDocs();
          return r.message ?? "자료를 숨기지 못했습니다. 잠시 후 다시 시도해 주십시오.";
        }
        return undefined;
      },
    });
    if (ok) setToast("자료를 숨겼습니다.");
    void loadDocs();
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
          if (r.status === 409) void loadDocs();
          return r.message ?? "자료를 지우지 못했습니다. 잠시 후 다시 시도해 주십시오.";
        }
        message = "자료를 지웠습니다.";
        return undefined;
      },
    });
    if (ok) setToast(message);
    void loadDocs();
  };

  const list = docs === "loading" || docs === "error" ? [] : docs;
  const onCount = list.filter((d) => d.published).length;
  const shown = list.filter((d) => (chip === "all" ? true : chip === "on" ? d.published : !d.published));
  const edit = (d: Doc) => {
    setError(null);
    setDraft({ id: d.id, title: d.title, body: d.body, published: d.published, version: d.version });
  };
  const TABS: [Tab, string][] = [
    ["docs", `답변 근거 문서${docs === "loading" || docs === "error" ? "" : ` ${list.length}`}`],
    ["qs", "질문 기록"],
    ["unanswered", "답하지 못한 질문"],
  ];

  return (
    <>
      <AdminTopbar crumb="고객지원 › 도우미 답변 자료" />
      <main className="main">
        <PageHead
          title="도우미 답변 자료"
          actions={
            <>
              <Link className="btn btn-out" href="/admin/settings/assistant">
                도우미 설정
              </Link>
              {canEdit && (
                <button className="btn" type="button" onClick={() => { setTab("docs"); setError(null); setDraft(EMPTY); }}>
                  문서 등록
                </button>
              )}
            </>
          }
        />
        <div className="seg" role="tablist" aria-label="도우미 자료" style={{ alignSelf: "flex-start" }}>
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => { if (k !== "docs") setQs("loading"); setTab(k); }}>
              {label}
            </button>
          ))}
        </div>
        <div className="col" style={{ gap: 20 }}>
          {tab === "docs" && (
            <section className="col" style={{ gap: 14 }} aria-label="답변 근거 문서">
              <span className="t-c1 c-alt">공개해도 되는 자료만 넣어 주십시오. 파트너스 개인정보와 주문 정보는 넣지 마십시오. 「사용 중」인 문서만 도우미가 답할 때 씁니다.</span>
              {draft && (
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
                    <button className="btn btn-out" type="button" onClick={() => setDraft(null)} disabled={busy}>취소</button>
                  </div>
                </form>
              )}
              <div className="seg" role="radiogroup" aria-label="상태" style={{ alignSelf: "flex-start" }}>
                {([["all", "전체", list.length], ["on", "사용 중", onCount], ["draft", "초안", list.length - onCount]] as [Chip, string, number][]).map(([k, label, n]) => (
                  <button key={k} type="button" role="radio" aria-checked={chip === k} className={chip === k ? "on" : ""} onClick={() => setChip(k)}>
                    {label}
                    {docs === "loading" || docs === "error" ? "" : ` ${n}`}
                  </button>
                ))}
              </div>
              <div className="card">
                {docs === "loading" ? <LoadingRows rows={3} /> : docs === "error" ? <ErrorState title="자료를 불러오지 못했습니다." onRetry={() => void loadDocs()} /> : shown.length === 0 ? (
                  <div className="st"><span className="t">{list.length === 0 ? "등록한 문서가 없습니다." : "조건에 맞는 문서가 없습니다."}</span></div>
                ) : (
                  <table className="tbl">
                    <thead><tr><th>문서 제목</th><th>마지막 수정</th><th>상태</th>{canEdit && <th>관리</th>}</tr></thead>
                    <tbody>
                      {shown.map((d) => (
                        <tr key={d.id} data-testid="doc-row">
                          <td className="fw6">{d.title}</td>
                          <td className="num">{dayTime(d.updatedAt)}</td>
                          <td><span className={`bdg ${d.published ? "b-done" : "b-gray"}`}>{d.published ? "사용 중" : "초안"}</span></td>
                          {canEdit && (
                            <td className="row" style={{ gap: 6 }}>
                              <button className="btn btn-sm btn-out" type="button" onClick={() => edit(d)}>수정</button>
                              {d.published ? (
                                <button className="btn btn-sm btn-out" type="button" onClick={() => void hide(d)}>숨기기</button>
                              ) : (
                                <button className="btn btn-sm btn-out" type="button" onClick={() => void remove(d)}>삭제</button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <span className="t-c1 c-alt">문서를 고치면 다음 질문부터 바로 반영됩니다 · 이전 답변은 바뀌지 않습니다</span>
            </section>
          )}

          {tab !== "docs" && (
            <section className="card col" style={{ gap: 14 }} aria-label={tab === "qs" ? "질문 기록" : "답하지 못한 질문"}>
              {qs === "loading" ? <LoadingRows rows={3} /> : qs === "error" ? <ErrorState title="질문 기록을 불러오지 못했습니다." onRetry={() => void loadQs()} /> : qs.items.length === 0 ? (
                <div className="st"><span className="t">질문이 없습니다.</span></div>
              ) : (
                <>
                  <table className="tbl">
                    <thead><tr><th>질문</th><th>결과</th><th>시각</th></tr></thead>
                    <tbody>
                      {qs.items.map((q) => (
                        <tr key={q.id}>
                          <td>{q.question}</td>
                          <td><span className={`bdg ${q.answered ? "b-done" : "b-wait"}`}>{q.answered ? "답변" : "답하지 못함"}</span></td>
                          <td className="num">{dayTime(q.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {qs.next && <button className="btn btn-out" type="button" onClick={() => void loadQs(qs.next!)}>더 보기</button>}
                </>
              )}
            </section>
          )}
        </div>
        {toast && <Toast text={toast} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
