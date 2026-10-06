"use client";

import { formatDate, formatDateTime } from "../../../../../lib/client/format";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { COURIERS } from "../../../../../lib/server/orders/shipping";
import { StateBox, errorText, kstText, stateKind } from "../banners/_shared/ui";
import "./returns.css";

// SA-029 교환 · 반품(파트너스 관리자, 주문 › 교환 · 반품). 요약 카드, 신청 목록·상태별 건수, 상세(사유·사진·품목), 접수(수거 방법) · 거절(사유 선택) · 입고 확인 · 검수 · 반품 환불 · 교환 발송 · 교환 재고 없음(재입고 뒤 발송 · 환불로 전환) · 무통장 환불 계좌 확인.
// 조회와 처리는 대표자 · 주문 배송(ORDER_SHIPPING) 권한 직원. 환불은 기존 환불을 호출한다(실제 결제 취소는 결제 연결이 담당). API: /api/seller/returns.
type Status = "REQUESTED" | "ACCEPTED" | "RECEIVED" | "COMPLETED" | "REJECTED" | "CANCELLED";
type Kind = "RETURN" | "EXCHANGE";
type Fault = "BUYER" | "SELLER";
type Reason = "CHANGE_OF_MIND" | "DEFECTIVE" | "WRONG_ITEM" | "NOT_AS_DESCRIBED" | "OTHER";
type Row = {
  id: string;
  orderNo: number;
  nickname: string;
  kind: Kind;
  status: Status;
  reason: Reason;
  reasonText: string;
  items: { orderItemId: string; productName: string; optionName: string; quantity: number; orderQuantity: number }[];
  createdAt: string;
};
type RefundRow = { seq: number; createdAt: string; refundAmount: number; shippingRefunded: number; returnFeeDeducted: number; rewardReturn: number; isFinal: boolean; items: { quantity: number; productName: string; optionName: string }[] };
type Summary = { requested: number; inProgress: number; doneReturn: number; doneExchange: number; returnRate30: number | null };
type Data = { returns: Row[]; nextCursor: string | null; counts: Partial<Record<Status, number>>; summary: Summary };
type Pickup = "COURIER" | "BUYER_SHIP" | "NONE";
type Inspection = "OK" | "USED_DAMAGED" | "MISSING_PARTS";
type Detail = Row & {
  fault: Fault | null;
  rejectReason: string | null;
  returnCourierName: string | null;
  returnTrackingNumber: string | null;
  exchangeCourierName: string | null;
  exchangeTrackingNumber: string | null;
  restocked: boolean;
  refundAmount: number | null;
  pickupMethod: Pickup;
  inspectionResult: Inspection | null;
  inspectionNote: string | null;
  exchangeHeldAt: string | null;
  convertedFromExchange: boolean;
  partialQuantity: boolean;
  refunds: RefundRow[];
  paymentMethod: string | null;
  refundAccount: { bankName: string; accountHolder: string; accountNumber: string | null } | null;
  images: { id: string; width: number; height: number }[];
  order: { status: string; totalAmount: number; shippingFee: number };
  refundPreview: { byFault: Record<Fault, { refundAmount: number; returnFeeDeducted: number; rewardReturn: number; blocked: boolean }> } | null;
  queueVersion: number | null;
};

