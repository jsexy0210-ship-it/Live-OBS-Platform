import type { ReturnInspection, ReturnKind, ReturnPickup, ReturnReason, ReturnStatus } from "@prisma/client";
import { cleanText } from "../text/clean";
import { COURIERS, isCourier } from "../orders/shipping";

// 교환·반품 규칙(순수 함수, SA-029 · SH-022-R). 서비스(service.ts)가 DB 쓰기 전에 입력을 검사하는 데 쓴다.
export const REASON_TEXT_MAX = 500;
export const REJECT_REASON_MAX = 200;
export const RETURN_IMAGES_MAX = 5;
export const TRACKING_MAX = 40;

export const KINDS: readonly ReturnKind[] = ["RETURN", "EXCHANGE"];
export const REASONS: readonly ReturnReason[] = ["CHANGE_OF_MIND", "DEFECTIVE", "WRONG_ITEM", "NOT_AS_DESCRIBED", "OTHER"];
export const ACTIVE_STATUSES: readonly ReturnStatus[] = ["REQUESTED", "ACCEPTED", "RECEIVED"];

// 구매자 화면 사유 이름
export const REASON_LABEL: Record<ReturnReason, string> = {
  CHANGE_OF_MIND: "단순 변심",
  DEFECTIVE: "상품 불량·파손",
  WRONG_ITEM: "다른 상품이 왔어요",
  NOT_AS_DESCRIBED: "상품 설명과 달라요",
  OTHER: "기타",
};
// 사유로 정하는 기본 사유 주체: 단순 변심은 구매자 사정, 그 밖에는 판매자 사정(접수할 때 판매자가 바꿀 수 있다)
export const DEFAULT_FAULT: Record<ReturnReason, "BUYER" | "SELLER" | null> = {
  CHANGE_OF_MIND: "BUYER",
  DEFECTIVE: "SELLER",
  WRONG_ITEM: "SELLER",
  NOT_AS_DESCRIBED: "SELLER",
  OTHER: null,
};

// 신청 기한: 배송 완료 뒤 7일(전자상거래법). 판매자 사정 사유(불량·오배송·설명과 다름)는 기한과 상관없이 받는다.
export const RETURN_WINDOW_DAYS = 7;
export const SELLER_FAULT_REASONS: readonly ReturnReason[] = ["DEFECTIVE", "WRONG_ITEM", "NOT_AS_DESCRIBED"];
export function withinReturnWindow(deliveredAt: Date | null, now: Date, reason: ReturnReason): boolean {
  if (SELLER_FAULT_REASONS.includes(reason)) return true;
  if (!deliveredAt) return true;
  return now.getTime() - deliveredAt.getTime() <= RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
export const returnDeadline = (deliveredAt: Date | null): Date | null => (deliveredAt ? new Date(deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000) : null);

export const PICKUPS: readonly ReturnPickup[] = ["COURIER", "BUYER_SHIP", "NONE"];
export const INSPECTIONS: readonly ReturnInspection[] = ["OK", "USED_DAMAGED", "MISSING_PARTS"];
export const INSPECTION_NOTE_MAX = 200;
export const parsePickup = (v: unknown): ReturnPickup | null => (typeof v === "string" && (PICKUPS as readonly string[]).includes(v) ? (v as ReturnPickup) : null);
export const parseInspection = (v: unknown): ReturnInspection | null => (typeof v === "string" && (INSPECTIONS as readonly string[]).includes(v) ? (v as ReturnInspection) : null);

// 무통장 입금 주문의 환불 계좌(구매자 입력). 환불·종료 뒤 서버가 비운다.
// 환불 계좌는 환불·종료 뒤 비운다(필요한 동안만 보관)
export const CLEAR_ACCOUNT = { refundBankName: null, refundAccountHolder: null, refundAccountNumber: null } as const;
export type RefundAccount = { bankName: string; accountHolder: string; accountNumber: string };
export function parseRefundAccount(raw: unknown): RefundAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const bankName = cleanText(o.bankName, 20, "memo");
  const accountHolder = cleanText(o.accountHolder, 20, "memo");
  const accountNumber = typeof o.accountNumber === "string" ? o.accountNumber.trim() : "";
  if (!bankName || !accountHolder || !/^[0-9-]{6,20}$/.test(accountNumber) || !/[0-9]{6}/.test(accountNumber.replace(/-/g, ""))) return null;
  return { bankName, accountHolder, accountNumber };
}

export type ReturnRejection =
  | "invalid_kind"
  | "invalid_reason"
  | "invalid_reason_text"
  | "invalid_items"
  | "invalid_images"
  | "invalid_courier"
  | "invalid_tracking"
  | "invalid_fault"
  | "invalid_reject_reason"
  | "invalid_pickup"
  | "invalid_inspection"
  | "invalid_refund_account";

