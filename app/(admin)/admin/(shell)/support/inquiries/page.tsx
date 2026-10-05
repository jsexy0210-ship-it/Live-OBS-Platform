"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ListHead, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { INQUIRY_CATEGORY, INQUIRY_STATUS, INQUIRY_TABS, type InquiryCounts, type InquiryRow, type InquiryStatus } from "../../../_components/inquiries";
import { dayTime } from "../../../_components/partners";

// MA-051 파트너스 문의 목록(GET /api/admin/platform-inquiries, 모든 마스터 역할 조회). 상태 탭의 숫자는 서버의 상태별 전체 수.
// 답변·종료는 상세(MA-052)에서 한다(최고관리자·CS). 마지막 글 최신 순 50건씩 이어서 불러오고, 파트너스 지정(?sellerId=)을 받는다.
type Page = { items: InquiryRow[]; counts: InquiryCounts; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: InquiryRow[]; counts: InquiryCounts; next: string | null };

function Inquiries() {
  // 상태 탭·파트너스 지정은 주소 쿼리가 기준이다(상세 → Back에서 그대로 돌아온다). 없는 상태 값은 기본 탭으로 본다.
  const [f, setF] = useUrlState({ status: "OPEN", sellerId: "" });
  const sellerId = f.sellerId;
  const tab = (INQUIRY_TABS as string[]).includes(f.status) ? (f.status as InquiryStatus | "") : "OPEN";
  const setTab = (t: InquiryStatus | "") => setF({ status: t });
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reqId = useRef(0);
  const qs = useCallback(
    (status: string, cursor?: string) => {
      const p = new URLSearchParams();
      if (status) p.set("status", status);
      if (sellerId) p.set("sellerId", sellerId);
      if (cursor) p.set("cursor", cursor);
      return p.toString();
    },
    [sellerId],
  );
  const load = useCallback(
    async (status: string) => {
      const id = ++reqId.current;
      setMore(false);
      setState({ kind: "loading" });
      const r = await adminApi<Page>(`/api/admin/platform-inquiries?${qs(status)}`);
      if (id !== reqId.current) return;
      setState(r.ok ? { kind: "ok", items: r.data.items, counts: r.data.counts, next: r.data.nextCursor } : { kind: "error" });
    },
    [qs],
  );
  useEffect(() => void load(tab), [tab, load]);
  useScrollRestore("admin-inquiries", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/platform-inquiries?${qs(tab, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ ...state, items: [...state.items, ...r.data.items], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const counts = state.kind === "ok" ? state.counts : null;
  const total = counts ? counts.OPEN + counts.ANSWERED + counts.CLOSED : null;
  const items = state.kind === "ok" ? state.items : [];

  return (
    <>
      <AdminTopbar crumb="고객지원 › 파트너스 문의" />
      <main className="main">
        <PageHead title="파트너스 문의" />
        <div className="col" style={{ gap: 20 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="상태">
            {INQUIRY_TABS.map((t) => (
              <button key={t || "all"} type="button" className={`btn btn-sm ${tab === t ? "" : "btn-out"}`} aria-pressed={tab === t} onClick={() => setTab(t)}>
                {t === "" ? "전체" : INQUIRY_STATUS[t].label}
                {counts && ` ${t === "" ? total : counts[t]}`}
              </button>
            ))}
          </div>
          {sellerId && (
            <div className="row" style={{ gap: 8 }}>
              <span className="t-l2 c-alt">한 파트너스의 문의만 보고 있습니다.</span>
              <Link className="btn btn-sm btn-out" href="/admin/support/inquiries">
                전체 보기
              </Link>
            </div>
          )}
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="파트너스 문의를 불러오지 못했습니다." onRetry={() => void load(tab)} />}
            {state.kind === "ok" &&
              (items.length === 0 ? (
                <div className="st">
                  <span className="t">{tab === "OPEN" ? "답변을 기다리는 문의가 없습니다." : "문의가 없습니다."}</span>
                </div>
              ) : (
                <>
                  <ListHead total={items.length} loaded={state.next !== null} />
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>마지막 글</th>
                          <th>파트너스</th>
                          <th>작성자</th>
                          <th>유형</th>
                          <th>제목</th>
                          <th>상태</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((r) => (
                          <tr key={r.id} data-testid="inquiry-row">
                            <td>{dayTime(r.lastMessageAt)}</td>
                            <td>
                              <b>{r.shopName}</b>
                            </td>
                            <td>{r.authorName ?? "-"}</td>
                            <td>{INQUIRY_CATEGORY[r.category]}</td>
                            <td className="col-text">{r.title}</td>
                            <td>
                              <span className={`bdg ${INQUIRY_STATUS[r.status].cls}`}>{INQUIRY_STATUS[r.status].label}</span>
                            </td>
                            <td>
                              <Link className="btn btn-sm btn-out" href={`/admin/support/inquiries/${r.id}`}>
                                {r.status === "CLOSED" ? "보기" : "답변"}
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {state.next && (
                    <div className="row" style={{ justifyContent: "center", padding: "12px 16px" }}>
                      <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                        {more ? "불러오는 중" : "더 보기"}
                      </button>
                    </div>
                  )}
                </>
              ))}
          </div>
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}

export default function InquiriesPage() {
  return (
    <Suspense fallback={null}>
      <Inquiries />
    </Suspense>
  );
}