const REASON: Record<Reason, string> = { CHANGE_OF_MIND: "단순 변심", DEFECTIVE: "상품 불량 · 파손", WRONG_ITEM: "다른 상품 수령", NOT_AS_DESCRIBED: "상품 설명과 다름", OTHER: "기타" };
const DEFAULT_FAULT: Record<Reason, Fault | null> = { CHANGE_OF_MIND: "BUYER", DEFECTIVE: "SELLER", WRONG_ITEM: "SELLER", NOT_AS_DESCRIBED: "SELLER", OTHER: null };
const STATUS: Record<Status, { label: string; cls: string }> = {
  REQUESTED: { label: "접수", cls: "b-pending" },
  ACCEPTED: { label: "수거 중", cls: "b-info" },
  RECEIVED: { label: "상품 확인 중", cls: "b-info" },
  COMPLETED: { label: "완료", cls: "b-done" },
  REJECTED: { label: "거절", cls: "b-gray nodot" },
  CANCELLED: { label: "철회", cls: "b-gray nodot" },
};
const KIND: Record<Kind, string> = { RETURN: "반품", EXCHANGE: "교환" };
const PICKUP: Record<Pickup, string> = { COURIER: "택배사 수거", BUYER_SHIP: "구매자 직접 발송", NONE: "수거 없음 (폐기 · 사진 확인)" };
const INSPECTION: Record<Inspection, string> = { OK: "이상 없음", USED_DAMAGED: "사용 흔적 · 훼손", MISSING_PARTS: "구성품 누락" };
// 거절 사유 선택지(시안): 고르면 사유 칸에 채워지고, 「직접 입력」은 비워서 쓴다
const REJECT_PRESETS = ["개봉 · 사용한 상품", "요청 기한(7일) 지남", "구매자 귀책 파손"];
type Tab = "all" | "REQUESTED" | "ACCEPTED" | "RECEIVED" | "closed";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "REQUESTED", label: "접수" },
  { key: "ACCEPTED", label: "수거 중" },
  { key: "RECEIVED", label: "상품 확인 중" },
  { key: "closed", label: "완료 · 거절" },
];
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const inTab = (tab: Tab, s: Status) => tab === "all" || (tab === "closed" ? s === "COMPLETED" || s === "REJECTED" || s === "CANCELLED" : s === tab);

