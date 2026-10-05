"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { COURIERS } from "../../../../../lib/server/orders/shipping";
import { StateBox, errorText, kstText, stateKind } from "../banners/_shared/ui";
import "./returns.css";
import { Modal } from "../../../../../components/admin-ui";

// SA-029 교환 · 반품(파트너스 관리자, 주문 › 교환 · 반품). 신청 목록·상태별 건수, 상세(사유·사진·품목), 접수 · 거절 · 회수 완료 · 반품 환불 · 교환 발송.
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
  items: { orderItemId: string; productName: string; optionName: string; quantity: number }[];
  createdAt: string;
};
type Data = { returns: Row[]; nextCursor: string | null; counts: Partial<Record<Status, number>> };
type Detail = Row & {
  fault: Fault | null;
  rejectReason: string | null;
  returnCourierName: string | null;
  returnTrackingNumber: string | null;
  exchangeCourierName: string | null;
  exchangeTrackingNumber: string | null;
  restocked: boolean;
  refundAmount: number | null;
  images: { id: string; width: number; height: number }[];
  order: { status: string; totalAmount: number; shippingFee: number };
  refundPreview: { byFault: Record<Fault, { refundAmount: number; returnFeeDeducted: number; rewardReturn: number; blocked: boolean }> } | null;
  queueVersion: number | null;
};

const REASON: Record<Reason, string> = { CHANGE_OF_MIND: "단순 변심", DEFECTIVE: "상품 불량 · 파손", WRONG_ITEM: "다른 상품 수령", NOT_AS_DESCRIBED: "상품 설명과 다름", OTHER: "기타" };
const DEFAULT_FAULT: Record<Reason, Fault | null> = { CHANGE_OF_MIND: "BUYER", DEFECTIVE: "SELLER", WRONG_ITEM: "SELLER", NOT_AS_DESCRIBED: "SELLER", OTHER: null };
const STATUS: Record<Status, { label: string; cls: string }> = {
  REQUESTED: { label: "접수 대기", cls: "b-pending" },
  ACCEPTED: { label: "회수 중", cls: "b-info" },
  RECEIVED: { label: "회수 완료", cls: "b-info" },
  COMPLETED: { label: "완료", cls: "b-done" },
  REJECTED: { label: "거절", cls: "b-gray nodot" },
  CANCELLED: { label: "철회", cls: "b-gray nodot" },
};
const KIND: Record<Kind, string> = { RETURN: "반품", EXCHANGE: "교환" };
type Tab = "all" | "REQUESTED" | "progress" | "COMPLETED" | "closed";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "REQUESTED", label: "접수 대기" },
  { key: "progress", label: "처리 중" },
  { key: "COMPLETED", label: "완료" },
  { key: "closed", label: "거절 · 철회" },
];
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const inTab = (tab: Tab, s: Status) => tab === "all" || (tab === "progress" ? s === "ACCEPTED" || s === "RECEIVED" : tab === "closed" ? s === "REJECTED" || s === "CANCELLED" : s === tab);

