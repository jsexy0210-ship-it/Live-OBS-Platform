"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { dayTime } from "../../../_components/partners";

// MA-055 도우미 답변 자료 관리. API: /api/admin/assistant/docs(·/{id}), /api/admin/assistant/questions.
// 게시한 자료만 답변 근거가 된다. 공개 자료(공지·자주 묻는 질문·도움말)만 넣고 파트너스 개인정보·주문 데이터는 넣지 않는다.
type Doc = { id: string; title: string; body: string; published: boolean; version: number; updatedAt: string };
type Q = { id: string; question: string; answer: string | null; answered: boolean; createdAt: string };
type Tab = "docs" | "qs" | "unanswered";
type Chip = "all" | "on" | "draft";

export default function AssistantDocsPage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "support.manage");
  const [docs, setDocs] = useState<Doc[] | "loading" | "error">("loading");
  const [qs, setQs] = useState<{ items: Q[]; next: string | null } | "loading" | "error">("loading");
  const [tab, setTab] = useState<Tab>("docs");
  const [chip, setChip] = useState<Chip>("all");
  useEffect(() => { const p = new URLSearchParams(window.location.search); const tab = p.get("tab"); const chip = p.get("chip"); if (tab === "docs" || tab === "qs" || tab === "unanswered") setTab(tab); if (chip === "all" || chip === "on" || chip === "draft") setChip(chip); }, []);
  const unanswered = tab === "unanswered";
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

  const list = docs === "loading" || docs === "error" ? [] : docs;
  const onCount = list.filter((d) => d.published).length;
  const shown = list.filter((d) => (chip === "all" ? true : chip === "on" ? d.published : !d.published));
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
                <Link className="btn" href={`/admin/support/assistant/new?returnTo=${encodeURIComponent(`/admin/support/assistant?tab=${tab}&chip=${chip}`)}`}>
                  문서 등록
                </Link>
              )}
            </>
          }
        />
        <div className="seg" role="tablist" aria-label="도우미 자료" style={{ alignSelf: "flex-start" }}>
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => {
                if (k === tab) return;
                if (k !== "docs") setQs("loading");
                setTab(k);
              }}>
              {label}
            </button>
          ))}
        </div>
        <div className="col" style={{ gap: 20 }}>
          {tab === "docs" && (
            <section className="col" style={{ gap: 14 }} aria-label="답변 근거 문서">
              <span className="t-c1 c-alt">공개해도 되는 자료만 넣어 주십시오. 파트너스 개인정보와 주문 정보는 넣지 마십시오. 「사용 중」인 문서만 도우미가 답할 때 씁니다.</span>
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
                    <thead><tr><th>문서 제목</th><th>마지막 수정</th><th>상태</th><th>상세</th></tr></thead>
                    <tbody>
                      {shown.map((d) => (
                        <tr key={d.id} data-testid="doc-row">
                          <td className="fw6">{d.title}</td>
                          <td className="num">{dayTime(d.updatedAt)}</td>
                          <td><span className={`bdg ${d.published ? "b-done" : "b-gray"}`}>{d.published ? "사용 중" : "초안"}</span></td>
                          <td><Link className="btn btn-sm btn-out" href={`/admin/support/assistant/${d.id}?returnTo=${encodeURIComponent(`/admin/support/assistant?tab=${tab}&chip=${chip}`)}`}>상세</Link></td>
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
      </main>
    </>
  );
}
