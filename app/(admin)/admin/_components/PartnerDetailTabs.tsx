"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FormRow, FormSection } from "../../../../components/admin-ui/FormTable";
import { Pagination } from "../../../../components/admin-ui/ListTable";
import { SearchBox, SearchRow } from "../../../../components/admin-ui/SearchBox";
import { ErrorState, LoadingRows } from "../../../../components/seller/States";
import { adminApi } from "./api";
import { SUBSCRIPTION_STATUS, day, dayTime, won, type SellerDetail } from "./partners";
import { SummaryStrip } from "./SummaryStrip";

// 파트너스 상세(MA-012)의 구독·주문 현황·쇼핑몰 탭. 모두 마스터 관리자 전 역할이 읽는 읽기 전용이고, 서버가 주는 값만 보인다.
// 서버: GET /api/admin/sellers/{id}/subscription · …/orders · …/shop.
type Load<T> = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: T };

function useRead<T>(url: string) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<T>(url);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, [url]);
  useEffect(() => void load(), [load]);
  return [state, load] as const;
}

// 표·목록 구역: 제목 줄(오른쪽에 작은 버튼) + 내용. 정본의 「구역 제목(sec-t)」과 같다.
const Section = ({ title, id, actions, children }: { title: string; id: string; actions?: React.ReactNode; children: React.ReactNode }) => (
  <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby={id}>
    <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
      <h2 className="t-hl1" id={id}>
        {title}
      </h2>
      {actions}
    </div>
    {children}
  </section>
);
// 두 열(정본 `.two`): 넓은 폭에서 반반, 좁으면 한 열로 쌓인다
const Two = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(480px, 100%), 1fr))", gap: 20, alignItems: "start" }}>{children}</div>
);
// 날짜 한 줄 표기: 「8/10」 · 「9/10 00:10」
const md = (iso: string) => {
  const [, m, d] = day(iso).split(".");
  return `${Number(m)}/${Number(d)}`;
};
const mdTime = (iso: string) => `${md(iso)} ${dayTime(iso).slice(-5)}`;

// ─── 구독 탭(MA-012-3): 상태 이력 · 청구 상세 ───
type SubState = "PAID" | "PENDING" | "RETRYING" | "OVERDUE" | "FAILED" | "REFUNDED" | "SCHEDULED" | "TRIAL";
type SubItem = { id: string; state: SubState; kind?: string; at: string; amount: number; planName: string | null; periodStart: string | null; receipt?: "ISSUED" | "NOT_ISSUED" | "CANCELED" | "SCHEDULED"; receiptUrl?: string | null };
type SubData = {
  history: { at: string; kind: string; text: string }[];
  trial: { startedAt: string; endsAt: string; days: number } | null;
  invoices: { items: SubItem[]; total: number; nextCursor: string | null };
  totals: { paidAmount: number; paidCount: number; refundedAmount: number; refundedCount: number };
};
const SUB_STATE: Record<SubState, { label: string; cls: string }> = {
  PAID: { label: "결제 완료", cls: "b-done" },
  PENDING: { label: "진행 중", cls: "b-wait" },
  RETRYING: { label: "실패 · 재시도", cls: "b-warn" },
  OVERDUE: { label: "연체", cls: "b-fail" },
  FAILED: { label: "실패", cls: "b-fail" },
  REFUNDED: { label: "환불 완료", cls: "b-gray" },
  SCHEDULED: { label: "예정", cls: "b-info" },
  TRIAL: { label: "체험 중", cls: "b-info" },
};
const itemName = (i: SubItem) => (i.state === "TRIAL" ? `${i.planName ?? "요금제"} 체험` : `${i.planName ?? "구독"} ${i.kind === "PRORATION" ? "차액" : "월 구독"}`);

