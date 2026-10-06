"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { ListHead, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { ImpersonateDialog } from "../../../_components/ImpersonateDialog";
import { clock, elapsed, usePoll, type LiveBroadcast } from "../../../_components/ops";

// MA-041 실시간 방송(GET /api/admin/ops/live-broadcasts, 모든 마스터 역할, 조회만). 10초마다 다시 읽는다. 대신 보기(MA-016)는 최고관리자·운영·고객 지원만.
// 「방송 화면 불안정」은 방송 화면(오버레이) 주소를 발급했는데 접속하지 않은 방송, 「결제 연결 오류」는 최근 24시간 결제 실패 뒤 성공이 없는 파트너스다.
// 읽지 못하면 마지막으로 읽은 내용과 시각을 그대로 두고 알린다. 문제가 있는 방송이 위로 온다.
const LAYOUT: Record<string, string> = { "9x16": "세로형", "16x9": "가로형" };
const unstable = (b: LiveBroadcast) => b.overlay.hasUrl && !b.overlay.connected;
const problem = (b: LiveBroadcast) => unstable(b) || b.paymentError;
const perMinute = (b: LiveBroadcast, now: number) => b.orders / Math.max(1, (now - new Date(b.startedAt).getTime()) / 60_000);

export default function LiveBroadcastsPage() {
  const { me } = useAdmin();
  const canImpersonate = adminCan(me.role, "seller.impersonate");
  const { data, failed, first, lastOk, reload } = usePoll<{ items: LiveBroadcast[] }>("/api/admin/ops/live-broadcasts", 10_000);
  const [problemOnly, setProblemOnly] = useState(false);
  const [view, setView] = useState<"table" | "card">("table");
  const [viewing, setViewing] = useState<LiveBroadcast | null>(null);
  // 휴대폰에서는 표 대신 카드로 시작한다(표 가로 스크롤을 피함)
  useEffect(() => {
    if (window.matchMedia("(max-width: 639px)").matches) setView("card");
  }, []);
  const [toast, setToast] = useState<string | null>(null);
  const all = data?.items ?? [];
  const now = Date.now();
  const items = (problemOnly ? all.filter(problem) : all).slice().sort((a, b) => Number(problem(b)) - Number(problem(a)));
  const rate = all.reduce((s, b) => s + perMinute(b, now), 0);

  const overlayTag = (b: LiveBroadcast) =>
    !b.overlay.hasUrl ? <span className="bdg b-gray">주소 없음</span> : unstable(b) ? <span className="bdg b-warn">불안정</span> : <span className="bdg b-done">정상</span>;
  const payTag = (b: LiveBroadcast) => (b.paymentError ? <span className="bdg b-fail">결제 연결 오류</span> : <span className="bdg b-done">결제대행사 정상</span>);
  const actions = (b: LiveBroadcast) => (
    <span className="row" style={{ gap: 6 }}>
      {canImpersonate && b.sellerStatus === "ACTIVE" && (
        <button className="btn btn-sm btn-out" type="button" onClick={() => setViewing(b)}>
          대신 보기
        </button>
      )}
      <Link className="btn btn-sm btn-out" href={`/admin/partners/${b.sellerId}`}>
        상세
      </Link>
    </span>
  );

  return (
    <>
      <AdminTopbar crumb="운영 › 실시간 방송" />
      <main className="main">
        <PageHead title="실시간 방송" />
        <div className="col" style={{ gap: 20 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }} role="status" data-testid="live-status">
            <span className="row" style={{ gap: 8 }}>
              <span className={`bdg ${failed ? "b-fail" : "b-done"}`}>{failed ? "자동 새로고침 멈춤" : `LIVE ${all.length}`}</span>
              <span className="t-l2 c-alt">
                {failed ? "10초마다 갱신 멈춤" : "10초마다 갱신"} · {clock(lastOk)}
                {failed ? " · 불러오지 못했습니다. 표시된 값은 마지막으로 읽은 내용입니다." : ""}
              </span>
            </span>
            <div className="seg" role="radiogroup" aria-label="보기 방식">
              {(
                [
                  ["table", "표"],
                  ["card", "카드"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? "on" : ""} onClick={() => setView(k)}>
                  {label}
                </button>
              ))}
            </div>
            <label className="chk">
              <input type="checkbox" checked={problemOnly} onChange={(e) => setProblemOnly(e.target.checked)} />
              문제 있음만
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {[
              ["방송 중", `${all.length}곳`, "live-count"],
              ["총 대기 주문", `${all.reduce((s, b) => s + b.queue.waiting, 0).toLocaleString("ko-KR")}건`, "live-waiting"],
              ["분당 주문 (전체)", rate.toFixed(1), "live-rate"],
              ["방송 화면 불안정", `${all.filter(unstable).length}곳`, "live-problem"],
              ["결제 연결 오류 중 방송", `${all.filter((b) => b.paymentError).length}곳`, "live-payment"],
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
              ) : view === "card" ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, padding: 16 }}>
                  {items.map((b) => (
                    <div key={b.broadcastId} className="card pad col" style={{ gap: 8, boxShadow: "none" }} data-testid="live-row">
                      <b>{b.shopName}</b>
                      <span className="t-c1 c-alt">{b.title ?? "-"}</span>
                      <span className="t-l2">
                        {elapsed(b.startedAt, now)} · 대기 {b.queue.waiting} · 완료 {b.queue.done} · 분당 {perMinute(b, now).toFixed(1)}
                      </span>
                      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {overlayTag(b)}
                        {payTag(b)}
                        <span className="t-c1 c-alt">{b.layoutAspect ? (LAYOUT[b.layoutAspect] ?? "-") : "-"}</span>
                      </span>
                      {actions(b)}
                    </div>
                  ))}
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
                          <th>시간</th>
                          <th>대기</th>
                          <th>완료</th>
                          <th>분당</th>
                          <th>방송 화면</th>
                          <th>결제대행사</th>
                          <th>레이아웃</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((b) => (
                          <tr key={b.broadcastId} data-testid="live-row">
                            <td>
                              <b>{b.shopName}</b>
                            </td>
                            <td>{b.title ?? "-"}</td>
                            <td>{elapsed(b.startedAt, now)}</td>
                            <td>{b.queue.waiting}</td>
                            <td>{b.queue.done}</td>
                            <td>{perMinute(b, now).toFixed(1)}</td>
                            <td>{overlayTag(b)}</td>
                            <td>{payTag(b)}</td>
                            <td>{b.layoutAspect ? (LAYOUT[b.layoutAspect] ?? "-") : "-"}</td>
                            <td>{actions(b)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ))}
          </div>
        </div>
      </main>
      {viewing && (
        <ImpersonateDialog
          seller={{ id: viewing.sellerId, shopName: viewing.shopName }}
          onClose={() => setViewing(null)}
          onDone={(r) => {
            setViewing(null);
            setToast(r.opened ? "대신 보기를 시작했습니다. 새 창에서 파트너스 화면을 읽기 전용으로 봅니다." : "대신 보기를 시작했습니다. 새 창이 막혀 열지 못했습니다. 파트너스 상세에서 다시 열어 주십시오.");
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
