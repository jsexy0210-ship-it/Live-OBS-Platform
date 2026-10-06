import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { listSellerInvoices } from "./billingInvoices";

// 마스터 관리자 파트너스 상세 「구독」 탭(MA-012-3) 서버: 상태 이력과 청구·결제 내역 표. 조회만, 모든 마스터 역할(platform.read).
// 요금제 카드 값(요금제·상태·월 요금·다음 결제·결제 수단 등)은 GET /api/admin/sellers/{sellerId}의 subscription 블록을 쓴다(중복 없음).
// 경로의 sellerId 한 곳만 읽는다(다른 파트너스 행은 읽지 않음). 카드 번호·결제 키는 없다(카드 라벨만 청구 항목에 이미 있음).
export const SELLER_SUBSCRIPTION_PAGE_DEFAULT = 20;
export const SELLER_SUBSCRIPTION_PAGE_MAX = 100;
export const HISTORY_MAX = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

export type HistoryKind =
  | "TRIAL_STARTED"
  | "FIRST_PAID"
  | "PAYMENT_FAILED"
  | "REFUNDED"
  | "CARD_REGISTERED"
  | "CARD_REJECTED"
  | "CANCEL_SCHEDULED"
  | "CANCELED"
  | "RESTORED"
  | "SUSPENDED"
  | "UNSUSPENDED";
export type HistoryItem = { at: Date; kind: HistoryKind; text: string };

const AUDIT_ACTIONS = [
  "subscription.card_registered",
  "subscription.card_rejected",
  "subscription.cancel",
  "subscription.canceled",
  "subscription.auto_closed",
  "subscription.restored",
  "admin.seller.suspend",
  "admin.seller.unsuspend",
] as const;

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const kstDay = (d: Date) => {
  const k = new Date(d.getTime() + KST_MS);
  return `${k.getUTCFullYear()}.${String(k.getUTCMonth() + 1).padStart(2, "0")}.${String(k.getUTCDate()).padStart(2, "0")}`;
};