export const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export type NewReturnInput = { kind: ReturnKind; reason: ReturnReason; reasonText: string; orderItemIds: string[] | null; imageIds: string[]; pickup: ReturnPickup; refundAccount: RefundAccount | null };

// 구매자 신청 입력. 반품은 주문 전체라 품목을 받지 않고(null), 교환은 품목을 1개 이상 고른다. 사유가 「기타」면 설명이 꼭 있어야 한다.
export function parseNewReturn(raw: Record<string, unknown>): { ok: true; v: NewReturnInput } | { ok: false; reason: ReturnRejection } {
  if (typeof raw.kind !== "string" || !(KINDS as readonly string[]).includes(raw.kind)) return { ok: false, reason: "invalid_kind" };
  if (typeof raw.reason !== "string" || !(REASONS as readonly string[]).includes(raw.reason)) return { ok: false, reason: "invalid_reason" };
  const kind = raw.kind as ReturnKind;
  const reason = raw.reason as ReturnReason;
  let reasonText = "";
  if (raw.reasonText !== undefined && raw.reasonText !== null && raw.reasonText !== "") {
    const t = cleanText(raw.reasonText, REASON_TEXT_MAX, "multiline");
    if (t === null) return { ok: false, reason: "invalid_reason_text" };
    reasonText = t;
  }
  if (reason === "OTHER" && reasonText === "") return { ok: false, reason: "invalid_reason_text" };
  let orderItemIds: string[] | null = null;
  if (kind === "EXCHANGE") {
    const ids = raw.orderItemIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every(isUuid) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid_items" };
    orderItemIds = ids as string[];
  }
  const imgs = raw.imageIds ?? [];
  if (!Array.isArray(imgs) || imgs.length > RETURN_IMAGES_MAX || !imgs.every(isUuid) || new Set(imgs).size !== imgs.length) return { ok: false, reason: "invalid_images" };
  // 수거 희망(택배사 수거 / 직접 발송, 기본 직접 발송). 「수거 없음」은 판매자만 정한다.
  let pickup: ReturnPickup = "BUYER_SHIP";
  if (raw.pickup !== undefined && raw.pickup !== null && raw.pickup !== "") {
    if (raw.pickup !== "COURIER" && raw.pickup !== "BUYER_SHIP") return { ok: false, reason: "invalid_pickup" };
    pickup = raw.pickup;
  }
  let refundAccount: RefundAccount | null = null;
  if (raw.refundAccount !== undefined && raw.refundAccount !== null) {
    refundAccount = parseRefundAccount(raw.refundAccount);
    if (!refundAccount) return { ok: false, reason: "invalid_refund_account" };
  }
  return { ok: true, v: { kind, reason, reasonText, orderItemIds, imageIds: imgs as string[], pickup, refundAccount } };
}

// 송장(택배사 코드 + 번호). 번호는 숫자·영문·하이픈만.
export function parseTracking(raw: Record<string, unknown>): { ok: true; courier: string; trackingNumber: string } | { ok: false; reason: "invalid_courier" | "invalid_tracking" } {
  if (!isCourier(raw.courier)) return { ok: false, reason: "invalid_courier" };
  const n = typeof raw.trackingNumber === "string" ? raw.trackingNumber.trim() : "";
  if (!/^[0-9A-Za-z-]{4,40}$/.test(n)) return { ok: false, reason: "invalid_tracking" };
  return { ok: true, courier: raw.courier, trackingNumber: n };
}
export const courierName = (code: string | null) => (code && isCourier(code) ? COURIERS[code] : code);

export function parseFault(v: unknown): "BUYER" | "SELLER" | null {
  return v === "BUYER" || v === "SELLER" ? v : null;
}

export function parseRejectReason(v: unknown): string | null {
  return cleanText(v, REJECT_REASON_MAX, "memo");
}

// 반품·교환이 가능한 단계(상태 전이표). 서비스는 잠근 행에서 이 표로 한 번 더 확인한다.
export const TRANSITIONS: Record<string, readonly ReturnStatus[]> = {
  accept: ["REQUESTED"],
  reject: ["REQUESTED"],
  cancel: ["REQUESTED", "ACCEPTED"],
  shipBack: ["ACCEPTED"],
  receive: ["ACCEPTED"],
  complete: ["RECEIVED"],
  // v2: 검수 결과 입력, 교환 재고 없음 처리(재입고 뒤 발송 보류·환불 전환), 검수에서 걸린 건 반송·거절
  inspect: ["RECEIVED"],
  hold: ["RECEIVED"],
  convert: ["RECEIVED"],
  rejectInspected: ["RECEIVED"],
};
