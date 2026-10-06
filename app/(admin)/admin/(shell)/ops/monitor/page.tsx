"use client";

import { useState } from "react";
import { ListHead, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { AdminTopbar } from "../../../_components/AdminShell";
import { PAYMENT_CHECK, clock, usePoll, type Monitor } from "../../../_components/ops";
import { dayTime } from "../../../_components/partners";

// MA-100 실시간 감시(GET /api/admin/ops/monitor, platform.read: 모든 마스터 역할이 메뉴·화면을 볼 수 있다 — 정본 「조회 전용 권한」 변형, 오류 문구만 최고관리자에게). 10초마다 다시 읽는다.
// 「감시 끊김」: 읽지 못하면 마지막으로 읽은 내용과 시각을 그대로 두고 알린다. 웹훅은 서버가 재지 않아(not_measured) 「측정 안 함」으로 보인다.
// 정본(design/project/MA-100.dc.html FINAL)에 있고 서버에 없는 것(웹훅 지연 값, 결제 검증 지연 초, 오늘 비용, 장애별 자동 조치·처리 상태, 자동 해결 숨기기, 자동 조치 결과, 안전 규칙 문구, 자동 연결 결제 잠시 막기)은 넣지 않는다(MASTER 판단 대기).
const SEVERITY: Record<string, { label: string; cls: string }> = {
  critical: { label: "긴급", cls: "b-fail" },
  warning: { label: "주의", cls: "b-warn" },
  info: { label: "정보", cls: "b-info" },
};
const sev = (s: string) => SEVERITY[s] ?? SEVERITY.info;
type Filter = "all" | "critical" | "warning";
const JOB_STATUS: Record<string, string> = { done: "성공", skipped: "건너뜀", failed: "실패", no_signal: "신호 없음" };

export default function OpsMonitorPage() {
  const { data, failed, first, lastOk, reload } = usePoll<Monitor>("/api/admin/ops/monitor", 10_000);
  const [filter, setFilter] = useState<Filter>("all");
  const incidents = (data?.incidents ?? []).filter((e) => filter === "all" || e.severity === filter);
  const critical = (data?.incidents ?? []).filter((e) => e.severity === "critical").length;
  const jobsBad = (data?.jobs ?? []).filter((j) => !j.healthy).length;
  const payPending = (data?.paymentChecks ?? []).reduce((s, p) => s + p.pending, 0);

  return (
    <>
      <AdminTopbar crumb="운영 › 실시간 감시" />
      <main className="main">
        <PageHead
          title="실시간 감시"
          actions={
            <button className="btn" type="button" onClick={() => void reload()}>
              지금 갱신
            </button>
          }
        />
        <div className="col" style={{ gap: 20 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }} role="status" data-testid="monitor-status">
            <span className="t-c1 c-alt">
              {failed ? <span className="bdg b-fail">감시 끊김</span> : <span className="sr-only">감시 중</span>} 마지막 갱신 {clock(lastOk)}
              {failed ? " · 감시 데이터를 읽지 못했습니다. 화면의 숫자는 마지막으로 읽은 값입니다. 10초마다 다시 시도합니다." : " · 10초마다"}
            </span>
            {critical > 0 && <span className="bdg b-fail">긴급 {critical}</span>}
          </div>

          {first && (
            <div className="card">
              <LoadingRows rows={4} />
            </div>
          )}
          {!first && !data && (
            <div className="card">
              <ErrorState title="실시간 감시 정보를 불러오지 못했습니다." onRetry={() => void reload()} />
            </div>
          )}

          {data && (
            <>
              <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", overflow: "hidden" }}>
                {[
                  ["서비스 서버", `${data.servers.healthy}/${data.servers.total} 정상`, "monitor-servers", data.servers.stale + data.servers.noSignal > 0 ? `멈춘 서버 ${data.servers.stale} · 응답 없는 서버 ${data.servers.noSignal}` : ""],
                  ["자동으로 도는 작업", `${data.jobs.length - jobsBad}/${data.jobs.length} 정상`, "monitor-jobs", ""],
                  ["자동 연결 대기", `${data.queue.automationQueued}건`, "monitor-queue", data.queue.oldestQueuedAt ? `가장 오래된 ${dayTime(data.queue.oldestQueuedAt)}` : ""],
                  ["외부 알림 수신 지연", "확인하지 않음", "monitor-webhook", "받은 기록을 저장하지 않습니다"],
                  ["결제 결과 확인 대기", `${payPending}건`, "monitor-pay", ""],
                ].map(([label, value, id, sub], i) => (
                  <div key={id} className="col pad" style={{ gap: 4, borderLeft: i === 0 ? "none" : "1px solid var(--wds-line-normal, #e5e7eb)" }}>
                    <span className="t-l2 c-alt">{label}</span>
                    <span className="t-h2" data-testid={id}>
                      {value}
                    </span>
                    {sub && <span className="t-c1 c-alt">{sub}</span>}
                  </div>
                ))}
              </div>

              <section className="card" aria-labelledby="mon-open">
                <div className="row pad-l" style={{ gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                  <h2 className="t-hl1" id="mon-open">
                    장애 · 이상 목록
                  </h2>
                  <div className="seg" role="radiogroup" aria-label="얼마나 급한지">
                    {(["all", "critical", "warning"] as Filter[]).map((f) => (
                      <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                        {f === "all" ? "전체" : f === "critical" ? "긴급" : "주의"}
                      </button>
                    ))}
                  </div>
                </div>
                {incidents.length === 0 ? (
                  <div className="st">
                    <span className="t">{data.incidents.length === 0 ? "모두 정상입니다 · 열린 장애가 없습니다" : "조건에 맞는 장애가 없습니다."}</span>
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>시각</th>
                          <th>심각도</th>
                          <th>대상</th>
                          <th>내용</th>
                          <th>자동 조치</th>
                          <th>상태</th>
                        </tr>
                      </thead>
                      <tbody>
                        {incidents.map((e) => (
                          <tr key={`${e.source}:${e.key}`} data-testid="monitor-incident">
                            <td>{dayTime(e.occurredAt)}</td>
                            <td>
                              <span className={`bdg ${sev(e.severity).cls}`}>{sev(e.severity).label}</span>
                            </td>
                            <td>{e.key}</td>
                            <td className="col-text">{e.message}</td>
                            <td>—</td>
                            <td>
                              <span className="bdg b-warn">열림</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="card" aria-labelledby="mon-actions">
                <h2 className="t-hl1 pad-l" id="mon-actions">
                  자동 조치 기록
                </h2>
                {data.autoActions.length === 0 ? (
                  <div className="st">
                    <span className="t">최근 자동 조치가 없습니다.</span>
                  </div>
                ) : (
                  <>
                    <ListHead total={data.autoActions.length} />
                    <div style={{ overflowX: "auto" }}>
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>시각</th>
                            <th>조치</th>
                            <th>대상</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.autoActions.map((a) => (
                            <tr key={a.id} data-testid="monitor-action">
                              <td>{dayTime(a.createdAt)}</td>
                              <td>{a.action}</td>
                              <td>{a.targetType ?? "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </section>

              <section className="card" aria-labelledby="mon-pay">
                <h2 className="t-hl1 pad-l" id="mon-pay">
                  결제 결과 확인 대기
                </h2>
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>종류</th>
                        <th>대기</th>
                        <th>가장 오래된 시각</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.paymentChecks.map((p) => (
                        <tr key={p.kind} data-testid="monitor-paycheck">
                          <td>{PAYMENT_CHECK[p.kind] ?? p.kind}</td>
                          <td>{p.pending}건</td>
                          <td>{dayTime(p.oldestAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card" aria-labelledby="mon-jobs">
                <h2 className="t-hl1 pad-l" id="mon-jobs">
                  자동으로 도는 작업
                </h2>
                {data.jobs.length === 0 ? (
                  <div className="st">
                    <span className="t">기록된 정기 실행이 없습니다.</span>
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>작업</th>
                          <th>상태</th>
                          <th>마지막 실행</th>
                          <th>마지막으로 성공한 때</th>
                          <th>서버</th>
                          <th>오류</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.jobs.map((j) => (
                          <tr key={j.job} data-testid="monitor-job">
                            <td>{j.job}</td>
                            <td>
                              <span className={`bdg ${j.healthy ? "b-done" : "b-fail"}`}>{j.healthy ? "정상" : (JOB_STATUS[j.lastStatus] ?? "이상")}</span>
                            </td>
                            <td>{dayTime(j.lastRunAt)}</td>
                            <td>{dayTime(j.lastOkAt)}</td>
                            <td>{j.instances}대</td>
                            <td className="col-text">{j.lastError ?? "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
