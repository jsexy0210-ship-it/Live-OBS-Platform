"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListHead, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { SourceBadge } from "../../../../../../components/seller/broadcast/SourceBadge";
import { kstDate, kstDuration, type BroadcastSummary } from "../../../../../../components/seller/broadcast/history";

// SA-055 방송 상세(방송 이력의 한 건). 요약 · HIT 카드 · 방송 중 들어온 주문(50개씩).
// API: GET /api/seller/broadcast/{id}?cursor=(다른 판매자 방송은 404). 시안의 시간대별 주문·평균 오픈·연결 로그·메모·리포트 내보내기는 서버에 자료·API가 없어 두지 않았다.

type OrderStatus = "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED";
type Order = {
  id: string;
  orderNo: string;
  nickname: string;
  items: { productName: string; optionName: string; quantity: number; unitPrice: number }[];
  totalAmount: number;
  refundAmount: number | null;
  status: OrderStatus;
  createdAt: string;
  paidAt: string | null;
  completedAt: string | null;
};
type Hit = { id: string; cardName: string; note: string | null; nickname: string; order: { id: string; orderNo: string } | null; source?: "INTERNAL" | "EXTERNAL" | null; createdAt: string };
// 외부 쇼핑몰 주문(내부 주문 행이 없어 orders와 따로 온다, 금액·결제 정보 없음)
type ExternalOrder = { id: string; nickname: string; items: { productName: string; quantity: number; status: string }[]; createdAt: string; cancelledAt: string | null; completedAt: string | null };
type Detail = {
  broadcast: { id: string; title: string | null; status: "live" | "ended"; startedAt: string; endedAt: string | null };
  summary: BroadcastSummary;
  orders: Order[];
  nextCursor: string | null;
  hits: Hit[];
  externalOrders?: ExternalOrder[];
};
type Load = { kind: "loading" } | { kind: "error"; status: number; error: string } | { kind: "ok"; data: Detail };

const STATUS_TEXT: Record<OrderStatus, string> = { PENDING_PAYMENT: "결제 대기", PAID: "결제 완료", CANCELLED: "취소", REFUNDED: "환불" };

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="t-l2 c-alt">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

