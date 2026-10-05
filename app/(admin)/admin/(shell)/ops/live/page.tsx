"use client";

import Link from "next/link";
import { useState } from "react";
import { ListHead, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { AdminTopbar } from "../../../_components/AdminShell";
import { OVERLAY_STATE, clock, elapsed, usePoll, type LiveBroadcast } from "../../../_components/ops";

// MA-041 실시간 방송(GET /api/admin/ops/live-broadcasts, 모든 마스터 역할, 조회만). 10초마다 다시 읽는다.
// 「문제 있음」은 오버레이를 발급했는데 접속하지 않은 방송이다. 읽지 못하면 마지막으로 읽은 내용과 시각을 그대로 두고 알린다.
export default function LiveBroadcastsPage() {
  const { data, failed, first, lastOk, reload } = usePoll<{ items: LiveBroadcast[] }>("/api/admin/ops/live-broadcasts", 10_000);
  const [problemOnly, setProblemOnly] = useState(false);
  const all = data?.items ?? [];
  const isProblem = (b: LiveBroadcast) => b.overlay.hasUrl && !b.overlay.connected;
  const items = problemOnly ? all.filter(isProblem) : all;
  const now = Date.now();

  return (
    <>
      <AdminTopbar crumb="운영 › 실시간 방송" />
      <main className="main">
        <PageHead title="실시간 방송" />
        <div className="col" style={{ gap: 20 }}>
          <div className="card pad row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }} role="status" data-testid="live-status">
            <span className="row" style={{ gap: 8 }}>
              <span className={`bdg ${failed ? "b-fail" : "b-done"}`}>{failed ? "갱신 끊김" : "10초마다 갱신"}</span>
              <span className="t-l2 c-alt">
                마지막 갱신 {clock(lastOk)}
                {failed ? " · 불러오지 못했습니다. 표시된 값은 마지막으로 읽은 내용입니다." : ""}
              </span>
            </span>
            <label className="chk">
              <input type="checkbox" checked={problemOnly} onChange={(e) => setProblemOnly(e.target.checked)} />
              문제 있음만
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {[
              ["방송 중", `${all.length}곳`, "live-count"],
              ["대기 주문", `${all.reduce((s, b) => s + b.queue.waiting, 0).toLocaleString("ko-KR")}건`, "live-waiting"],
              ["오버레이 접속 안 됨", `${all.filter(isProblem).length}곳`, "live-problem"],
            ].map(([label, value, id]) => (
              <div key={id} className="card pad col" style={{ gap: 4 }}>
                <span className="t-l2 c-alt">{label}</span>
                <span className="t-h2" data-testid={id}>
                  {value}
                </span>
              </div>
            ))}
          </div>

          <div className="card">
            {first && <LoadingRows rows={4} />}
            {!first && !data && <ErrorState title="실시간 방송을 불러오지 못했습니다." onRetry={() => void reload()} />}
            {data &&
              (items.length === 0 ? (
                <div className="st">
                  <span className="t">{problemOnly ? "문제 있는 방송이 없습니다." : "지금 방송 중인 파트너스가 없습니다."}</span>
                </div>
              ) : (
                <>
                  <ListHead total={items.length} unit="곳" />
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>파트너스</th>
                          <th>방송</th>
                          <th>방송 시간</th>
                          <th>대기</th>
                          <th>개봉 중</th>
                          <th>완료</th>
                          <th>취소</th>
                          <th>주문</th>
                          <th>오버레이</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((b) => {
                          const o = OVERLAY_STATE(b.overlay);
                          return (
                            <tr key={b.broadcastId} data-testid="live-row">
                              <td>
                                <b>{b.shopName}</b> <span className="c-alt">· {b.slug}</span>
                              </td>
                              <td>{b.title ?? "-"}</td>
                              <td>{elapsed(b.startedAt, now)}</td>
                              <td>{b.queue.waiting}</td>
                              <td>{b.queue.opening}</td>
                              <td>{b.queue.done}</td>
                              <td>{b.queue.cancelled}</td>
                              <td>{b.orders}</td>
                              <td>
                                <span className={`bdg ${o.cls}`}>{o.label}</span>
                              </td>
                              <td>
                                <Link className="btn btn-sm btn-out" href={`/admin/partners/${b.sellerId}`}>
                                  상세
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ))}
          </div>
        </div>
      </main>
    </>
  );
}
