"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../components/seller/States";
import { adminApi } from "../_components/api";
import { AdminTopbar } from "../_components/AdminShell";
import { dayTime, won } from "../_components/partners";

// MA-001 통합 대시보드(GET /api/admin/dashboard, 모든 마스터 역할, 숫자만·조회만). 숫자 칸은 해당 목록 화면으로 이어진다.
type Summary = {
  at: string;
  sellers: { total: number; PENDING: number; ACTIVE: number; SUSPENDED: number; REJECTED: number; CLOSED: number };
  liveBroadcasts: number;
  ordersToday: { created: number; paid: number; paidAmount: number };
  subscriptions: { trial: number; paid: number; charging: number; grace: number; expired: number };
};
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Summary };
const n = (v: number, unit: string) => `${v.toLocaleString("ko-KR")}${unit}`;

function Tile({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div className="card pad col" style={{ gap: 4 }}>
      <span className="t-l2 c-alt">{label}</span>
      <span className="t-h2" data-testid={id}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, href, link, children }: { title: string; href?: string; link?: string; children: React.ReactNode }) {
  return (
    <section className="col" style={{ gap: 10 }} aria-label={title}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="t-hl1">{title}</h2>
        {href && (
          <Link className="btn btn-sm btn-out" href={href}>
            {link}
          </Link>
        )}
      </div>
      <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {children}
      </div>
    </section>
  );
}

export default function AdminHome() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Summary>("/api/admin/dashboard");
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const d = state.kind === "ok" ? state.data : null;
  return (
    <>
      <AdminTopbar crumb="홈 › 통합 대시보드" />
      <main className="main">
        <PageHead
          title="통합 대시보드"
          actions={
            <>
              {d && <span className="t-l2 c-alt">{dayTime(d.at)} 기준</span>}
              <button className="btn btn-out" type="button" onClick={() => void load()} disabled={state.kind === "loading"}>
                새로 고침
              </button>
            </>
          }
        />
        {!d ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" && <ErrorState title="대시보드를 불러오지 못했습니다." onRetry={() => void load()} />}
          </div>
        ) : (
          <div className="col" style={{ gap: 24 }}>
            <Section title="파트너스" href="/admin/partners" link="파트너스 목록">
              <Tile id="dash-sellers-active" label="운영 중" value={n(d.sellers.ACTIVE, "곳")} />
              <Tile id="dash-sellers-pending" label="승인 대기" value={n(d.sellers.PENDING, "곳")} />
              <Tile id="dash-sellers-suspended" label="이용 정지" value={n(d.sellers.SUSPENDED, "곳")} />
              <Tile id="dash-sellers-total" label="전체" value={n(d.sellers.total, "곳")} />
            </Section>
            <Section title="오늘">
              <Tile id="dash-live" label="지금 방송 중" value={n(d.liveBroadcasts, "곳")} />
              <Tile id="dash-orders-created" label="들어온 주문" value={n(d.ordersToday.created, "건")} />
              <Tile id="dash-orders-paid" label="결제된 주문" value={n(d.ordersToday.paid, "건")} />
              <Tile id="dash-orders-amount" label="결제 금액" value={won(d.ordersToday.paidAmount)} />
            </Section>
            <Section title="구독" href="/admin/billing/subscriptions" link="구독 현황">
              <Tile id="dash-sub-trial" label="체험" value={n(d.subscriptions.trial, "곳")} />
              <Tile id="dash-sub-paid" label="이용 중" value={n(d.subscriptions.paid, "곳")} />
              <Tile id="dash-sub-charging" label="결제 처리 중" value={n(d.subscriptions.charging, "곳")} />
              <Tile id="dash-sub-grace" label="연체" value={n(d.subscriptions.grace, "곳")} />
              <Tile id="dash-sub-expired" label="해지" value={n(d.subscriptions.expired, "곳")} />
            </Section>
          </div>
        )}
      </main>
    </>
  );
}
