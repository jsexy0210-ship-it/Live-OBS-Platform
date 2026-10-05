"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { dayTime } from "../../../_components/partners";

// MA-100 실시간 감시(GET /api/admin/ops/metrics, 최고관리자만 — 다른 역할은 셸이 권한 없음 화면으로 막는다). 10초마다 다시 읽는다.
// 「감시 끊김」: 지표를 읽지 못하면 마지막으로 읽은 시각과 함께 알린다. 정기 실행은 신호가 1시간 주기(SCHEDULER_INTERVAL_MS)라 3시간 넘게 없으면 멈춤으로 본다.
const REFRESH_MS = 10_000;
const STALE_MS = 3 * 3600_000;
type Beat = { instance: string; job: string | null; lastRunAt: string | null; lastStatus: string; lastOkAt: string | null; lastError: string | null; registeredAt: string };
type Open = { source: string; key: string; occurredAt: string; message: string; severity: string };
type Recent = { source: string; key: string; kind: string; severity: string; message: string; occurredAt: string; seq: string };
type Metrics = {
  checkedAt: string;
  db: { latencyMs: number; connections: { total: number; active: number; idle: number; idleInTransaction: number; waitingLock: number; max: number } };
  heartbeats: Beat[];
  incidents: { open: Open[]; recent: Recent[] };
};

const SEVERITY: Record<string, { label: string; cls: string }> = {
  critical: { label: "심각", cls: "b-fail" },
  warning: { label: "주의", cls: "b-warn" },
  info: { label: "안내", cls: "b-info" },
};
const KIND: Record<string, string> = { incident_open: "장애 발생", incident_close: "장애 해소", warning: "주의", info: "안내" };
const sev = (s: string) => SEVERITY[s] ?? SEVERITY.info;

// 정기 실행 한 줄의 상태: 실패 > 신호 없음 > 멈춤(오래 실행 없음) > 정상
function beatState(b: Beat, now: number): { label: string; cls: string } {
  if (b.lastStatus === "failed") return { label: "실패", cls: "b-fail" };
  const at = b.lastRunAt ? new Date(b.lastRunAt).getTime() : new Date(b.registeredAt).getTime();
  if (b.lastStatus === "no_signal" || now - at > STALE_MS) return { label: "신호 없음", cls: "b-warn" };
  return { label: "정상", cls: "b-done" };
}

