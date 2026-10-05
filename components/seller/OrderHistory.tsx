"use client";

import "./OrderHistory.css";
import { won } from "./format";
import { fullTime } from "./orders";
import type { OrderHistoryEvent } from "../../lib/server/orders/history";

// SA-022 주문 상세 「상태 이력」(디자인 SA-022: 시각·상태·처리·비고). 서버 history(시각 오름차순)를 최신이 위로 오게 보인다.
// 코드값(PENDING_PAYMENT 등)은 쓰지 않고 업무 문구로 바꾼다. 처리는 역할·이름 수준만 서버가 준다.
const STATUS_TEXT: Record<string, string> = { PENDING_PAYMENT: "결제 대기", PAID: "결제 완료", CANCELLED: "주문 취소", REFUNDED: "환불 완료" };
const CANCEL_TEXT: Record<string, string> = { REQUESTED: "카드 승인 취소 요청", DONE: "카드 승인 취소 완료", FAILED: "카드 승인 취소 실패" };

function actorText(a: OrderHistoryEvent["actor"]): string {
  if (a.type === "BUYER") return "구매자";
  if (a.type === "ADMIN") return "마스터 관리자";
  if (a.type === "SYSTEM") return "자동";
  return a.name ?? (a.role === "OWNER" ? "대표자" : "직원");
}

// 상태 열 문구와 비고 열 문구(금액·수량·사유)
export function historyRow(e: OrderHistoryEvent): { state: string; note: string } {
  const note = e.note ?? "";
  if (e.kind === "status") return { state: e.fromStatus === null && e.status ? "주문 생성" : (e.status && STATUS_TEXT[e.status]) || "상태 변경", note };
  if (e.kind === "payment_approved") return { state: "결제 승인", note: [e.amount !== null ? won(e.amount) : null, note].filter(Boolean).join(" · ") };
  if (e.kind === "refund_partial") {
    const parts = [e.amount !== null ? `환불 ${won(e.amount)}` : null, e.quantity !== null ? `${e.quantity.toLocaleString("ko-KR")}개` : null, note];
    return { state: "부분 환불", note: parts.filter(Boolean).join(" · ") };
  }
  const cancel = e.cancelStatus ? CANCEL_TEXT[e.cancelStatus] : "카드 승인 취소";
  return { state: cancel, note: [e.amount !== null ? won(e.amount) : null, e.cancelStatus === "FAILED" ? "다시 보냅니다" : null, note].filter(Boolean).join(" · ") };
}

export default function OrderHistory({ history }: { history: OrderHistoryEvent[] }) {
  const rows = [...history].reverse();
  return (
    <section className="card pad col oh-sec" aria-label="상태 이력" data-testid="order-history">
      <h2 className="t-hl2">상태 이력</h2>
      {rows.length === 0 ? (
        <span className="t-l2 c-alt">기록된 이력이 없습니다.</span>
      ) : (
        <div className="au-lt-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="oh-w-time">시각</th>
                <th>상태</th>
                <th className="oh-w-actor">처리</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => {
                const r = historyRow(e);
                return (
                  <tr key={`${e.at}-${e.kind}-${i}`} data-testid="history-row">
                    <td className="num">{fullTime(e.at).slice(5)}</td>
                    <td>{r.state}</td>
                    <td>{actorText(e.actor)}</td>
                    <td className="col-text">{r.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
