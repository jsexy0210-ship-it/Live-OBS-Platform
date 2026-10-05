"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { Modal, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { day, reasonLabel, text, type ReviewRow } from "../../../_components/partners";
import { RejectApplicationDialog } from "../../../_components/RejectApplicationDialog";
import { takeFlash } from "../../../_components/flash";

// MA-013 가입 신청 목록(GET /api/admin/sellers/review, 모든 마스터 역할 조회): 승인 대기 쇼핑몰을 오래 기다린 순으로 보여 주고 목록에서 바로 처리한다(docs/ADMIN_OPS_UX.md).
// 확인이 필요 없는 신청은 [승인](확인 창 없이 바로)·[반려](사유 작은 창)·[상세], 확인 필요 건은 [검토](사유를 보고 명시적으로 승인)·[상세]. 처리는 최고관리자·운영만 보인다(seller.moderate).
// 처리한 행만 바뀌고(목록 전체를 다시 읽지 않는다) 칩 조건은 주소(?filter=)에 남는다. 일괄 승인·사이드 패널은 후속(P2)이다.
type Row = ReviewRow & { done?: "approved" | "rejected" };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; rows: Row[] };
const FILTERS = [
  ["all", "전체"],
  ["review", "확인 필요"],
  ["today", "오늘"],
] as const;
type Filter = (typeof FILTERS)[number][0];

const DAY = 86_400_000;
const kstDay = (ms: number) => Math.floor((ms + 9 * 3_600_000) / DAY);
const isToday = (iso: string) => kstDay(new Date(iso).getTime()) === kstDay(Date.now());
// 오래 기다린 정도: 하루 안이면 「N시간 전」, 하루가 넘으면 「승인 대기 N일째」(이틀 이상은 강조)
function waited(iso: string): { label: string; hot: boolean } {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < DAY) {
    const h = Math.floor(ms / 3_600_000);
    return { label: h < 1 ? "1시간 안" : `${h}시간 전`, hot: false };
  }
  const d = Math.floor(ms / DAY);
  return { label: `승인 대기 ${d}일째`, hot: d >= 2 };
}
const needsReview = (r: Row) => r.reviewReasons.length > 0;