export async function getAdminSellerSubscription(db: PrismaClient, admin: AdminSessionContext, sellerId: string, query: { cursor?: string | null; limit?: string | null }) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  if (!UUID.test(sellerId)) return { ok: false as const, reason: "not_found" as const };
  const limit = query.limit == null || query.limit === "" ? SELLER_SUBSCRIPTION_PAGE_DEFAULT : Number(query.limit);
  const offset = query.cursor == null || query.cursor === "" ? 0 : /^\d{1,6}$/.test(query.cursor) ? Number(query.cursor) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > SELLER_SUBSCRIPTION_PAGE_MAX || !Number.isInteger(offset)) return { ok: false as const, reason: "bad_request" as const };
  const seller = await db.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, approvedAt: true, trialEndsAt: true, plan: { select: { name: true } }, subscription: { select: { plan: { select: { name: true } } } } },
  });
  if (!seller) return { ok: false as const, reason: "not_found" as const };
  const now = await dbNow(db);

  const [invoices, payments, refunds, audits] = await Promise.all([
    listSellerInvoices(db, sellerId, { offset, limit, now }),
    db.subscriptionPayment.findMany({
      where: { sellerId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1000,
      select: { id: true, status: true, amount: true, paidAt: true, createdAt: true, scheduled: true, kind: true, failureReason: true },
    }),
    db.subscriptionRefund.findMany({ where: { sellerId, status: "REFUNDED" }, orderBy: { refundedAt: "desc" }, take: 100, select: { id: true, amount: true, refundedAt: true } }),
    db.auditLog.findMany({
      where: { sellerId, action: { in: [...AUDIT_ACTIONS] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
      select: { id: true, action: true, createdAt: true, after: true },
    }),
  ]);
  const planName = seller.subscription?.plan.name ?? seller.plan?.name ?? null;

  const history: HistoryItem[] = [];
  const trialDays = seller.approvedAt && seller.trialEndsAt ? Math.max(1, Math.round((seller.trialEndsAt.getTime() - seller.approvedAt.getTime()) / DAY_MS)) : null;
  if (seller.approvedAt && trialDays) history.push({ at: seller.approvedAt, kind: "TRIAL_STARTED", text: `체험 시작 (${trialDays}일${planName ? ` · ${planName}` : ""})` });
  const firstPaid = payments.find((p) => p.status === "PAID" && p.paidAt);
  if (firstPaid?.paidAt) {
    history.push({
      at: firstPaid.paidAt,
      kind: "FIRST_PAID",
      text: trialDays ? `체험 → 이용 중 (첫 결제 성공${planName ? ` · ${planName}으로 시작` : ""})` : `이용 시작 (첫 결제 성공${planName ? ` · ${planName}` : ""})`,
    });
  }
  // 자동결제 실패(구독을 해지해 닫힌 청구는 실패로 세지 않는다)
  for (const p of payments) {
    if (p.status === "FAILED" && p.scheduled && p.kind === "PERIOD" && p.failureReason !== "canceled") history.push({ at: p.createdAt, kind: "PAYMENT_FAILED", text: `자동결제 실패 (${won(p.amount)})` });
  }
  for (const r of refunds) if (r.refundedAt) history.push({ at: r.refundedAt, kind: "REFUNDED", text: `환불 완료 (${won(r.amount)})` });
  for (const a of audits) {
    const after = (a.after ?? {}) as { endsAt?: string | null; immediate?: boolean };
    if (a.action === "subscription.card_registered") history.push({ at: a.createdAt, kind: "CARD_REGISTERED", text: "결제 카드 등록" });
    else if (a.action === "subscription.card_rejected") history.push({ at: a.createdAt, kind: "CARD_REJECTED", text: "결제 카드 등록 거절" });
    else if (a.action === "subscription.cancel") {
      const ends = after.endsAt ? new Date(after.endsAt) : null;
      history.push(after.immediate || !ends || Number.isNaN(ends.getTime()) ? { at: a.createdAt, kind: "CANCELED", text: "구독 해지" } : { at: a.createdAt, kind: "CANCEL_SCHEDULED", text: `해지 예약 (${kstDay(ends)} 종료)` });
    } else if (a.action === "subscription.canceled") history.push({ at: a.createdAt, kind: "CANCELED", text: "구독 해지 (이용 기간 종료)" });
    else if (a.action === "subscription.auto_closed") history.push({ at: a.createdAt, kind: "CANCELED", text: "자동 해지 (결제 잠금 기간 초과)" });
    else if (a.action === "subscription.restored") history.push({ at: a.createdAt, kind: "RESTORED", text: "구독 다시 시작" });
    else if (a.action === "admin.seller.suspend") history.push({ at: a.createdAt, kind: "SUSPENDED", text: "이용 정지" });
    else if (a.action === "admin.seller.unsuspend") history.push({ at: a.createdAt, kind: "UNSUSPENDED", text: "이용 정지 해제" });
  }
  history.sort((x, y) => y.at.getTime() - x.at.getTime());

  const items: (typeof invoices.items[number] | { kind: "TRIAL"; id: string; state: "TRIAL"; at: Date; amount: 0; planName: string | null; periodStart: Date; periodEnd: Date })[] = [...invoices.items];
  const last = offset + invoices.items.length >= invoices.total;
  // 체험은 청구가 아니지만 표에는 0원 항목으로 보인다: 마지막 쪽 끝에 붙인다(total·nextCursor에는 넣지 않음)
  if (last && seller.approvedAt && seller.trialEndsAt) {
    items.push({ kind: "TRIAL", id: `trial:${seller.id}`, state: "TRIAL", at: seller.approvedAt, amount: 0, planName, periodStart: seller.approvedAt, periodEnd: seller.trialEndsAt });
  }
  return {
    ok: true as const,
    value: {
      history: history.slice(0, HISTORY_MAX),
      trial: seller.approvedAt && seller.trialEndsAt && trialDays ? { startedAt: seller.approvedAt, endsAt: seller.trialEndsAt, days: trialDays } : null,
      invoices: { items, total: invoices.total, nextCursor: offset + invoices.items.length < invoices.total ? String(offset + invoices.items.length) : null },
      totals: invoices.totals,
    },
  };
}
