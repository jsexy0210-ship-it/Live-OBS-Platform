"use client";

import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { PageHead, useConfirm, ListTable, ListHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { dayTime } from "../../../_components/partners";

// MA-055 도우미 답변 자료 관리. API: /api/admin/assistant/docs(·/{id}), /api/admin/assistant/questions.
// 게시한 자료만 답변 근거가 된다. 공개 자료(공지·자주 묻는 질문·도움말)만 넣고 파트너스 개인정보·주문 데이터는 넣지 않는다.
type Doc = { id: string; title: string; body: string; published: boolean; version: number; updatedAt: string };
type Q = { id: string; question: string; answer: string | null; answered: boolean; createdAt: string };
type Draft = { id: string | null; title: string; body: string; published: boolean; version: number };
const EMPTY: Draft = { id: null, title: "", body: "", published: false, version: 0 };

export default function AssistantDocsPage() {
  const { me } = useAdmin();
  const { confirm } = useConfirm();
  const canEdit = adminCan(me.role, "support.manage");
  const [docs, setDocs] = useState<Doc[] | "loading" | "error">("loading");
  const [qs, setQs] = useState<{ items: Q[]; next: string | null } | "loading" | "error">("loading");
  const [unanswered, setUnanswered] = useState(true);
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
  useEffect(() => void loadQs(), [loadQs]);

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

  return (
    <>
      <AdminTopbar crumb="고객지원 › 도우미 답변 자료" />
      <main className="main">
        <PageHead description="도우미 답변에 사용하는 자료와 답하지 못한 질문을 확인합니다." title="도우미 답변 자료" />
        <div className="col" style={{ gap: 20 }}>
          <section className="au-list-section" style={{ gap: 14 }} aria-labelledby="ast-docs">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 className="t-hl1" id="ast-docs">
                자료
              </h2>
              {canEdit && !draft && (
                <button className="btn btn-pri" type="button" onClick={() => { setError(null); setDraft(EMPTY); }}>
                  자료 추가
                </button>
              )}
            </div>
            <span className="t-c1 c-alt">공개해도 되는 자료만 넣어 주십시오. 파트너스 개인정보와 주문 정보는 넣지 마십시오. 「게시」를 켠 자료만 도우미가 답할 때 씁니다.</span>
            {draft && (
              <form className="col" style={{ gap: 10 }} onSubmit={save}>
                <input className="inp" aria-label="제목" placeholder="제목" maxLength={100} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} disabled={busy} />
                <textarea className="inp" aria-label="내용" placeholder="내용(4,000자까지)" rows={10} maxLength={4000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} disabled={busy} />
                <label className="chk">
                  <input type="checkbox" checked={draft.published} onChange={(e) => setDraft({ ...draft, published: e.target.checked })} disabled={busy} />
                  도우미 답변에 사용(게시)
                </label>
                {error && <span className="t-c1" role="alert" style={{ color: "var(--neg-text, #c00)" }}>{error}</span>}
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn-pri" type="submit" disabled={busy}>저장</button>
                  <button className="btn btn-out" type="button" onClick={() => setDraft(null)} disabled={busy}>취소</button>
                </div>
              </form>
            )}
            {docs === "loading" ? <LoadingRows rows={3} /> : docs === "error" ? <ErrorState title="자료를 불러오지 못했습니다." onRetry={() => void loadDocs()} /> : docs.length === 0 ? (
              <div className="st"><span className="t">등록한 자료가 없습니다.</span></div>
            ) : (
              <>
                <ListHead total={docs.length} loaded />
                <ListTable><table className="tbl">
                <thead><tr><th>제목</th><th>상태</th><th>수정일</th>{canEdit && <th>작업</th>}</tr></thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id} data-testid="doc-row">
                      <td className="fw6">{d.title}</td>
                      <td><span className={`bdg ${d.published ? "b-done" : "b-gray"}`}>{d.published ? "게시" : "임시 저장"}</span></td>
                      <td className="num">{dayTime(d.updatedAt)}</td>
                      {canEdit && (
                        <td className="row" style={{ gap: 6 }}>
                          <button className="btn btn-sm btn-out btn-level-table" type="button" onClick={() => { setError(null); setDraft({ id: d.id, title: d.title, body: d.body, published: d.published, version: d.version }); }}>수정</button>
                          <button className="btn btn-sm btn-out btn-level-table" type="button" onClick={() => void remove(d)}>삭제</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table></ListTable>
              </>
            )}
          </section>

          <section className="au-list-section" style={{ gap: 14 }} aria-labelledby="ast-qs">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 className="t-hl1" id="ast-qs">질문 기록</h2>
              <label className="chk">
                <input type="checkbox" checked={unanswered} onChange={(e) => { setQs("loading"); setUnanswered(e.target.checked); }} />
                답하지 못한 질문만
              </label>
            </div>
            {qs === "loading" ? <LoadingRows rows={3} /> : qs === "error" ? <ErrorState title="질문 기록을 불러오지 못했습니다." onRetry={() => void loadQs()} /> : qs.items.length === 0 ? (
              <div className="st"><span className="t">질문이 없습니다.</span></div>
            ) : (
              <>
                <>
                  <ListHead total={qs.items.length} loaded />
                  <ListTable><table className="tbl">
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
                </table></ListTable>
                </>
                {qs.next && <button className="btn btn-out" type="button" onClick={() => void loadQs(qs.next!)}>더 보기</button>}
              </>
            )}
          </section>
        </div>
        {toast && <Toast text={toast} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
