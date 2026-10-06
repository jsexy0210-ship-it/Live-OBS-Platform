"use client";

import "../../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHead, useConfirm, ListTable, ListHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { kstText } from "../../banners/_shared/ui";
import "./receipts.css";

// SA-024 영수증 · 세금계산서(파트너스 관리자, 주문 › 영수증 · 세금계산서). 무통장 · 계좌이체 주문에서 구매자가 신청한 현금영수증 · 세금계산서의 발행 상태를 보고, 실패 · 보류한 건을 다시 발행(대기로)한다.
// API: GET /api/seller/receipt-requests(?status=PENDING|ON_HOLD|ISSUED|FAILED|CANCELLED · cursor, 상태별 건수 counts), POST /api/seller/receipt-requests/[id]/retry. 조회 · 처리는 대표자 · 「영수증 · 세금계산서」(RECEIPT_TAX) 권한 직원.
type Status = "PENDING" | "ON_HOLD" | "ISSUED" | "FAILED" | "CANCELLED";
type Kind = "CASH_RECEIPT_INCOME" | "CASH_RECEIPT_EXPENSE" | "TAX_INVOICE";
type Row = {
  id: string;
  orderId: string;
  orderNoLabel: string;
  nickname: string | null;
  kind: Kind;
  identityLast4: string;
  taxInfo: { companyName: string; representative: string; email: string } | null;
  withdrawnAt: string | null;
  createdAt: string;
  issue: { status: Status; amount: number; failureCode: string | null; issuedAt: string | null; cancelledAt: string | null } | null;
};
type List = { requests: Row[]; nextCursor: string | null; counts: Partial<Record<Status, number>> };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Row[]; next: string | null; counts: List["counts"] };

const CHIPS: { key: Status | "ALL"; label: string }[] = [
  { key: "ALL", label: "전체" },
  { key: "PENDING", label: "발행 대기" },
  { key: "ON_HOLD", label: "보류" },
  { key: "ISSUED", label: "발행 완료" },
  { key: "FAILED", label: "실패" },
  { key: "CANCELLED", label: "취소" },
];
const BADGE: Record<Status, { label: string; cls: string }> = {
  PENDING: { label: "발행 대기", cls: "b-wait" },
  ON_HOLD: { label: "보류", cls: "b-warn" },
  ISSUED: { label: "발행 완료", cls: "b-done" },
  FAILED: { label: "실패", cls: "b-fail" },
  CANCELLED: { label: "발행 취소", cls: "b-gray nodot" },
};
const KIND: Record<Kind, string> = { CASH_RECEIPT_INCOME: "현금영수증 · 소득공제", CASH_RECEIPT_EXPENSE: "현금영수증 · 지출증빙", TAX_INVOICE: "세금계산서" };
const FAILURE: Record<string, string> = {
  provider_error: "발행 업체 응답 오류",
  provider_cancel_needed: "발행 업체에서 직접 취소가 필요합니다",
};

// 비고: 실패 사유 · 보류 이유 · 철회
function note(r: Row): string {
  const i = r.issue;
  if (!i) return "";
  if (i.status === "FAILED") return i.failureCode ? (FAILURE[i.failureCode] ?? "발행하지 못했습니다") : "발행하지 못했습니다";
  if (i.status === "ON_HOLD") return "충전금 잔액이 부족해 발행을 미뤘습니다";
  if (i.status === "CANCELLED") return i.failureCode === "provider_cancel_needed" ? FAILURE.provider_cancel_needed : r.withdrawnAt ? "구매자가 신청을 철회했습니다" : "";
  return "";
}

