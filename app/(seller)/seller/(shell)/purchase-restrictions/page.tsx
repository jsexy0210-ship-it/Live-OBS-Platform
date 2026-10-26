"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useUrlState } from "../../../../../lib/client/navigation";
import { Pagination } from "../../../../../components/admin-ui";
import { useCallback, useEffect, useState } from "react";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { useLatestResponse } from "../../../../../components/seller/latestResponse";

// SA-043 현재 구매 제한 목록. 해제는 기존 회원 상세의 업무 영역에서만 실행한다.
// GET /api/seller/purchase-restrictions, 회원·적립금 권한. 자동 제한 규칙은 주문 설정에서 정한다.

type Restriction = { id: string; buyerMemberId: string; reason: string; startsAt: string; endsAt: string; buyerMember: { broadcastNickname: string | null } };

const REASON: Record<string, string> = {
  UNPAID_AUTO_CANCEL: "미입금 자동 취소 반복",
  PAID_CANCEL: "결제 후 취소 반복",
};

const DAY = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
// 서버(lib/server/orders/overdue.ts)가 목록을 최근 200건에서 자른다
const LIST_LIMIT = 200;

// 한 구매자에게 사유가 다른 제한이 겹칠 수 있다(풀기는 구매자 단위로 모두 푼다): 구매자별로 묶어 가장 늦게 끝나는 날을 보인다
function byBuyer(rows: Restriction[]) {
  const map = new Map<string, { buyerMemberId: string; nickname: string | null; reasons: string[]; startsAt: string; endsAt: string }>();
  for (const r of rows) {
    const g = map.get(r.buyerMemberId);
    if (!g) {
      map.set(r.buyerMemberId, { buyerMemberId: r.buyerMemberId, nickname: r.buyerMember.broadcastNickname, reasons: [r.reason], startsAt: r.startsAt, endsAt: r.endsAt });
      continue;
    }
    if (!g.reasons.includes(r.reason)) g.reasons.push(r.reason);
    if (r.startsAt < g.startsAt) g.startsAt = r.startsAt;
    if (r.endsAt > g.endsAt) g.endsAt = r.endsAt;
  }
  return [...map.values()];
}

export default function PurchaseRestrictionsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; rows: Restriction[] }>({ kind: "loading" });
  const [u, setU] = useUrlState({ page: "1" });
  const page = /^\d+$/.test(u.page) && Number(u.page) >= 1 ? Number(u.page) : 1;
  const setPage = (value: number) => setU({ page: String(value) });
  const params = useSearchParams().toString();
  const returnTo = `/seller/purchase-restrictions${params ? `?${params}` : ""}`;
  const reads = useLatestResponse();

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setState({ kind: "loading" });
      const t = reads.next();
      const r = await api<{ restrictions: Restriction[] }>("/api/seller/purchase-restrictions");
      if (!r.ok) {
        if (!reads.failMatters(t)) return false;
        if (!reads.hasApplied()) setState({ kind: "error", status: r.status, error: r.error });
        return false;
      }
      if (reads.accept(t) === "apply") {
        setState({ kind: "ok", rows: r.data.restrictions });
      }
      return true;
    },
    [reads],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const groups = state.kind === "ok" ? byBuyer(state.rows) : [];
  const pageCount = Math.ceil(groups.length / 10);
  const currentPage = Math.min(page, pageCount || 1);
  const pageGroups = groups.slice((currentPage - 1) * 10, currentPage * 10);
  useEffect(() => { if (state.kind === "ok" && page !== currentPage) setPage(currentPage); }, [state.kind, page, currentPage]);

  return (
    <>
      <Topbar crumb="판매 › 구매 제한" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">구매 제한</h1>
            <span className="t-l2 c-alt">
              지금 주문이 막힌 구매자입니다. 자동 제한 규칙은{" "}
              <Link href="/seller/settings/order" className="t-l2 fw6">
                주문 설정
              </Link>
              에서 정합니다.
            </span>
          </div>
        </div>

        {state.kind === "ok" && state.rows.length >= LIST_LIMIT && (
          <div className="msg msg-cau" role="status" style={{ marginBottom: 16 }}>
            <span>최근 {LIST_LIMIT}건까지만 표시합니다. 일부 구매자의 사유·기간이 빠져 보일 수 있습니다.</span>
          </div>
        )}

        <section className="card col" aria-label="구매 제한 목록">
          {state.kind === "loading" && <LoadingRows rows={4} />}
          {state.kind === "error" &&
            (state.status === 403 && state.error === "plan_feature_required" ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <span className="t">지금 요금제에서 사용할 수 없는 기능입니다</span>
                <span className="s">쇼핑몰 통합 요금제에서 사용할 수 있습니다</span>
              </div>
            ) : state.status === 403 ? (
              <NoPermission need="회원·적립금" />
            ) : (
              <ErrorState title="구매 제한 목록을 불러오지 못했습니다" onRetry={() => void load()} />
            ))}
          {state.kind === "ok" &&
            (groups.length === 0 ? (
              <div className="st">
                <span className="t">주문이 막힌 구매자가 없습니다</span>
                <span className="s">자동 제한 규칙에 걸리면 이곳에 표시됩니다</span>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>구매자 · 사유 · 제한 기간</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {pageGroups.map((g) => (
                      <tr key={g.buyerMemberId} data-testid="restriction-row">
                        <td className="col-text">
                          <div className="col" style={{ gap: 2 }}>
                            <span className="fw6">{g.nickname ?? <span className="c-alt">닉네임 없음</span>}</span>
                            <span className="t-c1">{g.reasons.map((r) => REASON[r] ?? "기타").join(" · ")}</span>
                            <span className="t-c1 c-alt num">
                              {DAY(g.startsAt)} ~ {DAY(g.endsAt)}
                            </span>
                          </div>
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <Link className="btn btn-sm btn-out" href={`/seller/members/${g.buyerMemberId}?${new URLSearchParams({ returnTo })}#member-restriction`}>회원 상세</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </section>
        {pageCount > 1 && <Pagination page={currentPage} pageCount={pageCount} onChange={setPage} label="구매 제한 페이지 이동" />}
      </main>
    </>
  );
}