export default function OpsMonitorPage() {
  const [data, setData] = useState<Metrics | null>(null);
  const [failed, setFailed] = useState(false);
  const [lastOk, setLastOk] = useState<string | null>(null);
  const [first, setFirst] = useState(true);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const r = await adminApi<Metrics>("/api/admin/ops/metrics");
    busy.current = false;
    setFirst(false);
    if (r.ok) {
      setData(r.data);
      setLastOk(r.data.checkedAt);
      setFailed(false);
    } else setFailed(true);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const now = Date.now();
  const open = data?.incidents.open ?? [];
  const beats = (data?.heartbeats ?? []).filter((b) => b.job !== null || b.lastStatus === "no_signal");
  const stalled = beats.filter((b) => beatState(b, now).cls !== "b-done").length;
  const actions = (data?.incidents.recent ?? []).filter((e) => e.kind === "incident_close" || e.kind === "info" || e.kind === "warning");

  return (
    <>
      <AdminTopbar crumb="운영 › 실시간 감시" />
      <main className="main">
        <PageHead
          title="실시간 감시"
          actions={
            <button className="btn btn-out" type="button" onClick={() => void load()}>
              지금 새로고침
            </button>
          }
        />
        <div className="col" style={{ gap: 20 }}>
          <div className="card pad row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }} role="status" data-testid="monitor-status">
            <span className="row" style={{ gap: 8 }}>
              <span className={`bdg ${failed ? "b-fail" : "b-done"}`}>{failed ? "감시 끊김" : "감시 중"}</span>
              <span className="t-l2 c-alt">
                마지막 갱신 {dayTime(lastOk)}
                {failed ? " · 지표를 불러오지 못했습니다. 10초마다 다시 시도합니다." : " · 10초마다 새로 읽습니다."}
              </span>
            </span>
          </div>

          {first && (
            <div className="card">
              <LoadingRows rows={4} />
            </div>
          )}
          {!first && !data && (
            <div className="card">
              <ErrorState title="실시간 감시 정보를 불러오지 못했습니다." onRetry={() => void load()} />
            </div>
          )}

          {data && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                {[
                  ["열린 장애", `${open.length}건`, "monitor-open"],
                  ["정기 실행 이상", `${stalled}건`, "monitor-stalled"],
                  ["DB 응답", `${data.db.latencyMs}ms`, "monitor-latency"],
                  ["DB 연결", `${data.db.connections.total}/${data.db.connections.max}`, "monitor-conn"],
                ].map(([label, value, id]) => (
                  <div key={id} className="card pad col" style={{ gap: 4 }}>
                    <span className="t-l2 c-alt">{label}</span>
                    <span className="t-h2" data-testid={id}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              <section className="card" aria-labelledby="mon-open">
                <h2 className="t-hl1 pad-l" id="mon-open">
                  열린 장애
                </h2>
                {open.length === 0 ? (
                  <div className="st">
                    <span className="t">열린 장애가 없습니다.</span>
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>심각도</th>
                          <th>내용</th>
                          <th>감시 대상</th>
                          <th>시작</th>
                        </tr>
                      </thead>
                      <tbody>
                        {open.map((e) => (
                          <tr key={`${e.source}:${e.key}`} data-testid="monitor-incident">
                            <td>
                              <span className={`bdg ${sev(e.severity).cls}`}>{sev(e.severity).label}</span>
                            </td>
                            <td className="col-text">{e.message}</td>
                            <td className="c-alt">{e.key}</td>
                            <td className="num">{dayTime(e.occurredAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="card" aria-labelledby="mon-beats">
                <h2 className="t-hl1 pad-l" id="mon-beats">
                  정기 실행
                </h2>
                {beats.length === 0 ? (
                  <div className="st">
                    <span className="t">등록된 서버가 없습니다.</span>
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>서버</th>
                          <th>작업</th>
                          <th>상태</th>
                          <th>마지막 실행</th>
                          <th>마지막 성공</th>
                          <th>오류</th>
                        </tr>
                      </thead>
                      <tbody>
                        {beats.map((b) => {
                          const st = beatState(b, now);
                          return (
                            <tr key={`${b.instance}:${b.job ?? ""}`} data-testid="monitor-beat">
                              <td>{b.instance}</td>
                              <td>{b.job ?? "-"}</td>
                              <td>
                                <span className={`bdg ${st.cls}`}>{st.label}</span>
                              </td>
                              <td className="num">{dayTime(b.lastRunAt)}</td>
                              <td className="num">{dayTime(b.lastOkAt)}</td>
                              <td className="c-alt col-text">{b.lastError ?? "-"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="card" aria-labelledby="mon-actions">
                <h2 className="t-hl1 pad-l" id="mon-actions">
                  장애 해소·조치 기록
                </h2>
                {actions.length === 0 ? (
                  <div className="st">
                    <span className="t">최근 기록이 없습니다.</span>
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>시각</th>
                          <th>구분</th>
                          <th>심각도</th>
                          <th>내용</th>
                        </tr>
                      </thead>
                      <tbody>
                        {actions.map((e) => (
                          <tr key={e.seq} data-testid="monitor-action">
                            <td className="num">{dayTime(e.occurredAt)}</td>
                            <td>{KIND[e.kind] ?? e.kind}</td>
                            <td>
                              <span className={`bdg ${sev(e.severity).cls}`}>{sev(e.severity).label}</span>
                            </td>
                            <td className="col-text">{e.message}</td>
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