function Applications() {
  const { me } = useAdmin();
  const canModerate = adminCan(me.role, "seller.moderate");
  const [q, setQ] = useUrlState({ filter: "all" });
  const filter: Filter = FILTERS.some(([k]) => k === q.filter) ? (q.filter as Filter) : "all";
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const [reviewing, setReviewing] = useState<Row | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<{ sellers: ReviewRow[] }>("/api/admin/sellers/review");
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", rows: r.data.sellers } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);
  // 상세에서 처리하고 돌아왔다면 그 결과 안내를 보인다
  useEffect(() => {
    const m = takeFlash();
    if (m) setToast({ text: m });
  }, []);
  useScrollRestore("admin-applications", state.kind === "ok");

  const rows = state.kind === "ok" ? state.rows : [];
  const open = rows.filter((r) => !r.done);
  const counts = { all: open.length, review: open.filter(needsReview).length, today: open.filter((r) => isToday(r.createdAt)).length };
  const shown = rows.filter((r) => r.done || (filter === "review" ? needsReview(r) : filter === "today" ? isToday(r.createdAt) : true));

  const mark = (id: string, done: Row["done"] | "gone") =>
    setState((s) => (s.kind === "ok" ? { kind: "ok", rows: done === "gone" ? s.rows.filter((r) => r.id !== id) : s.rows.map((r) => (r.id === id ? { ...r, done } : r)) } : s));
  const stale = (r: Row) => {
    mark(r.id, "gone");
    setToast({ text: `${r.shopName}은(는) 다른 곳에서 이미 처리됐습니다.`, neg: true });
  };
  const approve = async (r: Row) => {
    if (busy.has(r.id)) return;
    setBusy((b) => new Set(b).add(r.id));
    const res = await adminApi(`/api/admin/sellers/${encodeURIComponent(r.id)}/approve`, { method: "POST", json: {} });
    setBusy((b) => {
      const n = new Set(b);
      n.delete(r.id);
      return n;
    });
    if (res.ok) {
      mark(r.id, "approved");
      return setToast({ text: `${r.shopName} 가입을 승인했습니다.` });
    }
    if (res.status === 404 || res.status === 409) return stale(r);
    setToast({ text: failMessage(res, `${r.shopName} 승인에 실패했습니다. 행은 그대로입니다. 잠시 후 다시 시도해 주십시오.`), neg: true });
  };

  return (
    <>
      <AdminTopbar crumb="파트너스 › 가입 신청" />
      <main className="main">
        <PageHead title="가입 신청" />
        <div className="col" style={{ gap: 16 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="보기">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" className={`btn btn-sm ${filter === k ? "" : "btn-out"}`} aria-pressed={filter === k} onClick={() => setQ({ filter: k })}>
                {label}
                {state.kind === "ok" && ` ${counts[k]}`}
              </button>
            ))}
          </div>
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="가입 신청을 불러오지 못했습니다." onRetry={() => void load()} />}
            {state.kind === "ok" &&
              (shown.length === 0 ? (
                <div className="st">
                  <span className="t">{filter === "all" ? "처리할 가입 신청이 없습니다." : "조건에 맞는 가입 신청이 없습니다."}</span>
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                    <thead>
                      <tr>
                        <th>쇼핑몰</th>
                        <th>사업자</th>
                        <th>신청일 · 경과</th>
                        <th>확인</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => {
                        const w = waited(r.createdAt);
                        const review = needsReview(r);
                        const working = busy.has(r.id);
                        return (
                          <tr key={r.id} data-testid="application-row" data-done={r.done ?? ""} style={r.done ? { opacity: 0.5 } : undefined}>
                            <td className="col-text">
                              <Link className="fw6" href={`/admin/partners/applications/${r.id}`}>
                                {r.shopName}
                              </Link>
                              <span className="c-alt"> · {r.slug}</span>
                            </td>
                            <td className="col-text">
                              {text(r.businessInfo?.companyName) === "-" && text(r.businessInfo?.businessNumber) === "-" ? (
                                "-"
                              ) : (
                                <>
                                  {text(r.businessInfo?.companyName)}
                                  <span className="c-alt"> · {text(r.businessInfo?.businessNumber)}</span>
                                </>
                              )}
                            </td>
                            <td>
                              {day(r.createdAt)}
                              <span className={`t-c1 ${w.hot ? "c-neg fw6" : "c-alt"}`} style={{ display: "block" }}>
                                {w.label}
                              </span>
                            </td>
                            <td className="col-text">
                              {r.done ? (
                                <span className={`bdg ${r.done === "approved" ? "b-done" : "b-gray"}`}>{r.done === "approved" ? "승인됨" : "반려됨"}</span>
                              ) : review ? (
                                <>
                                  <span className="bdg b-warn">확인 필요 {r.reviewReasons.length}</span>
                                  <span className="t-c1 c-alt" style={{ display: "block" }}>
                                    {r.reviewReasons.slice(0, 2).map(reasonLabel).join(" · ")}
                                    {r.reviewReasons.length > 2 && ` 외 ${r.reviewReasons.length - 2}건`}
                                  </span>
                                </>
                              ) : (
                                <span className="bdg b-done">이상 없음</span>
                              )}
                            </td>
                            <td>
                              <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                                {r.done ? (
                                  r.done === "approved" && (
                                    <Link className="btn btn-sm btn-out" href={`/admin/partners/${r.id}`}>
                                      파트너스
                                    </Link>
                                  )
                                ) : (
                                  <>
                                    {canModerate && !review && (
                                      <>
                                        <button className="btn btn-sm" type="button" onClick={() => void approve(r)} disabled={working}>
                                          {working ? "처리 중" : "승인"}
                                        </button>
                                        <button className="btn btn-sm btn-out" type="button" onClick={() => setRejecting(r)} disabled={working}>
                                          반려
                                        </button>
                                      </>
                                    )}
                                    {canModerate && review && (
                                      <button className="btn btn-sm" type="button" onClick={() => setReviewing(r)} disabled={working}>
                                        검토
                                      </button>
                                    )}
                                    <Link className="btn btn-sm btn-out" href={`/admin/partners/applications/${r.id}`}>
                                      상세
                                    </Link>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
          </div>
        </div>
      </main>

      {rejecting && (
        <RejectApplicationDialog
          id={rejecting.id}
          shopName={rejecting.shopName}
          onClose={() => setRejecting(null)}
          onDone={() => {
            const r = rejecting;
            setRejecting(null);
            setReviewing(null);
            mark(r.id, "rejected");
            setToast({ text: `${r.shopName} 가입을 반려했습니다.` });
          }}
          onStale={() => {
            const r = rejecting;
            setRejecting(null);
            setReviewing(null);
            stale(r);
          }}
        />
      )}
      {reviewing && !rejecting && (
        <Modal labelId="review-title" busy={busy.has(reviewing.id)} onClose={() => setReviewing(null)}>
          {(requestClose) => (
            <>
              <div className="modal-h">
                <h2 className="modal-t" id="review-title">
                  {reviewing.shopName} 확인 필요
                </h2>
                <span className="t-l2 c-alt">아래 사유를 확인한 뒤 승인해 주십시오. 자세한 서류는 상세에서 볼 수 있습니다.</span>
              </div>
              <div className="col" style={{ gap: 8, padding: "0 24px" }}>
                <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="review-reasons">
                  {reviewing.reviewReasons.map((c) => (
                    <li key={c}>{reasonLabel(c)}</li>
                  ))}
                </ul>
                <span className="t-l2 c-alt">
                  {text(reviewing.businessInfo?.companyName)} · {text(reviewing.businessInfo?.businessNumber)} · {day(reviewing.createdAt)} 접수
                </span>
              </div>
              <div className="modal-f">
                <Link className="btn btn-out" href={`/admin/partners/applications/${reviewing.id}`}>
                  상세 열기
                </Link>
                <button className="btn btn-out" type="button" onClick={() => setRejecting(reviewing)} disabled={busy.has(reviewing.id)}>
                  반려
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy.has(reviewing.id)}
                  onClick={() => {
                    const r = reviewing;
                    setReviewing(null);
                    void approve(r);
                  }}
                >
                  확인 뒤 승인
                </button>
                <button className="btn btn-out" type="button" onClick={requestClose}>
                  닫기
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

export default function PartnerApplications() {
  return (
    <Suspense fallback={null}>
      <Applications />
    </Suspense>
  );
}
