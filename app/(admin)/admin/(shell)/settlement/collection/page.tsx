"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { won } from "../../../_components/partners";

// MA-032 구독료 수납 현황(GET /api/admin/subscription-billing, 모든 마스터 역할, 조회만). 기간(KST 날짜, 청구 시각 기준)을 비우면 오늘 하루.
// 결제 목록은 청구·결제 내역(MA-024), 연체·유예 파트너스는 구독 현황(MA-023)에서 본다.
type Summary = { charged: number; paid: number; failed: number; pending: number; paidAmount: number; failedAmount: number; retrying: number; pastDue: number; grace: number };
type Daily = { date: string; charged: number; paid: number; failed: number; paidAmount: number };
type Data = { range: { from: string; to: string }; summary: Summary; daily: Daily[] };
type Load = { kind: "loading" } | { kind: "error"; invalid?: boolean } | { kind: "ok"; data: Data };

const range = (from: string, to: string) => {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  return p.toString();
};

export default function CollectionPage() {
  const [draft, setDraft] = useState({ from: "", to: "" });
  const [applied, setApplied] = useState({ from: "", to: "" });
  const [state, setState] = useState<Load>({ kind: "loading" });
  const reqId = useRef(0);
  const rangeError = !!draft.from && !!draft.to && draft.from > draft.to;
  const load = useCallback(async (f: { from: string; to: string }) => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Data>(`/api/admin/subscription-billing?${range(f.from, f.to)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", invalid: r.status === 400 });
  }, []);
  useEffect(() => void load(applied), [applied, load]);

  const s = state.kind === "ok" ? state.data.summary : null;
  const tiles: { label: string; value: string; testId: string }[] = s
    ? [
        { label: "청구", value: `${s.charged}건`, testId: "charged" },
        { label: "결제 완료", value: `${s.paid}건 · ${won(s.paidAmount)}`, testId: "paid" },
        { label: "결제 실패", value: `${s.failed}건 · ${won(s.failedAmount)}`, testId: "failed" },
        { label: "결제 대기", value: `${s.pending}건`, testId: "pending" },
        { label: "재시도 중", value: `${s.retrying}건`, testId: "retrying" },
        { label: "연체", value: `${s.pastDue}곳`, testId: "pastDue" },
        { label: "유예", value: `${s.grace}곳`, testId: "grace" },
      ]
    : [];

  return (
    <>
      <AdminTopbar crumb="정산 › 구독료 수납" />
      <main className="main">
        <PageHead title="구독료 수납" />
        <div className="col" style={{ gap: 20 }}>
          <SearchBox
            onSearch={() => !rangeError && setApplied(draft)}
            onReset={() => { setDraft({ from: "", to: "" }); setApplied({ from: "", to: "" }); }}
            busy={state.kind === "loading"}
          >
            <SearchRow label="청구 기간">
              <input className="inp" type="date" aria-label="시작일" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              <span aria-hidden="true">~</span>
              <input className="inp" type="date" aria-label="종료일" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              {rangeError && (
                <span className="err" role="alert">
                  시작일이 종료일보다 늦습니다.
                </span>
              )}
            </SearchRow>
          </SearchBox>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && (
            <ErrorState
              title={state.invalid ? "기간은 최대 366일까지 조회할 수 있습니다." : "구독료 수납 현황을 불러오지 못했습니다."}
              onRetry={() => void load(applied)}
            />
          )}
          {state.kind === "ok" && (
            <>
              <p className="t-l2 c-alt" data-testid="collection-range">
                {state.data.range.from === state.data.range.to ? state.data.range.from : `${state.data.range.from} ~ ${state.data.range.to}`} 기준입니다.
              </p>
              <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                {tiles.map((t) => (
                  <div key={t.testId} className="card pad" style={{ minWidth: 160 }} data-testid={`collection-${t.testId}`}>
                    <div className="t-l2 c-alt">{t.label}</div>
                    <b>{t.value}</b>
                  </div>
                ))}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Link className="btn btn-sm btn-out" href="/admin/billing/invoices">
                  청구·결제 내역
                </Link>
                <Link className="btn btn-sm btn-out" href="/admin/billing/subscriptions">
                  구독 현황(연체·유예)
                </Link>
              </div>
              <div className="card">
                {state.data.daily.length === 0 ? (
                  <div className="st">
                    <span className="t">이 기간에 청구가 없습니다.</span>
                  </div>
                ) : (
                  <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                    <thead>
                      <tr>
                        <th>날짜</th>
                        <th>청구</th>
                        <th>결제 완료</th>
                        <th>결제 실패</th>
                        <th>수납 금액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.data.daily.map((d) => (
                        <tr key={d.date} data-testid="collection-row">
                          <td>{d.date}</td>
                          <td>{d.charged}</td>
                          <td>{d.paid}</td>
                          <td>{d.failed}</td>
                          <td>{won(d.paidAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
