"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListHead, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { OVERLAY_STATE, type SellerActivity } from "../../../_components/ops";
import { dayTime, won } from "../../../_components/partners";

// MA-042 주문·오버레이 접속(GET /api/admin/ops/seller-activity?cursor=, 모든 마스터 역할, 조회만). 이용 중·정지 파트너스를 가입 최신 순으로 50곳씩.
// 「오늘」은 KST 0시부터. 요약 숫자는 지금까지 불러온 파트너스 기준이다(전체 합계 API 없음). 방송 중·접속 안 됨 거르기는 불러온 목록 안에서 한다.
type Page = { at: string; todayStart: string; items: SellerActivity[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: SellerActivity[]; next: string | null };

export default function SellerActivityPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const [offOnly, setOffOnly] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>("/api/admin/ops/seller-activity");
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.items, next: r.data.nextCursor } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/ops/seller-activity?cursor=${encodeURIComponent(state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.items], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const all = state.kind === "ok" ? state.items : [];
  const items = all.filter((s) => (!liveOnly || s.live) && (!offOnly || (s.overlay.hasUrl && !s.overlay.connected)));
  const sum = (f: (s: SellerActivity) => number) => all.reduce((a, s) => a + f(s), 0);

  return (
    <>
      <AdminTopbar crumb="운영 › 주문 · 방송 화면 접속" />
      <main className="main">
        <PageHead title="주문 · 방송 화면 접속" description="기간별 주문 현황과 방송 화면 접속 상태를 파트너스별로 확인합니다." />
        <div className="col" style={{ gap: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {[
              ["오늘 주문", `${sum((s) => s.ordersToday.created).toLocaleString("ko-KR")}건`, "act-created"],
              ["오늘 결제", `${sum((s) => s.ordersToday.paid).toLocaleString("ko-KR")}건`, "act-paid"],
              ["오늘 결제 금액", won(sum((s) => s.ordersToday.paidAmount)), "act-amount"],
              ["방송 화면 연결 중", `${all.filter((s) => s.overlay.connected).length}곳`, "act-connected"],
            ].map(([label, value, id]) => (
              <div key={id} className="card pad col" style={{ gap: 4 }}>
                <span className="t-l2 c-alt">{label}</span>
                <span className="t-h2" data-testid={id}>
                  {value}
                </span>
              </div>
            ))}
          </div>
          <p className="t-c1 c-alt" style={{ margin: 0 }}>
            지금까지 불러온 파트너스 기준입니다. 환불은 결제 금액에서 뺀 값입니다.
          </p>

          <div className="card pad row" style={{ gap: 16, flexWrap: "wrap" }}>
            <label className="chk">
              <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} />
              방송 중만
            </label>
            <label className="chk">
              <input type="checkbox" checked={offOnly} onChange={(e) => setOffOnly(e.target.checked)} />
              방송 화면 연결 안 됨
            </label>
          </div>

          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="주문·오버레이 접속 현황을 불러오지 못했습니다." onRetry={() => void load()} />}
            {state.kind === "ok" &&
              (items.length === 0 ? (
                <div className="st">
                  <span className="t">{liveOnly || offOnly ? "조건에 맞는 파트너스가 없습니다." : "이용 중인 파트너스가 없습니다."}</span>
                </div>
              ) : (
                <>
                  <ListHead total={items.length} unit="곳" loaded />
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>파트너스</th>
                          <th>방송</th>
                          <th>주문</th>
                          <th>결제</th>
                          <th>결제 금액</th>
                          <th>오버레이</th>
                          <th>마지막 접속</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((s) => {
                          const o = OVERLAY_STATE(s.overlay);
                          return (
                            <tr key={s.sellerId} data-testid="activity-row">
                              <td>
                                <b>{s.shopName}</b> <span className="c-alt">· 쇼핑몰 주소 {s.slug}</span>
                                {s.status === "SUSPENDED" && <span className="bdg b-fail"> 이용 정지</span>}
                              </td>
                              <td>{s.live ? <span className="bdg b-done">방송 중</span> : "-"}</td>
                              <td>{s.ordersToday.created}</td>
                              <td>{s.ordersToday.paid}</td>
                              <td>{won(s.ordersToday.paidAmount)}</td>
                              <td>
                                <span className={`bdg ${o.cls}`}>{o.label}</span>
                              </td>
                              <td>{dayTime(s.overlay.lastSeenAt)}</td>
                              <td>
                                <Link className="btn btn-sm btn-out" href={`/admin/partners/${s.sellerId}`}>
                                  상세
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {state.next && (
                    <div className="row" style={{ justifyContent: "center", padding: "12px 16px" }}>
                      <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                        {more ? "불러오는 중" : "더 보기"}
                      </button>
                    </div>
                  )}
                </>
              ))}
          </div>
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}
