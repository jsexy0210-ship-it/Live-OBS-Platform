"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { won } from "../format";

// SA-042 회원 상세의 적립금 내역(이 회원의 지급·회수 원장만, 최신순). API: GET /api/seller/reward-ledger?memberId=&limit=&cursor=(회원·적립금 권한).
type Status = "PENDING" | "SUCCEEDED" | "FAILED";
type Entry = {
  id: string;
  type: "EARN" | "REVOKE" | "USE" | "RANKING_BONUS" | "ADJUST" | "EXPIRE";
  amount: number;
  status: Status;
  order: { id: string; orderNo: number } | null;
  createdAt: string;
};
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; rows: Entry[]; next: string | null };

const PAGE = 10;
const TYPE: Record<Entry["type"], string> = { EARN: "적립", REVOKE: "회수", USE: "사용", RANKING_BONUS: "랭킹 보너스", ADJUST: "조정", EXPIRE: "소멸" };
const STATUS: Record<Status, { label: string; cls: string }> = {
  PENDING: { label: "대기", cls: "b-warn" },
  SUCCEEDED: { label: "성공", cls: "b-done" },
  FAILED: { label: "실패", cls: "b-fail" },
};
const stamp = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
// 회수·사용·소멸은 음수로 온다. 부호를 그대로 보인다.
const signed = (n: number) => (n > 0 ? `+${won(n)}` : n < 0 ? `−${won(Math.abs(n))}` : won(0));

export function MemberRewards({ memberId }: { memberId: string }) {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ entries: Entry[]; nextCursor: string | null }>(`/api/seller/reward-ledger?memberId=${memberId}&limit=${PAGE}`);
    setState(r.ok ? { kind: "ok", rows: r.data.entries, next: r.data.nextCursor } : { kind: "error" });
  }, [memberId]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    setMoreFailed(false);
    const r = await api<{ entries: Entry[]; nextCursor: string | null }>(`/api/seller/reward-ledger?memberId=${memberId}&limit=${PAGE}&cursor=${encodeURIComponent(state.next)}`);
    setMore(false);
    if (!r.ok) return setMoreFailed(true);
    setState({ kind: "ok", rows: [...state.rows, ...r.data.entries], next: r.data.nextCursor });
  };

  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="member-rewards-title">
      <h2 className="t-hl1" id="member-rewards-title">
        적립금 내역
      </h2>
      {state.kind === "loading" && <span className="t-l2 c-alt">불러오는 중입니다</span>}
      {state.kind === "error" && (
        <div className="row" style={{ gap: 8 }}>
          <span className="t-l2 c-alt">적립금 내역을 불러오지 못했습니다.</span>
          <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
            다시 시도
          </button>
        </div>
      )}
      {state.kind === "ok" && state.rows.length === 0 && <span className="t-l2" data-testid="member-rewards-empty">적립금 내역이 없습니다</span>}
      {state.kind === "ok" && state.rows.length > 0 && (
        <div className="au-lt-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>일시</th>
                <th>종류</th>
                <th>금액</th>
                <th>상태</th>
                <th>주문</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((e) => (
                <tr key={e.id} data-testid="member-reward-row">
                  <td className="num">{stamp(e.createdAt)}</td>
                  <td>{TYPE[e.type]}</td>
                  <td className="num">{signed(e.amount)}</td>
                  <td>
                    <span className={`bdg ${STATUS[e.status].cls}`}>{STATUS[e.status].label}</span>
                  </td>
                  <td className="num">{e.order ? e.order.orderNo : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state.kind === "ok" && state.next && (
        <div className="row" style={{ justifyContent: "center", gap: 8 }}>
          <button className={`btn btn-sm btn-out${more ? " is-loading" : ""}`} type="button" disabled={more} onClick={() => void loadMore()}>
            더 불러오기
          </button>
          {moreFailed && <span className="err">더 불러오지 못했습니다. 다시 눌러 주십시오</span>}
        </div>
      )}
    </section>
  );
}