export default function ReturnsPage() {
  const { can } = useSeller();
  const canEdit = can("ORDER_SHIPPING");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; data: Data }>({ kind: "loading" });
  // 탭은 URL 쿼리(?status=REQUESTED 등)와 맞춘다: 파트너스 홈 「처리할 일」 링크가 접수 탭으로 바로 연다
  const [urlState, setUrlState] = useUrlState({ status: "all" });
  const tab: Tab = TABS.some((t) => t.key === urlState.status) ? (urlState.status as Tab) : "all";
  const setTab = (t: Tab) => setUrlState({ status: t });
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<Data>("/api/seller/returns");
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", data: r.data });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useScrollRestore("seller-returns", state.kind === "ok");
  const data = state.kind === "ok" ? state.data : null;
  const rows = data ? data.returns.filter((r) => inTab(tab, r.status)) : [];
  const c = data?.counts ?? {};

  return (
    <>
      <Topbar crumb="주문 › 교환 · 반품" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">교환 · 반품</h1>
            <span className="t-l2 c-alt">구매자가 신청한 교환·반품을 처리하는 화면입니다. 접수 → 수거 → 상품 확인 → 환불 또는 교환 상품 발송 순서로 진행합니다.</span>
          </div>
        </div>
        <section className="card" style={{ overflow: "hidden" }}>
          {state.kind === "loading" && <StateBox kind="loading" what="교환 · 반품" />}
          {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="교환 · 반품" onRetry={() => void load()} />}
          {data && (
            <>
              <div className="rt-sum" data-testid="rt-summary">
                <div className="rt-sum-c">
                  <span className="t-c1 c-alt">접수 (처리 필요)</span>
                  <b className="t-t3 num">{data.summary.requested}건</b>
                  <span className="t-c1 c-alt">24시간 안 승인 · 거절 권장</span>
                </div>
                <div className="rt-sum-c">
                  <span className="t-c1 c-alt">수거 · 확인 중</span>
                  <b className="t-t3 num">{data.summary.inProgress}건</b>
                </div>
                <div className="rt-sum-c">
                  <span className="t-c1 c-alt">이번 달 완료</span>
                  <b className="t-t3 num">{data.summary.doneReturn + data.summary.doneExchange}건</b>
                  <span className="t-c1 c-alt">
                    반품 {data.summary.doneReturn} · 교환 {data.summary.doneExchange}
                  </span>
                </div>
                <div className="rt-sum-c">
                  <span className="t-c1 c-alt">반품률 (30일)</span>
                  <b className="t-t3 num">{data.summary.returnRate30 === null ? "-" : `${data.summary.returnRate30}%`}</b>
                  <span className="t-c1 c-alt">반품 ÷ 배송 완료 주문</span>
                </div>
              </div>
              <div className="tabs" role="tablist" style={{ padding: "0 12px" }}>
                {TABS.map((t) => (
                  <button key={t.key} className={`tab${tab === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                    {t.label}
                    {t.key === "REQUESTED" && <span className="cnt">{c.REQUESTED ?? 0}</span>}
                  </button>
                ))}
              </div>
              {rows.length === 0 ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <span className="t">{tab === "all" ? "처리할 교환 · 반품 요청이 없습니다" : "해당하는 신청이 없습니다"}</span>
                  <span className="s">구매자가 주문 상세에서 신청하면 여기에 들어옵니다</span>
                </div>
              ) : (
                <div role="list">
                  {rows.map((r) => (
                    <div key={r.id} className="rt-row" role="listitem" tabIndex={0} data-testid="return-row" onClick={() => setOpenId(r.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(r.id)}>
                      <span className="col" style={{ gap: 2, minWidth: 0 }}>
                        <span className="t-l2 fw6 num">주문 {r.orderNo}</span>
                        <span className="t-c1 c-alt">{r.nickname}</span>
                      </span>
                      <span className="t-l2 fw6">{KIND[r.kind]}</span>
                      <span className="col rt-hide-m" style={{ gap: 2, minWidth: 0 }}>
                        <span className="t-l2">{REASON[r.reason]}</span>
                        <span className="t-c1 c-alt ell">
                          {r.items.map((i) => `${i.productName} ${i.quantity}개`).join(" · ")}
                        </span>
                      </span>
                      <span>
                        <span className={`bdg ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                      </span>
                      <span className="t-c1 c-alt rt-hide-m num">{formatDate(r.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
        {data && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>신청 처리는 대표자나 주문 · 배송 권한이 있는 직원만 할 수 있습니다.</span>
          </div>
        )}
        {data && <span className="t-c1 c-alt">요청 가능 기간은 배송 완료 뒤 7일 안(불량 · 오배송은 기간과 상관없이 접수) · 개봉한 상품은 단순 변심으로 신청할 수 없음 · 처음 낸 배송비가 0원이면 반품 배송비를 왕복으로 뺍니다</span>}
        {data && <span className="t-c1 c-alt">승인 · 거절 · 상품 확인 · 환불 · 교환 발송은 로그 추적에 남음 · 진행 중인 신청이 있는 주문은 자동 구매 확정에서 제외</span>}
      </main>
      {openId && (
        <ReturnDetail
          id={openId}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onChanged={async (text) => {
            setToast(text);
            await load();
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

function ReturnDetail({ id, canEdit, onClose, onChanged }: { id: string; canEdit: boolean; onClose: () => void; onChanged: (text: string) => void | Promise<void> }) {
  const { confirm } = useConfirm();
  const [d, setD] = useState<Detail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<Fault | "">("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [confirmOpened, setConfirmOpened] = useState(false);
  const [courier, setCourier] = useState("CJ");
  const [tracking, setTracking] = useState("");
  const [pickup, setPickup] = useState<Pickup>("BUYER_SHIP");
  const [inspResult, setInspResult] = useState<Inspection>("OK");
  const [inspNote, setInspNote] = useState("");
  const [returning, setReturning] = useState(false);

  const load = useCallback(async () => {
    const r = await api<Detail>(`/api/seller/returns/${id}`);
    if (!r.ok) return setFailed(errorText(r, "신청을 불러오지 못했습니다"));
    setD(r.data);
    setFault(DEFAULT_FAULT[r.data.reason] ?? "");
    setPickup(r.data.pickupMethod);
    if (r.data.inspectionResult) setInspResult(r.data.inspectionResult);
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setFailed(null);
    const r = await api(`/api/seller/returns/${id}/${path}`, { method: "POST", body });
    setBusy(false);
    if (!r.ok) {
      if (r.error === "opened_items_present") setConfirmOpened(true);
      return setFailed(errorText(r, "처리하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    }
    setRejecting(false);
    setReturning(false);
    await onChanged(done);
    await load();
  };

  const ask = async (path: string, body: unknown, done: string, c: Parameters<typeof confirm>[0]) => {
    if (!(await confirm(c))) return;
    await act(path, body, done);
  };

  const preview = d?.fault && d.refundPreview ? d.refundPreview.byFault[d.fault] : null;

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="rt-detail-title">
      <div className="modal modal-lg rt-modal">
        <div className="modal-h">
          <h2 className="t-h2" id="rt-detail-title">
            {d ? `${KIND[d.kind]} 신청 · 주문 ${d.orderNo}` : "교환 · 반품"}
          </h2>
        </div>
        {failed && (
          <div className="msg msg-neg" role="alert">
            <span>{failed}</span>
          </div>
        )}
        {!d && !failed && <StateBox kind="loading" what="신청" />}
        {d && (
          <div className="col" style={{ gap: 16, padding: "0 20px 8px" }}>
            <div className="rt-kv t-l2">
              <span className="c-alt">상태</span>
              <span>
                <span className={`bdg ${STATUS[d.status].cls}`}>{STATUS[d.status].label}</span>
                {d.fault ? ` · ${d.fault === "BUYER" ? "구매자 사정" : "파트너스 사정"}` : ""}
              </span>
              <span className="c-alt">신청 구매자</span>
              <span>{d.nickname}</span>
              <span className="c-alt">신청 시각</span>
              <span className="num">{kstText(d.createdAt)}</span>
              <span className="c-alt">사유</span>
              <span>{REASON[d.reason]}</span>
              {d.reasonText && (
                <>
                  <span className="c-alt">상세 사유</span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{d.reasonText}</span>
                </>
              )}
              <span className="c-alt">대상 상품</span>
              <span className="col" style={{ gap: 2 }}>
                {d.items.map((i) => (
                  <span key={i.orderItemId}>
                    {i.productName} · {i.optionName} · {i.quantity}개{i.quantity < i.orderQuantity ? ` (주문 ${i.orderQuantity}개 중)` : ""}
                  </span>
                ))}
              </span>
              {d.returnTrackingNumber && (
                <>
                  <span className="c-alt">회수 송장</span>
                  <span className="num">
                    {d.returnCourierName} {d.returnTrackingNumber}
                  </span>
                </>
              )}
              {d.status !== "REQUESTED" && d.status !== "CANCELLED" && d.pickupMethod && (
                <>
                  <span className="c-alt">수거 방법</span>
                  <span>{PICKUP[d.pickupMethod]}</span>
                </>
              )}
              {d.inspectionResult && (
                <>
                  <span className="c-alt">상품 확인 결과</span>
                  <span data-testid="rt-inspection">
                    {INSPECTION[d.inspectionResult]}
                    {d.inspectionNote ? ` · ${d.inspectionNote}` : ""}
                  </span>
                </>
              )}
              {d.convertedFromExchange && (
                <>
                  <span className="c-alt">전환</span>
                  <span>교환 재고가 없어 환불로 전환</span>
                </>
              )}
              {d.rejectReason && (
                <>
                  <span className="c-alt">거절 사유</span>
                  <span>{d.rejectReason}</span>
                </>
              )}
              {d.exchangeTrackingNumber && (
                <>
                  <span className="c-alt">교환 송장</span>
                  <span className="num">
                    {d.exchangeCourierName} {d.exchangeTrackingNumber}
                  </span>
                </>
              )}
              {d.refundAmount !== null && (
                <>
                  <span className="c-alt">환불 금액</span>
                  <span className="num">{won(d.refundAmount)}</span>
                </>
              )}
              {d.status === "RECEIVED" || d.status === "COMPLETED" ? (
                <>
                  <span className="c-alt">재고</span>
                  <span>{d.restocked ? "회수 상품 재고 되돌림" : "되돌리지 않음"}</span>
                </>
              ) : null}
            </div>
            {d.refunds.length > 0 && (
              <div className="col" style={{ gap: 4 }} data-testid="rt-refund-history">
                <span className="t-l2 fw6">이 주문의 환불 내역</span>
                {d.refunds.map((f) => (
                  <span key={f.seq} className="t-c1 c-alt num">
                    {formatDateTime(f.createdAt)} · {f.items.map((i) => `${i.productName} ${i.quantity}개`).join(", ")} · 현금 {won(f.refundAmount)}
                    {f.returnFeeDeducted > 0 ? ` · 반품 배송비 ${won(f.returnFeeDeducted)} 차감` : ""}
                    {f.rewardReturn > 0 ? ` · 적립금 반환 ${won(f.rewardReturn)}` : ""}
                    {f.isFinal ? " · 마지막 환불" : ""}
                  </span>
                ))}
              </div>
            )}
            {d.partialQuantity && (
              <div className="msg msg-info" role="status">
                <span>일부 수량만 반품하는 품목은 재고를 자동으로 되돌리지 않습니다. 재고 관리에서 직접 맞춰 주십시오.</span>
              </div>
            )}
            {d.paymentMethod === "BANK_TRANSFER" && d.kind === "RETURN" && d.status !== "COMPLETED" && d.status !== "REJECTED" && d.status !== "CANCELLED" && (
              <div className="msg msg-info" role="status" data-testid="rt-account">
                <span>
                  무통장 입금 주문입니다 · 구매자가 입력한 환불 계좌로 보냅니다
                  {d.refundAccount ? ` · 예금주 ${d.refundAccount.accountHolder} · ${d.refundAccount.bankName} ${d.refundAccount.accountNumber ?? "(계좌번호를 불러오지 못했습니다. 구매자에게 다시 확인해 주십시오)"}` : " · 환불 계좌가 없습니다"} · 계좌 확인 뒤 「환불」
                </span>
              </div>
            )}
            {d.images.length > 0 && (
              <div className="rt-imgs" aria-label="신청 사진">
                {d.images.map((im) => (
                  <a key={im.id} href={`/api/seller/returns/images/${im.id}`} target="_blank" rel="noopener noreferrer">
                    <img src={`/api/seller/returns/images/${im.id}`} alt="신청 사진" />
                  </a>
                ))}
              </div>
            )}
            {canEdit && d.status === "REQUESTED" && (
              <div className="col" style={{ gap: 10 }}>
                <div className="fld">
                  <label htmlFor="rt-fault" className="req">
                    사유 주체
                  </label>
                  <select id="rt-fault" className="inp" value={fault} onChange={(e) => setFault(e.target.value as Fault | "")}>
                    <option value="">선택</option>
                    <option value="BUYER">구매자 사정 (반품 배송비 차감)</option>
                    <option value="SELLER">파트너스 사정 (불량 · 오배송)</option>
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="rt-pickup">수거 방법</label>
                  <select id="rt-pickup" className="inp" value={pickup} onChange={(e) => setPickup(e.target.value as Pickup)}>
                    {(Object.keys(PICKUP) as Pickup[]).map((k) => (
                      <option key={k} value={k}>
                        {PICKUP[k]}
                      </option>
                    ))}
                  </select>
                </div>
                {rejecting && (
                  <div className="fld">
                    <label htmlFor="rt-reject-preset">거절 사유 선택</label>
                    <select id="rt-reject-preset" className="inp" value={REJECT_PRESETS.includes(rejectReason) ? rejectReason : ""} onChange={(e) => setRejectReason(e.target.value)}>
                      <option value="">직접 입력</option>
                      {REJECT_PRESETS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <label htmlFor="rt-reject" className="req">
                      거절 사유
                    </label>
                    <textarea id="rt-reject" className="inp" style={{ height: 72, padding: "10px 12px" }} maxLength={200} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                    <span className="help">거절하면 구매자에게 사유와 함께 보입니다 · 200자</span>
                  </div>
                )}
              </div>
            )}
            {canEdit && d.status === "RECEIVED" && (
              <div className="col" style={{ gap: 10 }} data-testid="rt-inspect">
                <div className="fld">
                  <label htmlFor="rt-insp">상품 확인 결과 입력</label>
                  <select id="rt-insp" className="inp" value={inspResult} onChange={(e) => setInspResult(e.target.value as Inspection)}>
                    {(Object.keys(INSPECTION) as Inspection[]).map((k) => (
                      <option key={k} value={k}>
                        {INSPECTION[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="rt-insp-note">확인 메모</label>
                  <input id="rt-insp-note" className="inp" maxLength={200} value={inspNote} onChange={(e) => setInspNote(e.target.value)} placeholder="예: 봉인 훼손 확인" />
                </div>
                {inspResult === "OK" && !d.restocked && (
                  <label className="row t-l2" style={{ gap: 8 }}>
                    <input className="cbx" type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
                    회수한 상품 재고로 되돌리기
                  </label>
                )}
                {d.inspectionResult && d.inspectionResult !== "OK" && (
                  <div className="msg msg-neg" role="alert">
                    <span>상품 확인에서 문제가 확인되었습니다. 환불 · 교환은 진행할 수 없고 반송 · 거절로 처리해 주십시오. 사유는 구매자에게 전달됩니다.</span>
                  </div>
                )}
                {returning && (
                  <div className="fld">
                    <label htmlFor="rt-reject2" className="req">
                      반송 · 거절 사유
                    </label>
                    <textarea id="rt-reject2" className="inp" style={{ height: 72, padding: "10px 12px" }} maxLength={200} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                  </div>
                )}
              </div>
            )}
            {canEdit && d.status === "RECEIVED" && d.kind === "EXCHANGE" && d.inspectionResult === "OK" && (
              <div className="msg msg-info" role="status" data-testid="rt-stock-note">
                <span>
                  {d.exchangeHeldAt ? "재입고 뒤 발송으로 보류 중입니다. 재고가 들어오면 교환 발송을 눌러 주십시오." : "교환 상품 재고가 없으면 반품 환불로 전환하거나 재입고 뒤 발송을 선택해 주십시오."}
                </span>
              </div>
            )}
            {canEdit && d.status === "RECEIVED" && d.kind === "RETURN" && (
              <div className="col" style={{ gap: 6 }}>
                {preview ? (
                  <>
                    <span className="t-l1 fw6 num" data-testid="rt-cash">
                      현금 환불 {won(preview.refundAmount)}
                    </span>
                    <span className="t-c1 c-alt num" data-testid="rt-reward">
                      {preview.rewardReturn > 0 ? `적립금 반환 ${won(preview.rewardReturn)}` : "적립금 반환 0원"}
                    </span>
                    {preview.returnFeeDeducted > 0 && <span className="t-c1 c-alt num">반품 배송비 {won(preview.returnFeeDeducted)} 차감</span>}
                    {preview.rewardReturn > 0 && <span className="t-c1 c-alt">쓴 적립금은 구매자에게 적립금으로 돌려줍니다</span>}
                    {preview.blocked && <span className="err">이 사유 주체로는 환불할 수 없는 주문입니다</span>}
                  </>
                ) : (
                  <span className="col" style={{ gap: 6, alignItems: "flex-start" }}>
                    <span className="msg msg-neg" role="alert" style={{ display: "block" }}>
                      <b>환불 금액을 불러오지 못했습니다.</b> 잠시 뒤 다시 시도해 주십시오. 금액을 받기 전에는 환불을 진행할 수 없습니다.
                    </span>
                    <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void load()}>
                      다시 시도
                    </button>
                  </span>
                )}
                {confirmOpened && (
                  <label className="row t-l2" style={{ gap: 8 }}>
                    <input className="cbx" type="checkbox" checked readOnly />
                    개봉한 상품이 있는 주문임을 확인
                  </label>
                )}
              </div>
            )}
            {canEdit && d.status === "RECEIVED" && d.kind === "EXCHANGE" && (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <select className="inp" style={{ width: 150 }} aria-label="택배사" value={courier} onChange={(e) => setCourier(e.target.value)}>
                  {Object.entries(COURIERS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <input className="inp" style={{ flex: 1, minWidth: 160 }} aria-label="송장 번호" placeholder="교환 상품 송장 번호" maxLength={40} value={tracking} onChange={(e) => setTracking(e.target.value.replace(/[^0-9A-Za-z-]/g, ""))} />
              </div>
            )}
          </div>
        )}
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            닫기
          </button>
          {canEdit && d?.status === "REQUESTED" && (
            <>
              {rejecting ? (
                <button className="btn btn-out" type="button" disabled={busy || !rejectReason.trim()} onClick={() => void ask("reject", { reason: rejectReason }, "신청을 거절했습니다", { title: "신청을 거절하시겠습니까?", body: "거절 사유가 구매자에게 전달됩니다.", confirmLabel: "거절", danger: true })}>
                  거절 확정
                </button>
              ) : (
                <button className="btn btn-out" type="button" disabled={busy} onClick={() => setRejecting(true)}>
                  거절
                </button>
              )}
              <button className="btn" type="button" disabled={busy || !fault} onClick={() => void ask("accept", { fault, pickup }, "신청을 접수했습니다", { title: "신청을 접수하시겠습니까?", body: "접수하면 구매자에게 알림이 가고 수거가 시작됩니다.", confirmLabel: "신청 접수" })}>
                접수
              </button>
            </>
          )}
          {canEdit && d?.status === "ACCEPTED" && (
            <button className="btn" type="button" disabled={busy} onClick={() => void ask("receive", {}, "입고를 확인했습니다", { title: "상품이 도착했는지 확인하시겠습니까?", body: "반품 상품을 받은 것으로 바꾸고 상품 확인 단계로 넘어갑니다.", confirmLabel: "도착 확인" })}>
              입고 확인
            </button>
          )}
          {canEdit && d?.status === "RECEIVED" && (
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => void ask("inspect", { result: inspResult, note: inspNote, restock }, "상품 확인 결과를 저장했습니다", { title: "상품 확인 결과를 저장하시겠습니까?", body: "저장하면 환불 또는 반송 단계로 넘어갑니다.", confirmLabel: "결과 저장" })}>
              상품 확인 결과 저장
            </button>
          )}
          {canEdit && d?.status === "RECEIVED" && d.inspectionResult && d.inspectionResult !== "OK" &&
            (returning ? (
              <button className="btn" type="button" disabled={busy || !rejectReason.trim()} onClick={() => void ask("reject-inspected", { reason: rejectReason }, "반송 · 거절로 처리했습니다", { title: "반송 · 거절로 처리하시겠습니까?", body: "환불·교환은 진행되지 않고 구매자에게 알림이 갑니다.", confirmLabel: "반송 · 거절", danger: true })}>
                반송 · 거절 확정
              </button>
            ) : (
              <button className="btn" type="button" disabled={busy} onClick={() => setReturning(true)}>
                반송 · 거절
              </button>
            ))}
          {canEdit && d?.status === "RECEIVED" && d.kind === "EXCHANGE" && d.inspectionResult === "OK" && (
            <>
              {!d.exchangeHeldAt && (
                <button className="btn btn-out" type="button" disabled={busy} onClick={() => void ask("hold", {}, "재입고 뒤 발송으로 보류했습니다", { title: "재입고 뒤 발송으로 보류하시겠습니까?", body: "재고가 들어온 뒤 교환 상품을 보냅니다.", confirmLabel: "보류" })}>
                  재입고 뒤 발송
                </button>
              )}
              <button className="btn btn-out" type="button" disabled={busy} onClick={() => void ask("convert", {}, "환불로 전환했습니다", { title: "환불로 바꾸시겠습니까?", body: "교환 대신 반품 환불로 바꿉니다. 바꾼 뒤에는 교환 상품을 보낼 수 없습니다.", confirmLabel: "환불로 바꾸기", danger: true })}>
                환불로 전환
              </button>
            </>
          )}
          {canEdit && d?.status === "RECEIVED" && d.kind === "RETURN" && (
            <button
              className="btn"
              type="button"
              disabled={busy || !preview || preview.blocked || d.queueVersion === null || d.inspectionResult !== "OK"}
              onClick={() => void ask("refund", { expectedVersion: d.queueVersion, expectedRefundAmount: preview!.refundAmount, confirmOpened }, "환불을 처리했습니다", { title: `${won(preview!.refundAmount)}을 환불하시겠습니까?`, body: "환불하면 되돌릴 수 없습니다. 환불 금액을 다시 입력해 주십시오.", confirmLabel: "환불", danger: true, retype: { expected: String(preview!.refundAmount), label: "환불 금액" } })}
            >
              {busy ? "처리 중" : "환불"}
            </button>
          )}
          {canEdit && d?.status === "RECEIVED" && d.kind === "EXCHANGE" && (
            <button className="btn" type="button" disabled={busy || tracking.trim().length < 4 || d.inspectionResult !== "OK"} onClick={() => void ask("exchange", { courier, trackingNumber: tracking }, "교환 상품을 발송 처리했습니다", { title: "교환 상품 발송을 완료 처리하시겠습니까?", body: "입력한 택배사·송장 번호로 발송한 것으로 기록하고 구매자에게 알립니다.", confirmLabel: "발송 완료" })}>
              교환 발송
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
