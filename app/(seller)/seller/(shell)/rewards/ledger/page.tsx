"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateRangePicker, ListHead, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { listDefaults } from "../../../../../../lib/client/filterDefaults";
import { formatDateTime } from "../../../../../../lib/client/format";

// SA-032 적립금 지급·회수 내역(조회만, 회원·적립금 권한). API: GET /api/seller/reward-ledger?from&to&status&cursor&limit.
// 지급·회수 버튼은 없다. 기간(기본 최근 1개월)·처리 상태 조건은 주소가 기준이고, 20건씩 「더 보기」, 전체 건수 API가 없어 「불러온 n건」으로 보인다.

type Status = "PENDING" | "SUCCEEDED" | "FAILED";
type Entry = {
  id: string;
  member: { id: string; broadcastNickname: string | null };
  type: "EARN" | "REVOKE" | "USE" | "RANKING_BONUS" | "ADJUST" | "EXPIRE";
  amount: number;
  status: Status;
  failureReason: string | null;
  order: { id: string; orderNo: number } | null;
  testMode: boolean;
  createdAt: string;
  processedAt: string | null;
};
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; entries: Entry[]; next: string | null };

const PAGE = 20;
const TYPE: Record<Entry["type"], string> = { EARN: "적립", REVOKE: "회수", USE: "사용", RANKING_BONUS: "인기 카드 보너스", ADJUST: "조정", EXPIRE: "소멸" };
const STATUS: Record<Status, { label: string; cls: string }> = {
  PENDING: { label: "대기", cls: "b-warn" },
  SUCCEEDED: { label: "성공", cls: "b-done" },
  FAILED: { label: "실패", cls: "b-fail" },
};
// 회수·사용·소멸은 음수로 온다. 부호를 그대로 보인다.
const signed = (n: number) => (n > 0 ? `+${won(n)}` : n < 0 ? `−${won(Math.abs(n))}` : won(0));

type Cond = { from: string; to: string; status: Status | "" };

function query(c: Cond, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE), from: c.from, to: c.to });
  if (c.status) p.set("status", c.status);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export default function RewardLedgerPage() {
  // 기간·처리 상태 조건은 주소(?from=&to=&status=)가 기준이다(상세·다른 화면 → ← 에서 그대로 돌아온다, docs/IA.md Back 규칙 3항). 기본은 최근 1개월
  const defaults = listDefaults({ status: "" });
  const [urlState, setUrlState] = useUrlState({ from: defaults.from, to: defaults.to, status: "" });
  const appliedStatus: Status | "" = urlState.status in STATUS ? (urlState.status as Status) : "";
  const applied = useMemo<Cond>(() => ({ from: urlState.from, to: urlState.to, status: appliedStatus }), [urlState.from, urlState.to, appliedStatus]);
  const [filter, setFilter] = useState<Cond>(applied);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);

  const load = useCallback(async (cond: Cond) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await api<{ entries: Entry[]; nextCursor: string | null }>(`/api/seller/reward-ledger?${query(cond)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", entries: r.data.entries, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load(applied), [applied, load]);
  // 주소가 바뀌면(뒤로 가기 등) 입력 칸도 같은 값으로
  useEffect(() => setFilter(applied), [applied]);
  useScrollRestore("seller-reward-ledger", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await api<{ entries: Entry[]; nextCursor: string | null }>(`/api/seller/reward-ledger?${query(applied, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", entries: [...state.entries, ...r.data.entries], next: r.data.nextCursor });
    else setToast("내역을 더 불러오지 못했습니다. 다시 눌러 주십시오");
  };

  const entries = state.kind === "ok" ? state.entries : [];

  return (
    <>
      <Topbar crumb="고객 › 적립금 › 지급·회수 내역" />
      <main className="main">
        <PageHead title="적립금 지급·회수 내역" />

        <SearchBox
          onSearch={() => setUrlState({ from: filter.from, to: filter.to, status: filter.status })}
          onReset={() => {
            setFilter({ from: defaults.from, to: defaults.to, status: "" });
            setUrlState({ from: defaults.from, to: defaults.to, status: "" });
          }}
        >
          <SearchRow label="기간">
            <DateRangePicker quick fromLabel="시작일" toLabel="종료일" from={filter.from} to={filter.to} onChange={(r) => setFilter({ ...filter, ...r })} />
          </SearchRow>
          <SearchRow label="처리 상태">
            <select className="inp" aria-label="처리 상태" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as Status | "" })}>
              <option value="">전체</option>
              <option value="PENDING">대기</option>
              <option value="SUCCEEDED">성공</option>
              <option value="FAILED">실패</option>
            </select>
          </SearchRow>
        </SearchBox>

        <div style={{ marginTop: 16 }}>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="회원·적립금" /> : state.status === 402 ? <Locked /> : <ErrorState title="적립금 내역을 불러오지 못했습니다" onRetry={() => void load(applied)} />)}
          {state.kind === "ok" &&
            (entries.length === 0 ? (
              <div className="st">
                <span className="t">{appliedStatus || applied.from !== defaults.from || applied.to !== defaults.to ? "조건에 맞는 내역이 없습니다" : "아직 적립금 내역이 없습니다"}</span>
              </div>
            ) : (
              <>
                <ListHead total={entries.length} loaded />
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" data-testid="ledger-table">
                    <thead>
                      <tr>
                        <th>일시</th>
                        <th>회원</th>
                        <th>구분</th>
                        <th>금액</th>
                        <th>처리 상태</th>
                        <th>주문</th>
                        <th>사유</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.id} data-testid="ledger-row">
                          <td className="num">{formatDateTime(e.createdAt)}</td>
                          <td className="col-text">
                            <Link href={`/seller/members/${e.member.id}`}>{e.member.broadcastNickname ?? "닉네임 없음"}</Link>
                          </td>
                          <td>
                            {TYPE[e.type]}
                            {e.testMode ? " · 계산만" : ""}
                          </td>
                          <td>{signed(e.amount)}</td>
                          <td>
                            <span className={`bdg ${STATUS[e.status].cls}`}>{STATUS[e.status].label}</span>
                          </td>
                          <td>{e.order ? <Link href={`/seller/orders/${e.order.id}`}>{e.order.orderNo}</Link> : "-"}</td>
                          <td className="col-text">{e.failureReason ?? "-"}</td>
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
          지급·회수는 주문 처리에 따라 자동으로 기록됩니다. 이 화면에서는 조회만 할 수 있습니다.
        </p>
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
