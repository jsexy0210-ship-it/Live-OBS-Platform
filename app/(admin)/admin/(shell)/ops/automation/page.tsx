"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { useUrlState } from "../../../../../../lib/client/navigation";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { JOB_STATUS, PAY_STATUS } from "../../../_components/automation";
import { dayTime } from "../../../_components/partners";

// MA-110 자동 연결 작업 목록. API: GET /api/automation/admin/jobs?filter=…(마스터 관리자 전 역할, 조회만).
// 보드에 있고 서버에 없는 것(작업 서버 열, 동시 실행 상한·작업 서버별 현황)은 넣지 않았다. 「오늘 모델 비용」은 외부 API 비용 원장 합계이고 월 한도 사용량을 함께 보인다.
type Filter = "all" | "customer" | "failed" | "done";
type Row = {
  id: string;
  shopName: string;
  shopHost: string | null;
  status: string;
  step: string | null;
  paymentStatus: string | null;
  customerAction: string | null;
  attempts: number;
  startedAt: string | null;
  createdAt: string;
};
type Data = {
  summary: { running: number; queued: number; customerWaiting: number; doneToday: number; failedToday: number; costTodayWon: number; monthly: { usedWon: number; limitWon: number; stopped: boolean } };
  jobs: Row[];
};
const FILTERS: [Filter, string][] = [["all", "전체"], ["customer", "고객 확인 대기"], ["failed", "실패"], ["done", "완료"]];
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

function AutomationJobsPageInner() {
  // 걸러 보기는 주소 쿼리가 기준이다(상세 → Back에서 그대로 돌아온다). 없는 값은 「전체」로 본다.
  const [q, setQ] = useUrlState({ filter: "all" });
  const filter: Filter = FILTERS.some(([f]) => f === q.filter) ? (q.filter as Filter) : "all";
  const setFilter = (f: Filter) => setQ({ filter: f });
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void adminApi<Data>(`/api/automation/admin/jobs?filter=${filter}`).then((r) => live && setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" }));
    return () => {
      live = false;
    };
  }, [filter, tick]);

  const d = state.kind === "ok" ? state.data : null;
  return (
    <>
      <AdminTopbar crumb="운영 › 자동 연결 작업" />
      <main className="main">
        <PageHead title="자동 연결 작업" actions={<button className="btn btn-out" type="button" onClick={() => setTick((n) => n + 1)}>새로 고침</button>} />
        <div className="col" style={{ gap: 16 }}>
          {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
          {state.kind === "error" && <div className="card"><ErrorState title="불러오지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주십시오." onRetry={() => setTick((n) => n + 1)} /></div>}
          {d && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                {[
                  ["진행 중", `${d.summary.running}`, "sum-running", ""],
                  ["대기", `${d.summary.queued}`, "sum-queued", ""],
                  ["고객 확인 대기", `${d.summary.customerWaiting}`, "sum-customer", "실행 자리를 잡지 않습니다"],
                  ["오늘 완료", `${d.summary.doneToday}`, "sum-done", `실패 ${d.summary.failedToday}`],
                  ["오늘 모델 비용", won(d.summary.costTodayWon), "sum-cost", `이번 달 ${won(d.summary.monthly.usedWon)} / ${won(d.summary.monthly.limitWon)}`],
                ].map(([label, value, id, sub]) => (
                  <div key={id} className="card pad col" style={{ gap: 4 }}>
                    <span className="t-l2 c-alt">{label}</span>
                    <span className="t-h2" data-testid={id}>{value}</span>
                    {sub && <span className="t-c1 c-alt">{sub}</span>}
                  </div>
                ))}
              </div>
              {d.summary.monthly.stopped && (
                <div className="msg msg-cau" role="status" data-testid="budget-stopped">
                  <span><b>이번 달 모델 비용 한도({won(d.summary.monthly.limitWon)})에 닿아 새 자동 연결 접수와 판단 호출을 멈췄습니다.</b> 다음 달 1일(KST)에 다시 열립니다</span>
                </div>
              )}
              <span className="row" style={{ gap: 6 }} role="group" aria-label="작업 상태">
                {FILTERS.map(([f, label]) => (
                  <button key={f} type="button" className={`btn btn-sm ${filter === f ? "" : "btn-out"}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}</button>
                ))}
              </span>
              <section className="card">
                {d.jobs.length === 0 ? (
                  <div className="st"><span className="t">{filter === "all" ? "진행 중인 자동 연결이 없습니다." : "조건에 맞는 작업이 없습니다."}</span></div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl">
                      <thead><tr><th>파트너스</th><th>외부 쇼핑몰</th><th>결제</th><th>작업 상태</th><th>시작</th><th>관리</th></tr></thead>
                      <tbody>
                        {d.jobs.map((j) => {
                          const s = JOB_STATUS[j.status] ?? { label: j.status, cls: "b-gray" };
                          const p = j.paymentStatus ? PAY_STATUS[j.paymentStatus] : null;
                          return (
                            <tr key={j.id} data-testid="automation-job">
                              <td><b>{j.shopName}</b></td>
                              <td>{j.shopHost ?? "—"}</td>
                              <td>{p ? <span className={`bdg ${p.cls}`}>{p.label}</span> : "—"}</td>
                              <td><span className={`bdg ${s.cls}`}>{s.label}</span></td>
                              <td>{dayTime(j.startedAt ?? j.createdAt)}</td>
                              <td><Link className="btn btn-sm btn-out" href={`/admin/ops/automation/${j.id}`}>상세</Link></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <span className="t-c1 c-alt">결제 상태와 작업 상태는 따로 둡니다 · 결제가 확인되지 않으면 작업은 시작하지 않습니다</span>
            </>
          )}
        </div>
      </main>
    </>
  );
}

export default function AutomationJobsPage() {
  return (
    <Suspense fallback={null}>
      <AutomationJobsPageInner />
    </Suspense>
  );
}