export default function ReceiptsPage() {
  const { can } = useSeller();
  const { confirm } = useConfirm();
  const canEdit = can("RECEIPT_TAX");
  const [u, setU] = useUrlState({ status: "ALL" });
  const tab: Status | "ALL" = CHIPS.some((c) => c.key === u.status) ? (u.status as Status | "ALL") : "ALL";
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const query = tab === "ALL" ? "" : `status=${tab}`;

  const load = useCallback(async (q: string) => {
    const r = await api<List>(`/api/seller/receipt-requests${q ? `?${q}` : ""}`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", rows: r.data.requests, next: r.data.nextCursor, counts: r.data.counts });
  }, []);
  useEffect(() => {
    setState({ kind: "loading" });
    void load(query);
  }, [query, load]);
  useScrollRestore("seller-receipts", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const r = await api<List>(`/api/seller/receipt-requests?${query ? `${query}&` : ""}cursor=${state.next}`);
    setMore(false);
    if (!r.ok) return setToast({ text: "더 불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
    const seen = new Set(state.rows.map((x) => x.id));
    setState({ ...state, rows: [...state.rows, ...r.data.requests.filter((x) => !seen.has(x.id))], next: r.data.nextCursor, counts: r.data.counts });
  };

  const retry = async (r: Row) => {
    await confirm({
      title: "다시 발행하시겠습니까?",
      body: `${r.nickname ?? "탈퇴 회원"}님의 ${KIND[r.kind]} 신청을 발행 대기로 돌립니다. 발행 업체 연동이 되면 이어서 발행됩니다.`,
      confirmLabel: "다시 발행",
      run: async () => {
        const res = await api(`/api/seller/receipt-requests/${r.id}/retry`, { method: "POST" });
        if (!res.ok) return res.message ?? "다시 발행하지 못했습니다. 잠시 뒤 다시 시도해 주십시오";
        setToast({ text: "발행 대기로 돌렸습니다" });
        await load(query);
      },
    });
  };

  const counts = state.kind === "ok" ? state.counts : {};
  const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
  const rows = state.kind === "ok" ? state.rows : [];

  return (
    <>
      <Topbar crumb="주문 › 영수증 · 세금계산서" />
      <main className="main">
        <PageHead description="영수증과 세금계산서 신청을 확인하고 처리합니다."
          title="영수증 · 세금계산서"
          actions={
            <Link className="btn btn-out" href="/seller/orders/deposits">
              입금 확인
            </Link>
          }
        />
        <span className="t-c1 c-alt">무통장 · 계좌이체 주문에서 구매자가 신청한 현금영수증 · 세금계산서입니다. 카드 결제는 카드 매출전표로 확인합니다.</span>
        <div className="au-list-section" >
          {state.kind === "ok" && (
            <div className="rc-sum" data-testid="receipt-summary">
              {(
                [
                  ["발행 대기", (counts.PENDING ?? 0) + (counts.ON_HOLD ?? 0)],
                  ["발행 완료", counts.ISSUED ?? 0],
                  ["실패", counts.FAILED ?? 0],
                  ["취소", counts.CANCELLED ?? 0],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <div className="k">{k}</div>
                  <div className="v num">{v}건</div>
                </div>
              ))}
            </div>
          )}
          <div className="row" role="tablist" aria-label="발행 상태" style={{ gap: 8, flexWrap: "wrap", padding: "12px 20px" }}>
            {CHIPS.map((c) => (
              <button key={c.key} className={`chip${tab === c.key ? " on" : ""}`} type="button" role="tab" aria-selected={tab === c.key} onClick={() => setU({ status: c.key })}>
                {c.label}
                {state.kind === "ok" && <span className="num">{c.key === "ALL" ? total : (counts[c.key] ?? 0)}</span>}
              </button>
            ))}
          </div>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="영수증 · 세금계산서" /> : state.status === 402 ? <Locked /> : <ErrorState title="목록을 불러오지 못했습니다" onRetry={() => void load(query)} />)}
          {state.kind === "ok" && rows.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">신청 내역이 없습니다</span>
              <span className="s">무통장 주문서에서 현금영수증 · 세금계산서를 신청하면 여기에 들어옵니다</span>
            </div>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <>
<ListHead total={rows.length} loaded />
<ListTable>
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="col-text" style={{ textAlign: "left" }}>
                      닉네임
                    </th>
                    <th style={{ width: 150 }}>접수 시각</th>
                    <th>종류</th>
                    <th style={{ width: 110, textAlign: "right" }}>금액</th>
                    <th style={{ width: 90 }}>상태</th>
                    <th className="col-text" style={{ textAlign: "left" }}>
                      비고
                    </th>
                    {canEdit && <th style={{ width: 120 }}>관리</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} data-testid="receipt-row">
                      <td className="col-text">
                        <Link href={`/seller/orders/${r.orderId}`} className="fw6">
                          {r.nickname ?? "탈퇴 회원"}
                        </Link>
                        <div className="t-c1 c-alt num">{r.orderNoLabel}</div>
                      </td>
                      <td className="num">{kstText(r.createdAt)}</td>
                      <td>
                        {KIND[r.kind]}
                        <div className="t-c1 c-alt num">
                          {r.taxInfo ? `${r.taxInfo.companyName} · ` : ""}번호 끝 {r.identityLast4}
                        </div>
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {r.issue ? won(r.issue.amount) : "—"}
                      </td>
                      <td>{r.issue ? <span className={`bdg ${BADGE[r.issue.status].cls}`}>{BADGE[r.issue.status].label}</span> : "—"}</td>
                      <td className="col-text">{note(r)}</td>
                      {canEdit && (
                        <td>
                          <div className="acts2">
                            {r.issue && (r.issue.status === "FAILED" || r.issue.status === "ON_HOLD") ? (
                              <button className="btn btn-sm" type="button" onClick={() => void retry(r)}>
                                다시 발행
                              </button>
                            ) : (
                              "—"
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ListTable>
</>
          )}
          {state.kind === "ok" && state.next && (
            <div className="row" style={{ padding: "12px 20px", justifyContent: "center" }}>
              <button className={`btn btn-sm btn-out${more ? " is-loading" : ""}`} type="button" disabled={more} onClick={() => void loadMore()}>
                더 보기
              </button>
            </div>
          )}
        </div>
        <span className="t-c1 c-alt">환불되면 자동으로 「발행 취소」가 됩니다 · 이미 발행한 세금계산서는 수정 세금계산서로 처리합니다 · 사업자 정보는 구매자가 주문서에 적은 그대로입니다. 틀렸으면 구매자에게 수정을 요청해 주십시오.</span>
        {state.kind === "ok" && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>보기만 할 수 있습니다. 바꾸려면 대표자에게 「영수증 · 세금계산서」 허용을 요청해 주십시오.</span>
          </div>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