export default function BroadcastDetailPage() {
  const { can } = useSeller();
  const allowed = can("BROADCAST_RUN");
  const { broadcastId } = useParams<{ broadcastId: string }>();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    setState({ kind: "loading" });
    const r = await api<Detail>(`/api/seller/broadcast/${encodeURIComponent(broadcastId)}`);
    if (n !== seq.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", status: r.status, error: r.error });
  }, [broadcastId]);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.data.nextCursor) return;
    const n = seq.current;
    setMore(true);
    const r = await api<Detail>(`/api/seller/broadcast/${encodeURIComponent(broadcastId)}?cursor=${encodeURIComponent(state.data.nextCursor)}`);
    setMore(false);
    if (n !== seq.current) return;
    if (!r.ok) return setToast({ text: failMessage(r, "admin"), neg: true });
    const have = new Set(state.data.orders.map((o) => o.id));
    setState({ kind: "ok", data: { ...state.data, orders: [...state.data.orders, ...r.data.orders.filter((o) => !have.has(o.id))], nextCursor: r.data.nextCursor } });
  };

  const d = state.kind === "ok" ? state.data : null;
  const b = d?.broadcast;
  return (
    <>
      <Topbar crumb="방송 › 방송 이력 › 방송 상세" />
      <main className="main">
        <PageHead
          title="방송 상세"
          actions={
            <>
              {b?.status === "live" && (
                <Link className="btn" href="/seller/broadcast">
                  방송 대시보드로
                </Link>
              )}
              <Link className="btn btn-out" href="/seller/broadcasts">
                목록
              </Link>
            </>
          }
        />

        {!allowed ? (
          <div className="card">
            <NoPermission need="방송 진행" />
          </div>
        ) : state.kind === "loading" ? (
          <div className="card">
            <LoadingRows rows={4} />
          </div>
        ) : state.kind === "error" ? (
          <div className="card">
            {state.status === 402 ? (
              <Locked />
            ) : state.status === 404 ? (
              <div className="st" style={{ boxShadow: "none" }} data-testid="bd-notfound">
                <span className="t">방송을 찾을 수 없습니다</span>
                <Link className="btn btn-sm" href="/seller/broadcasts">
                  방송 이력
                </Link>
              </div>
            ) : state.status === 403 && state.error === "plan_feature_required" ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <span className="t">지금 이용 중인 이용권에는 이 기능이 없습니다. 구독 화면에서 이용권을 바꾸면 사용할 수 있습니다</span>
              </div>
            ) : state.status === 403 ? (
              <NoPermission need="방송 진행" />
            ) : (
              <ErrorState title="방송 상세를 불러오지 못했습니다" onRetry={() => void load()} />
            )}
          </div>
        ) : (
          d &&
          b && (
            <>
              <section className="card pad col" style={{ gap: 12 }} aria-label="방송 정보">
                <table className="au-ft">
                  <tbody>
                    <tr>
                      <th scope="row">방송 제목</th>
                      <td>
                        <div className="au-ft-v" data-testid="bd-title">
                          {b.title || "제목 없는 방송"}
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">일시</th>
                      <td>
                        <div className="au-ft-v">
                          {kstDate(b.startedAt)} ~ {b.endedAt ? kstDate(b.endedAt) : "진행 중"} · {kstDuration(b.startedAt, b.endedAt)}
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">상태</th>
                      <td>
                        <div className="au-ft-v">{b.status === "live" ? <span className="bdg b-live">진행 중</span> : <span className="bdg b-done">종료</span>}</div>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }} data-testid="bd-summary">
                  <Tile label="주문" value={`${d.summary.orders.toLocaleString("ko-KR")}건`} />
                  <Tile label="완료 / 뺀 주문" value={`${d.summary.completed} / ${d.summary.cancelled}`} />
                  <Tile label="매출" value={won(d.summary.sales)} />
                  <Tile label="HIT" value={`${d.summary.hits}장`} />
                </div>
              </section>

              <section className="card pad col" style={{ gap: 12 }} aria-labelledby="bd-hit-h">
                <h2 className="t-hl1" id="bd-hit-h">
                  HIT 카드 <span className="c-alt fw5">{d.hits.length}장</span>
                </h2>
                {d.hits.length === 0 ? (
                  <span className="t-l2 c-alt" data-testid="bd-hit-empty">
                    이 방송에서 기록한 HIT 카드가 없습니다
                  </span>
                ) : (
                  <div className="au-lt-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>시각</th>
                          <th>카드</th>
                          <th>구매자</th>
                          <th>주문</th>
                        </tr>
                      </thead>
                      <tbody data-testid="bd-hits">
                        {d.hits.map((h) => (
                          <tr key={h.id}>
                            <td className="num">{kstDate(h.createdAt)}</td>
                            <td className="col-title">
                              <span className="fw6">{h.cardName}</span>
                              {h.note && <div className="t-c1 c-alt">{h.note}</div>}
                            </td>
                            <td>{h.nickname}</td>
                            <td>{h.order ? h.order.orderNo : h.source === "EXTERNAL" ? <SourceBadge source={h.source} /> : "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="card pad col" style={{ gap: 12 }} aria-labelledby="bd-order-h">
                <h2 className="t-hl1" id="bd-order-h">
                  주문
                </h2>
                <ListHead total={d.orders.length} loaded />
                {d.orders.length === 0 ? (
                  <span className="t-l2 c-alt" data-testid="bd-order-empty">
                    이 방송에는 들어온 주문이 없습니다
                  </span>
                ) : (
                  <div className="au-lt-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>접수 시각</th>
                          <th>구매자</th>
                          <th>상품</th>
                          <th>금액</th>
                          <th>개봉 완료</th>
                          <th>상태</th>
                        </tr>
                      </thead>
                      <tbody data-testid="bd-orders">
                        {d.orders.map((o) => (
                          <tr key={o.id}>
                            <td className="num">{kstDate(o.createdAt)}</td>
                            <td>{o.nickname}</td>
                            <td className="col-product">
                              {o.items.map((i, k) => (
                                <div key={k}>
                                  {i.productName}
                                  {i.optionName ? ` ${i.optionName}` : ""} ×{i.quantity}
                                </div>
                              ))}
                            </td>
                            <td className="num">
                              {won(o.totalAmount)}
                              {o.refundAmount ? <div className="t-c1 c-alt">환불 {won(o.refundAmount)}</div> : null}
                            </td>
                            <td className="num">{o.completedAt ? kstDate(o.completedAt) : "-"}</td>
                            <td>{STATUS_TEXT[o.status]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {d.nextCursor ? (
                  <div className="row" style={{ justifyContent: "center" }}>
                    <button className="btn btn-out" type="button" disabled={more} onClick={() => void loadMore()}>
                      더 보기
                    </button>
                  </div>
                ) : (
                  d.orders.length < d.summary.orders && (
                    <span className="t-c1 c-alt" data-testid="bd-detached-note">
                      탈퇴한 구매자의 주문은 목록에 보이지 않아 위 주문 수보다 적게 보일 수 있습니다.
                    </span>
                  )
                )}
              </section>

              {(d.externalOrders?.length ?? 0) > 0 && (
                <section className="card pad col" style={{ gap: 12 }} aria-labelledby="bd-ext-h" data-testid="bd-external">
                  <h2 className="t-hl1" id="bd-ext-h">
                    다른 쇼핑몰 주문 <span className="c-alt fw5">{d.externalOrders!.length}건</span>
                  </h2>
                  <div className="au-lt-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>접수 시각</th>
                          <th>구매자</th>
                          <th>상품</th>
                          <th>상태</th>
                        </tr>
                      </thead>
                      <tbody data-testid="bd-external-orders">
                        {d.externalOrders!.map((o) => (
                          <tr key={o.id}>
                            <td className="num">{kstDate(o.createdAt)}</td>
                            <td>
                              {o.nickname} <SourceBadge source="EXTERNAL" />
                            </td>
                            <td className="col-product">
                              {o.items.map((i, k) => (
                                <div key={k}>
                                  {i.productName} ×{i.quantity}
                                </div>
                              ))}
                            </td>
                            <td>{o.cancelledAt ? "취소" : o.completedAt ? "개봉 완료" : "진행 중"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <span className="t-c1 c-alt">다른 쇼핑몰에서 들어온 주문은 금액과 결제 내용을 알 수 없어 이 표에 보이지 않습니다.</span>
                </section>
              )}
            </>
          )
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
