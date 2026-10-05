"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListHead, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";

// SA-033 회원별 적립금 잔액(조회만, 회원·적립금 권한). API: GET /api/seller/reward-balances?q&cursor&limit.
// 지급·회수·조정 버튼은 없다. 탈퇴 회원과 잔액 기록이 없는 회원은 목록에 나오지 않는다. 50명씩 「더 보기」, 전체 건수 API가 없어 「불러온 n건」으로 보인다.

type Row = {
  member: { id: string; broadcastNickname: string | null };
  balance: number;
  totalEarned: number;
  totalUsed: number;
  totalRevoked: number;
  totalExpired: number;
  totalAdjusted: number;
  updatedAt: string;
};
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Row[]; next: string | null };

const PAGE = 50;
const stamp = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
// 조정은 음수일 수 있다. 부호를 그대로 보인다.
const signed = (n: number) => (n > 0 ? `+${won(n)}` : n < 0 ? `−${won(Math.abs(n))}` : won(0));

function query(q: string, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export default function RewardBalancesPage() {
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);

  const load = useCallback(async (q: string) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await api<{ balances: Row[]; nextCursor: string | null }>(`/api/seller/reward-balances?${query(q)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", rows: r.data.balances, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load(applied), [applied, load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await api<{ balances: Row[]; nextCursor: string | null }>(`/api/seller/reward-balances?${query(applied, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", rows: [...state.rows, ...r.data.balances], next: r.data.nextCursor });
    else setToast("회원별 잔액을 더 불러오지 못했습니다. 다시 눌러 주십시오");
  };

  const rows = state.kind === "ok" ? state.rows : [];
  const search = () => setApplied(filter.trim());

  return (
    <>
      <Topbar crumb="회원 › 회원별 잔액" />
      <main className="main">
        <PageHead title="회원별 적립금 잔액" />

        <SearchBox
          onSearch={search}
          onReset={() => {
            setFilter("");
            setApplied("");
          }}
        >
          <SearchRow label="방송 닉네임">
            <input
              className="inp"
              type="text"
              aria-label="방송 닉네임"
              maxLength={50}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") search();
              }}
            />
          </SearchRow>
        </SearchBox>

        <div style={{ marginTop: 16 }}>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="회원·적립금" /> : state.status === 402 ? <Locked /> : <ErrorState title="회원별 잔액을 불러오지 못했습니다" onRetry={() => void load(applied)} />)}
          {state.kind === "ok" &&
            (rows.length === 0 ? (
              <div className="st">
                <span className="t">{applied ? "조건에 맞는 회원이 없습니다" : "아직 적립금 잔액이 있는 회원이 없습니다"}</span>
              </div>
            ) : (
              <>
                <ListHead total={rows.length} loaded />
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" data-testid="balance-table">
                    <thead>
                      <tr>
                        <th>회원</th>
                        <th>현재 잔액</th>
                        <th>누적 적립</th>
                        <th>누적 사용</th>
                        <th>누적 회수</th>
                        <th>누적 소멸</th>
                        <th>누적 조정</th>
                        <th>최근 변동</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.member.id} data-testid="balance-row">
                          <td>
                            <Link href={`/seller/members/${r.member.id}`}>{r.member.broadcastNickname ?? "닉네임 없음"}</Link>
                          </td>
                          <td>
                            <b>{won(r.balance)}</b>
                          </td>
                          <td>{won(r.totalEarned)}</td>
                          <td>{won(r.totalUsed)}</td>
                          <td>{won(r.totalRevoked)}</td>
                          <td>{won(r.totalExpired)}</td>
                          <td>{signed(r.totalAdjusted)}</td>
                          <td>{stamp(r.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {state.next && (
                  <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
                    <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                      {more ? "불러오는 중" : "더 보기"}
                    </button>
                  </div>
                )}
              </>
            ))}
        </div>
        <p className="help" style={{ marginTop: 16 }}>
          누적 값은 처리에 성공한 내역만 더한 것입니다. 이 화면에서는 조회만 할 수 있고, 지급·회수는 주문 처리에 따라 자동으로 기록됩니다. 탈퇴한 회원은 나오지 않습니다.
        </p>
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