export function PartnerSubscriptionTab({ seller }: { seller: SellerDetail }) {
  const sellerId = seller.id;
  const [state, reload] = useRead<SubData>(`/api/admin/sellers/${encodeURIComponent(sellerId)}/subscription`);
  const [extra, setExtra] = useState<{ items: SubItem[]; next: string | null } | null>(null);
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  useEffect(() => setExtra(null), [sellerId]);

  if (state.kind === "loading") return <LoadingRows rows={4} />;
  if (state.kind === "error") return <ErrorState title="구독 정보를 불러오지 못했습니다." onRetry={() => void reload()} />;
  const d = state.data;
  const sub = seller.subscription;
  const items = [...d.invoices.items.filter((i) => i.state !== "TRIAL"), ...(extra?.items ?? []), ...d.invoices.items.filter((i) => i.state === "TRIAL")];
  const next = extra ? extra.next : d.invoices.nextCursor;
  const loadMore = async () => {
    if (!next || more) return;
    setMore(true);
    setMoreError(false);
    const r = await adminApi<SubData>(`/api/admin/sellers/${encodeURIComponent(sellerId)}/subscription?cursor=${encodeURIComponent(next)}`);
    setMore(false);
    if (!r.ok) return setMoreError(true);
    setExtra({ items: [...(extra?.items ?? []), ...r.data.invoices.items.filter((i) => i.state !== "TRIAL")], next: r.data.invoices.nextCursor });
  };
  return (
    <div data-testid="tab-subscription">
      <Two>
        <div className="col" style={{ gap: 20 }}>
          <FormSection title="요금제">
            <FormRow label="요금제">
              {sub ? (
                <span className="row" style={{ gap: 8, alignItems: "center" }}>
                  <b>{sub.planName}</b>
                  <span className={`bdg ${SUBSCRIPTION_STATUS[sub.status].cls}`}>{SUBSCRIPTION_STATUS[sub.status].label}</span>
                </span>
              ) : (
                "구독 없음"
              )}
            </FormRow>
            <FormRow label="구독 시작">{d.trial ? `${day(d.trial.startedAt)} · ${md(d.trial.endsAt)} 체험 종료 (${d.trial.days}일)` : "-"}</FormRow>
            <FormRow label="현재 기간">{sub ? `${day(sub.currentPeriodStart)} ~ ${day(sub.currentPeriodEnd)}` : "-"}</FormRow>
            <FormRow label="다음 결제">{sub ? dayTime(sub.nextChargeAt) : "-"}</FormRow>
            <FormRow label="결제 수단">{sub?.cardLabel ?? "-"}</FormRow>
            {sub?.pendingPlanName && <FormRow label="바뀔 요금제">{sub.pendingPlanName}</FormRow>}
            <FormRow label="해지 예약">{sub ? (sub.cancelAtPeriodEnd ? "이용 기간이 끝나면 해지" : "없음") : "-"}</FormRow>
            {sub && (sub.graceUntil || sub.retryCount > 0) && (
              <FormRow label="결제 실패">
                {sub.graceUntil ? `${dayTime(sub.graceUntil)}까지 기다려 줍니다 · ` : ""}다시 시도 {sub.retryCount}회
              </FormRow>
            )}
            <FormRow label="제공량">
              <span className="bdg b-gray">추후 안내</span>
            </FormRow>
          </FormSection>
          <Section title="상태 이력" id="sub-history">
            {d.history.length === 0 ? (
              <div className="st">
                <span className="t">이력이 없습니다.</span>
              </div>
            ) : (
              <table className="tbl" aria-label="상태 이력">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>날짜</th>
                    <th>내용</th>
                  </tr>
                </thead>
                <tbody>
                  {d.history.map((h, n) => (
                    <tr key={`${h.at}-${n}`}>
                      <td className="num">{md(h.at)}</td>
                      <td className="col-text">{h.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>
        <Section
          title="청구 · 결제 내역"
          id="sub-invoices"
          actions={
            <Link className="btn btn-sm btn-out" href={`/admin/billing/invoices?sellerId=${sellerId}`}>
              청구 상세
            </Link>
          }
        >
          {items.length === 0 ? (
            <div className="st">
              <span className="t">청구 내역이 없습니다.</span>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="tbl" style={{ whiteSpace: "nowrap" }} aria-label="청구 · 결제 내역">
                <thead>
                  <tr>
                    <th style={{ width: 80 }}>청구월</th>
                    <th>항목</th>
                    <th style={{ width: 100 }}>금액</th>
                    <th style={{ width: 100 }}>결제일</th>
                    <th style={{ width: 90 }}>상태</th>
                    <th style={{ width: 90 }}>매출전표</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} data-testid="sub-invoice-row">
                      <td className="num">{day(i.periodStart ?? i.at).slice(0, 7).replace(".", "-")}</td>
                      <td className="col-text">{itemName(i)}</td>
                      <td className="num">{won(i.amount)}</td>
                      <td className="num">{i.state === "TRIAL" ? "—" : i.state === "SCHEDULED" ? `예정 ${md(i.at)}` : mdTime(i.at)}</td>
                      <td>
                        <span className={`bdg ${SUB_STATE[i.state].cls}`}>{SUB_STATE[i.state].label}</span>
                      </td>
                      <td>
                        {i.receipt === "ISSUED" && i.receiptUrl ? (
                          <a className="btn btn-sm btn-out" href={i.receiptUrl} target="_blank" rel="noopener noreferrer">
                            매출전표
                          </a>
                        ) : i.state === "SCHEDULED" ? (
                          <span className="t-c1 c-alt">결제 후 발행</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {next && (
            <div className="row" style={{ justifyContent: "center" }}>
              <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                {more ? "불러오는 중" : "더 보기"}
              </button>
              {moreError && (
                <span className="err" role="alert">
                  더 불러오지 못했습니다. 다시 눌러 주십시오.
                </span>
              )}
            </div>
          )}
          <span className="t-c1 c-alt" data-testid="sub-totals">
            누적 결제 {won(d.totals.paidAmount)} · 환불 {d.totals.refundedCount > 0 ? `${d.totals.refundedCount}건 ${won(d.totals.refundedAmount)}` : "0"}
          </span>
        </Section>
      </Two>
    </div>
  );
}

// ─── 주문 현황 탭(MA-012-6) ───
type Payment = "PAID" | "FAILED" | "REFUND_REQUESTED" | "PENDING" | "CANCELLED" | "REFUNDED";
type OrderRow = { id: string; orderNo: number; createdAt: string; nickname: string | null; productName: string | null; optionName: string | null; quantity: number; extraItems: number; amount: number; payment: Payment; queue: "OPENING" | "WAITING" | "DONE" | "CANCELLED" | null };
type Anomaly = { status: "OK" | "WARN"; count?: number; todayAmount?: number; yesterdayAmount?: number };
type OrdersData = {
  summary: { todayOrders: number; monthOrders: number; monthAmount: number; cancelRefundRate: number | null; platformCancelRefundRate: number | null; paymentFailRate7d: number | null; disputeCount: number | null };
  orders: OrderRow[];
  total: number;
  page: number;
  pageSize: number;
  anomalies: { repeatCancel: Anomaly; highAmountSpike: Anomaly; paymentFailStreak: Anomaly; refundRequestOverdue: Anomaly };
  monthly: { month: string; count: number }[];
};
const PAYMENT: Record<Payment, { label: string; cls: string }> = {
  PAID: { label: "완료", cls: "b-done" },
  FAILED: { label: "실패", cls: "b-fail" },
  REFUND_REQUESTED: { label: "환불 요청", cls: "b-warn" },
  PENDING: { label: "결제 대기", cls: "b-wait" },
  CANCELLED: { label: "취소", cls: "b-gray" },
  REFUNDED: { label: "환불 완료", cls: "b-gray" },
};
const QUEUE = { OPENING: "개봉 중", WAITING: "대기", DONE: "완료", CANCELLED: "취소" } as const;
const RANGES = [
  ["today", "오늘"],
  ["7d", "7일"],
  ["1m", "1개월"],
  ["3m", "3개월"],
  ["", "전체"],
] as const;
const STATUSES = [
  ["all", "전체"],
  ["paid", "완료"],
  ["failed", "실패"],
  ["refund_requested", "환불 요청"],
  ["pending", "결제 대기"],
] as const;
const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
const OK_WARN = (a: Anomaly, okText: string, warnText: string) => (a.status === "OK" ? <span className="bdg b-done">{okText}</span> : <span className="bdg b-warn">{warnText}</span>);

export function PartnerOrdersTab({ sellerId }: { sellerId: string }) {
  const [draft, setDraft] = useState({ range: "", status: "all" });
  const [applied, setApplied] = useState(draft);
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams();
  if (applied.range) qs.set("range", applied.range);
  if (applied.status !== "all") qs.set("status", applied.status);
  qs.set("page", String(page));
  const [state, reload] = useRead<OrdersData>(`/api/admin/sellers/${encodeURIComponent(sellerId)}/orders?${qs}`);
  const d = state.kind === "ok" ? state.data : null;
  const search = () => {
    setApplied(draft);
    setPage(1);
  };
  const reset = () => {
    const empty = { range: "", status: "all" };
    setDraft(empty);
    setApplied(empty);
    setPage(1);
  };
  const maxMonth = Math.max(1, ...(d?.monthly.map((m) => m.count) ?? [1]));
  const from = d && d.orders.length > 0 ? (d.page - 1) * d.pageSize + 1 : 0;
  return (
    <div className="col" style={{ gap: 20 }} data-testid="tab-orders">
      <div className="msg msg-info" role="note">
        구매자 개인정보는 닉네임과 가린 값만 보입니다 · 대금은 플랫폼을 거치지 않습니다 · 주문 상세는 대리 조회에서 봅니다 (사유가 기록됩니다)
      </div>
      {state.kind === "error" && <ErrorState title="주문 현황을 불러오지 못했습니다." onRetry={() => void reload()} />}
      {d && (
        <SummaryStrip
          label="주문 요약"
          testId="orders-summary"
          min={150}
          cells={[
            { label: "오늘 주문", value: d.summary.todayOrders.toLocaleString("ko-KR"), testId: "orders-today" },
            { label: "이번 달", value: d.summary.monthOrders.toLocaleString("ko-KR") },
            { label: "이번 달 거래액", value: won(d.summary.monthAmount) },
            { label: "취소 · 환불률", value: pct(d.summary.cancelRefundRate), sub: d.summary.platformCancelRefundRate === null ? undefined : `플랫폼 평균 ${d.summary.platformCancelRefundRate}%` },
            { label: "결제 실패율 (7일)", value: pct(d.summary.paymentFailRate7d) },
            { label: "환불 분쟁 · 신고", value: d.summary.disputeCount === null ? "집계 준비 중" : String(d.summary.disputeCount) },
          ]}
        />
      )}
      <SearchBox onSearch={search} onReset={reset} busy={state.kind === "loading"} label="주문 검색 조건">
        <SearchRow label="기간">
          <span className="row" style={{ gap: 4, flexWrap: "wrap" }} role="group" aria-label="기간">
            {RANGES.map(([v, l]) => (
              <button key={l} type="button" className={`btn btn-sm ${draft.range === v ? "" : "btn-out"}`} aria-pressed={draft.range === v} onClick={() => setDraft({ ...draft, range: v })}>
                {l}
              </button>
            ))}
          </span>
        </SearchRow>
        <SearchRow label="상태">
          <select className="inp" style={{ width: 160, maxWidth: "100%" }} aria-label="주문 상태" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
            {STATUSES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </SearchRow>
      </SearchBox>
      <div className="card">
        {state.kind === "loading" && <LoadingRows rows={4} />}
        {d &&
          (d.orders.length === 0 ? (
            <div className="st">
              <span className="t">조건에 맞는 주문이 없습니다.</span>
            </div>
          ) : (
            <>
              <div className="row" style={{ padding: "12px 16px" }}>
                <span className="t-l2 c-alt">
                  · {from}–{from + d.orders.length - 1} 표시 (총 {d.total.toLocaleString("ko-KR")}건)
                </span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ whiteSpace: "nowrap" }} aria-label="주문">
                  <thead>
                    <tr>
                      <th>주문</th>
                      <th>시각</th>
                      <th>구매자 (닉네임)</th>
                      <th>상품</th>
                      <th>금액</th>
                      <th>결제</th>
                      <th>주문대기</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.orders.map((o) => (
                      <tr key={o.id} data-testid="partner-order-row">
                        <td className="num">{o.orderNo}</td>
                        <td className="num">{dayTime(o.createdAt).slice(-5)}</td>
                        <td>{o.nickname ?? "—"}</td>
                        <td className="col-text">
                          {o.productName ?? "—"}
                          {o.quantity > 1 ? ` ×${o.quantity}` : ""}
                          {o.extraItems > 0 ? ` 외 ${o.extraItems}건` : ""}
                        </td>
                        <td className="num">{won(o.amount)}</td>
                        <td>
                          <span className={`bdg ${PAYMENT[o.payment].cls}`}>{PAYMENT[o.payment].label}</span>
                        </td>
                        <td>{o.queue ? QUEUE[o.queue] : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={d.page} pageCount={Math.ceil(d.total / d.pageSize)} onChange={setPage} />
            </>
          ))}
      </div>
      {d && (
        <Two>
          <Section title="이상 징후 점검" id="orders-anomalies">
            <table className="tbl" aria-label="이상 징후 점검">
              <thead>
                <tr>
                  <th>항목</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="col-text">동일 구매자 반복 취소</td>
                  <td>{OK_WARN(d.anomalies.repeatCancel, "없음", `${d.anomalies.repeatCancel.count}명`)}</td>
                </tr>
                <tr>
                  <td className="col-text">고액 주문 급증 (전일 대비)</td>
                  <td>{OK_WARN(d.anomalies.highAmountSpike, "정상", `오늘 ${won(d.anomalies.highAmountSpike.todayAmount ?? 0)} · 전일 ${won(d.anomalies.highAmountSpike.yesterdayAmount ?? 0)}`)}</td>
                </tr>
                <tr>
                  <td className="col-text">결제 실패 연속</td>
                  <td>{OK_WARN(d.anomalies.paymentFailStreak, "없음", `${d.anomalies.paymentFailStreak.count}건`)}</td>
                </tr>
                <tr>
                  <td className="col-text">환불 요청 미처리 48시간 초과</td>
                  <td>{OK_WARN(d.anomalies.refundRequestOverdue, "0건", `${d.anomalies.refundRequestOverdue.count}건`)}</td>
                </tr>
              </tbody>
            </table>
          </Section>
          <Section title="월별 주문 추이" id="orders-monthly">
            {d.monthly.length === 0 ? (
              <div className="st">
                <span className="t">주문이 없습니다.</span>
              </div>
            ) : (
              <div className="row" style={{ gap: 24, alignItems: "flex-end", justifyContent: "space-around", minHeight: 150 }} data-testid="orders-monthly">
                {d.monthly.map((m) => (
                  <div key={m.month} className="col" style={{ gap: 4, alignItems: "center", flex: 1, justifyContent: "flex-end" }}>
                    <span className="t-c1 num">{m.count.toLocaleString("ko-KR")}</span>
                    <span aria-hidden="true" style={{ display: "block", width: 28, height: Math.max(2, Math.round((m.count / maxMonth) * 100)), background: "var(--wds-primary-normal, #0a7a6b)" }} />
                    <span className="t-c1 c-alt">{Number(m.month.slice(5))}월</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </Two>
      )}
    </div>
  );
}

// ─── 쇼핑몰 탭(MA-012-2): 파트너스가 쇼핑몰 설정에서 관리하는 값을 보기만 한다 ───
type ShopData = {
  operatingState: "OPEN" | "PREPARING" | "PAUSED";
  shopName: string;
  tagline: string | null;
  slug: string;
  brandColor: string | null;
  primaryAddressKind: "DEFAULT" | "CUSTOM";
  domains: { hostname: string; verified: boolean; suspended: boolean }[];
  topNotice: string | null;
  usageGuide: string | null;
  policyChecks: { businessCsInfo: "DISPLAYED" | "MISSING"; refundPolicy: "WRITTEN" | "MISSING"; minorRestriction: "WRITTEN" | "MISSING" };
  reportCount: number;
  products: { visible: number; total: number };
  members: number;
  month: { since: string; orders: number; amount: number };
  topProducts: { id: string; name: string; status: "DRAFT" | "ON_SALE" | "SOLD_OUT" | "HIDDEN"; soldCount: number }[];
};
const OPERATING = { OPEN: "운영 중", PREPARING: "준비 중", PAUSED: "일시 정지" } as const;
const PRODUCT_STATUS = { DRAFT: ["작성 중", "b-gray"], ON_SALE: ["판매 중", "b-done"], SOLD_OUT: ["품절", "b-fail"], HIDDEN: ["숨김", "b-gray"] } as const;
const text = (v: string | null) => (v && v.trim() !== "" ? v : "-");

export function PartnerShopTab({ sellerId }: { sellerId: string }) {
  const [state, reload] = useRead<ShopData>(`/api/admin/sellers/${encodeURIComponent(sellerId)}/shop`);
  if (state.kind === "loading") return <LoadingRows rows={4} />;
  if (state.kind === "error") return <ErrorState title="쇼핑몰 정보를 불러오지 못했습니다." onRetry={() => void reload()} />;
  const s = state.data;
  const check = (ok: boolean, yes: string, no: string) => <span className={`bdg ${ok ? "b-done" : "b-warn"}`}>{ok ? yes : no}</span>;
  const primary = s.domains.find((d) => !d.suspended && d.verified);
  const host = s.primaryAddressKind === "CUSTOM" && primary ? primary.hostname : null;
  return (
    <div data-testid="tab-shop">
      <Two>
        <div className="col" style={{ gap: 20 }}>
          <FormSection title="쇼핑몰 정보">
            <FormRow label="운영 상태">
              <span className={`bdg ${s.operatingState === "OPEN" ? "b-done" : "b-gray"}`}>{OPERATING[s.operatingState]}</span>
              <span className="t-c1 c-alt">파트너스가 쇼핑몰 정보에서 관리합니다 · 여기서는 보기만 합니다</span>
            </FormRow>
            <FormRow label="쇼핑몰명">{s.shopName}</FormRow>
            <FormRow label="소개">{text(s.tagline)}</FormRow>
            <FormRow label="대표 색상">
              {s.brandColor ? (
                <span className="row" style={{ gap: 6, alignItems: "center" }}>
                  <span aria-hidden="true" style={{ width: 12, height: 12, background: s.brandColor, display: "inline-block" }} />
                  {s.brandColor}
                </span>
              ) : (
                "-"
              )}
            </FormRow>
            <FormRow label="도메인">
              {host ?? s.slug}
              {host === null && s.primaryAddressKind === "DEFAULT" ? " · 기본 주소" : ""}
              {s.domains.length > 0 && <span className="t-c1 c-alt">{s.domains.map((d) => `${d.hostname}${d.suspended ? " (정지)" : d.verified ? "" : " (확인 전)"}`).join(" · ")}</span>}
            </FormRow>
            <FormRow label="상단 공지">{text(s.topNotice)}</FormRow>
            <FormRow label="이용안내">{text(s.usageGuide)}</FormRow>
          </FormSection>
          <Section title="정책 점검" id="shop-policy">
            <table className="tbl" aria-label="정책 점검">
              <thead>
                <tr>
                  <th>항목</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="col-text">사업자 · 고객센터 정보 표시 (전자상거래법)</td>
                  <td>{check(s.policyChecks.businessCsInfo === "DISPLAYED", "표시됨", "미표시")}</td>
                </tr>
                <tr>
                  <td className="col-text">교환 · 환불 정책 기재</td>
                  <td>{check(s.policyChecks.refundPolicy === "WRITTEN", "기재됨", "미기재")}</td>
                </tr>
                <tr>
                  <td className="col-text">금지 품목 · 미성년자 판매 제한 문구</td>
                  <td>{check(s.policyChecks.minorRestriction === "WRITTEN", "기재됨", "미기재")}</td>
                </tr>
                <tr>
                  <td className="col-text">신고 접수</td>
                  <td>{s.reportCount}건</td>
                </tr>
              </tbody>
            </table>
          </Section>
        </div>
        <div className="col" style={{ gap: 20 }}>
          <SummaryStrip
            label="운영 현황"
            testId="shop-stats"
            min={120}
            cells={[
              { label: "노출 상품", value: `${s.products.visible.toLocaleString("ko-KR")} / ${s.products.total.toLocaleString("ko-KR")}` },
              { label: "회원", value: s.members.toLocaleString("ko-KR") },
              { label: "이번 달 주문", value: s.month.orders.toLocaleString("ko-KR") },
              { label: "이번 달 거래액", value: won(s.month.amount) },
            ]}
          />
          <Section title="상품 상위 5" id="shop-top">
            {s.topProducts.length === 0 ? (
              <div className="st">
                <span className="t">판매된 상품이 없습니다.</span>
              </div>
            ) : (
              <table className="tbl" aria-label="상품 상위 5">
                <thead>
                  <tr>
                    <th>상품</th>
                    <th style={{ width: 80 }}>판매</th>
                    <th style={{ width: 90 }}>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {s.topProducts.map((p) => (
                    <tr key={p.id}>
                      <td className="col-text">{p.name}</td>
                      <td className="num">{p.soldCount.toLocaleString("ko-KR")}</td>
                      <td>
                        <span className={`bdg ${PRODUCT_STATUS[p.status][1]}`}>{PRODUCT_STATUS[p.status][0]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <span className="t-c1 c-alt">판매 수 기준</span>
          </Section>
        </div>
      </Two>
    </div>
  );
}