export default function ReturnsPage() {
  const { can } = useSeller();
  const canEdit = can("ORDER_SHIPPING");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("all");
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
            <span className="t-l2 c-alt">구매자 교환 · 반품 신청 확인 · 접수 · 회수 · 환불 · 교환 발송</span>
          </div>
        </div>
        <section className="card" style={{ overflow: "hidden" }}>
          {state.kind === "loading" && <StateBox kind="loading" what="교환 · 반품" />}
          {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="교환 · 반품" onRetry={() => void load()} />}
          {data && (
            <>
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
                  <span className="t">{tab === "all" ? "교환 · 반품 신청이 없습니다" : "해당하는 신청이 없습니다"}</span>
                  <span className="s">배송 완료 뒤 구매 확정 전의 주문에서 구매자가 신청할 수 있습니다</span>
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
                      <span className="t-c1 c-alt rt-hide-m num">{kstText(r.createdAt).slice(5, 10)}</span>
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
        {data && <span className="t-c1 c-alt">접수 · 거절 · 회수 · 환불 · 교환 발송은 모두 로그 추적에 남음 · 진행 중인 신청이 있는 주문은 자동 구매 확정에서 제외</span>}
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

  const load = useCallback(async () => {
    const r = await api<Detail>(`/api/seller/returns/${id}`);
    if (!r.ok) return setFailed(errorText(r, "신청을 불러오지 못했습니다"));
    setD(r.data);
    setFault(DEFAULT_FAULT[r.data.reason] ?? "");
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
    await onChanged(done);
    await load();
  };

  const preview = d?.fault && d.refundPreview ? d.refundPreview.byFault[d.fault] : null;

  return (
    <Modal labelId="rt-detail-title" className="modal-lg rt-modal" busy={busy} onClose={onClose}>
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
              {d.fault ? ` · ${d.fault === "BUYER" ? "구매자 사정" : "판매자 사정"}` : ""}
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
                  {i.productName} · {i.optionName} · {i.quantity}개
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
                  <option value="SELLER">판매자 사정 (불량 · 오배송)</option>
                </select>
              </div>
              {rejecting && (
                <div className="fld">
                  <label htmlFor="rt-reject" className="req">
                    거절 사유
                  </label>
                  <textarea id="rt-reject" className="inp" style={{ height: 72, padding: "10px 12px" }} maxLength={200} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                  <span className="help">구매자에게 보입니다 · 200자</span>
                </div>
              )}
            </div>
          )}
          {canEdit && d.status === "ACCEPTED" && (
            <label className="row t-l2" style={{ gap: 8 }}>
              <input className="cbx" type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
              회수한 상품 재고로 되돌리기
            </label>
          )}
          {canEdit && d.status === "RECEIVED" && d.kind === "RETURN" && (
            <div className="col" style={{ gap: 6 }}>
              {preview ? (
                <>
                  <span className="t-l1 fw6 num" data-testid="rt-cash">
                    현금 환불 {won(preview.refundAmount)}
                  </span>
                  <span className="t-c1 c-alt num" data-testid="rt-reward">
                    {preview.rewardReturn > 0 ? `적립금 반환 ${won(preview.rewardReturn)}` : "적립금 반환 0원 (사용한 적립금 없음)"}
                  </span>
                  {preview.returnFeeDeducted > 0 && <span className="t-c1 c-alt num">반품 배송비 {won(preview.returnFeeDeducted)} 차감</span>}
                  <span className="t-c1 c-alt">현금 환불 = 돌아오는 상품 금액 − 반품 배송비 − 적립금 반환</span>
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
              <button className="btn btn-out" type="button" disabled={busy || !rejectReason.trim()} onClick={() => void act("reject", { reason: rejectReason }, "신청을 거절했습니다")}>
                거절 확정
              </button>
            ) : (
              <button className="btn btn-out" type="button" disabled={busy} onClick={() => setRejecting(true)}>
                거절
              </button>
            )}
            <button className="btn" type="button" disabled={busy || !fault} onClick={() => void act("accept", { fault }, "신청을 접수했습니다")}>
              접수
            </button>
          </>
        )}
        {canEdit && d?.status === "ACCEPTED" && (
          <button className="btn" type="button" disabled={busy} onClick={() => void act("receive", { restock }, "회수 완료로 처리했습니다")}>
            회수 완료
          </button>
        )}
        {canEdit && d?.status === "RECEIVED" && d.kind === "RETURN" && (
          <button
            className="btn"
            type="button"
            disabled={busy || !preview || preview.blocked || d.queueVersion === null}
            onClick={() => void act("refund", { expectedVersion: d.queueVersion, expectedRefundAmount: preview!.refundAmount, confirmOpened }, "환불을 처리했습니다")}
          >
            {busy ? "처리 중" : "환불"}
          </button>
        )}
        {canEdit && d?.status === "RECEIVED" && d.kind === "EXCHANGE" && (
          <button className="btn" type="button" disabled={busy || tracking.trim().length < 4} onClick={() => void act("exchange", { courier, trackingNumber: tracking }, "교환 상품을 발송 처리했습니다")}>
            교환 발송
          </button>
        )}
      </div>
    </Modal>
  );
}
