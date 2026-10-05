import { Prisma, type ActorType, type PrismaClient, type RefundFault, type RefundRequestStatus, type ReturnReason } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { shopOpen } from "../buyers/signup";
import { getRefundVersion } from "../queue/read";
import { previewRefundSelection, refundOrder, type RefundSelection } from "../queue/service";
import { REASONS, REASON_LABEL, REASON_TEXT_MAX, REJECT_REASON_MAX } from "../shop-returns/rules";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";
import { parseRefundSelection } from "./refundSelection";
import { orderNoLabel } from "../orders/orderNoLabel";

// 구매자 환불 요청(SA-023 · SH-022 취소 요청, MASTER 배정 2026-10-05).
// - 구매자: 결제 완료·발송 전·구매 확정 전 주문에 사유와 함께 요청한다(품목·수량을 고르거나, 고르지 않으면 남은 품목 전부). 주문당 진행 중인 요청은 1건(DB 부분 유니크).
//   요청 단계에서 철회할 수 있다.
// - 파트너스(ORDER_SHIPPING): 승인 = 고른 품목으로 환불(queue/service.ts refundOrder, 확인받은 금액·버전으로만, 같은 트랜잭션에서 요청을 승인으로 닫음),
//   거절 = 사유 필수(구매자에게 보임). 주문 화면에서 남은 품목을 모두 환불해도 진행 중인 요청은 승인으로 닫힌다(refundRequestHooks.ts).
// - 잠금 순서: 주문 행(FOR UPDATE) → 회원 행(FOR SHARE) → 요청 행(FOR UPDATE). 모든 변경은 로그 추적(AuditLog)에 남는다.
type Tx = Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };
export type BuyerScope = { sellerId: string; buyerMemberId: string };
const PAGE = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export type RefundRequestFailure =
  | "shop_unavailable"
  | "not_found"
  | "not_refundable"
  | "active_exists"
  | "invalid_transition"
  | "invalid_reason"
  | "invalid_reason_text"
  | "invalid_items"
  | "invalid_reject_reason";

// 구매자 화면(해요체) / 파트너스 화면(합니다체) 안내
export const BUYER_REFUND_REQUEST_MESSAGES: Record<RefundRequestFailure, string> = {
  shop_unavailable: "지금은 요청할 수 없어요",
  not_found: "요청을 찾을 수 없어요",
  not_refundable: "지금은 환불을 요청할 수 없는 주문이에요. 보낸 뒤에는 교환·반품을 신청해 주세요",
  active_exists: "이미 진행 중인 환불 요청이 있어요",
  invalid_transition: "이미 처리된 요청이에요. 화면을 새로 고쳐 주세요",
  invalid_reason: "사유를 골라 주세요",
  invalid_reason_text: "자세한 사유를 입력해 주세요 (500자 이내)",
  invalid_items: "환불받을 상품과 수량을 다시 골라 주세요",
  invalid_reject_reason: "사유를 확인해 주세요",
};
export const SELLER_REFUND_REQUEST_MESSAGES: Record<RefundRequestFailure, string> = {
  shop_unavailable: "지금은 처리할 수 없습니다",
  not_found: "요청을 찾을 수 없습니다",
  not_refundable: "환불할 수 없는 주문입니다",
  active_exists: "이미 진행 중인 요청이 있습니다",
  invalid_transition: "이미 처리된 요청입니다. 화면을 새로 고쳐 주십시오",
  invalid_reason: "사유를 골라 주십시오",
  invalid_reason_text: "사유를 확인해 주십시오",
  invalid_items: "요청한 상품을 더 환불할 수 없습니다. 주문 화면에서 확인해 주십시오",
  invalid_reject_reason: "거절 사유를 입력해 주십시오 (200자 이내)",
};

export function refundRequestStatus(reason: string): number {
  if (reason === "not_found") return 404;
  if (reason === "shop_unavailable") return 402;
  if (reason.startsWith("invalid_") && reason !== "invalid_transition") return 400;
  return 409;
}

type NewRequest = { reason: ReturnReason; reasonText: string; items: RefundSelection | null };
export function parseNewRefundRequest(raw: Record<string, unknown>): { ok: true; v: NewRequest } | { ok: false; reason: RefundRequestFailure } {
  if (typeof raw.reason !== "string" || !(REASONS as readonly string[]).includes(raw.reason)) return { ok: false, reason: "invalid_reason" };
  const reason = raw.reason as ReturnReason;
  let reasonText = "";
  if (raw.reasonText !== undefined && raw.reasonText !== null && raw.reasonText !== "") {
    const t = cleanText(raw.reasonText, REASON_TEXT_MAX, "multiline");
    if (t === null) return { ok: false, reason: "invalid_reason_text" };
    reasonText = t;
  }
  if (reason === "OTHER" && reasonText === "") return { ok: false, reason: "invalid_reason_text" };
  const items = parseRefundSelection(raw.items);
  if (items === null) return { ok: false, reason: "invalid_items" };
  return { ok: true, v: { reason, reasonText, items: items ?? null } };
}

async function clockNow(db: PrismaClient | Tx): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return rows[0].now;
}

async function lockOrder(tx: Tx, sellerId: string, orderId: string) {
  const [o] = await tx.$queryRaw<{ status: string; buyerMemberId: string; purchaseConfirmedAt: Date | null; legalHoldAt: Date | null }[]>`
    SELECT "status"::text AS "status", "buyerMemberId", "purchaseConfirmedAt", "legalHoldAt" FROM "Order"
    WHERE "id" = ${orderId}::uuid AND "sellerId" = ${sellerId}::uuid FOR UPDATE`;
  return o ?? null;
}

const viewSelect = {
  id: true,
  orderId: true,
  status: true,
  reason: true,
  reasonText: true,
  items: true,
  rejectReason: true,
  refundId: true,
  decidedAt: true,
  cancelledAt: true,
  createdAt: true,
} satisfies Prisma.RefundRequestSelect;
type Row = Prisma.RefundRequestGetPayload<{ select: typeof viewSelect }>;
const view = (r: Row) => ({ ...r, items: (r.items as RefundSelection | null) ?? null, reasonLabel: REASON_LABEL[r.reason] });
export type RefundRequestView = ReturnType<typeof view>;

// 환불을 요청할 수 있는 주문인지: 결제 완료·발송 기록 없음·구매 확정 전(재고 부족 환불 대기 주문도 요청할 수 있다)
const refundable = (o: { status: string; purchaseConfirmedAt: Date | null }, shipped: boolean) => o.status === "PAID" && !shipped && !o.purchaseConfirmedAt;

// 고른 품목·수량을 주문의 남은 수량으로 확인한다(없으면 남은 품목 전부라 확인할 것 없음)
function itemsValid(items: RefundSelection | null, orderItems: { id: string; quantity: number; refundedQuantity: number }[]): boolean {
  if (!items) return orderItems.some((i) => i.refundedQuantity < i.quantity);
  const seen = new Set<string>();
  for (const s of items) {
    const i = orderItems.find((x) => x.id === s.orderItemId);
    if (!i || seen.has(s.orderItemId) || s.quantity > i.quantity - i.refundedQuantity) return false;
    seen.add(s.orderItemId);
  }
  return true;
}

// ───────────── 구매자 ─────────────

const buyerAudit = (tx: Tx, scope: BuyerScope, meta: AuditMeta, action: string, targetId: string, after: unknown) =>
  writeAudit(tx, { actorType: "BUYER", actorId: scope.buyerMemberId, sellerId: scope.sellerId, action, targetType: "RefundRequest", targetId, after, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });

// 요청 화면: 요청할 수 있는지(못 하면 이유), 고를 수 있는 품목(남은 수량), 지난·진행 중인 요청
export async function buyerRefundRequestContext(db: PrismaClient, scope: BuyerScope, orderId: string) {
  if (!isUuid(orderId)) return null;
  const order = await db.order.findFirst({
    where: { id: orderId, ...scope, legalHoldAt: null },
    select: {
      status: true,
      purchaseConfirmedAt: true,
      shipment: { select: { id: true } },
      items: { select: { id: true, productNameSnapshot: true, optionNameSnapshot: true, quantity: true, refundedQuantity: true }, orderBy: { id: "asc" } },
    },
  });
  if (!order) return null;
  const requests = await db.refundRequest.findMany({ where: { sellerId: scope.sellerId, orderId }, select: viewSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const active = requests.some((r) => r.status === "REQUESTED");
  const blocked = !(await shopOpen(db, scope.sellerId)) ? "shop_unavailable" : !refundable(order, order.shipment !== null) ? "not_refundable" : active ? "active_exists" : null;
  return {
    canRequest: blocked === null,
    blocked,
    items: order.items
      .filter((i) => i.refundedQuantity < i.quantity)
      .map((i) => ({ orderItemId: i.id, productName: i.productNameSnapshot, optionName: i.optionNameSnapshot, quantity: i.quantity - i.refundedQuantity })),
    requests: requests.map(view),
  };
}

export async function createRefundRequest(db: PrismaClient, scope: BuyerScope, orderId: string, body: Record<string, unknown>, meta: AuditMeta = {}) {
  if (!isUuid(orderId)) return { ok: false as const, reason: "not_found" as const };
  const parsed = parseNewRefundRequest(body);
  if (!parsed.ok) return parsed;
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  try {
    return await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, scope.sellerId, orderId);
      if (!order || order.buyerMemberId !== scope.buyerMemberId || order.legalHoldAt) return { ok: false as const, reason: "not_found" as const };
      const [member] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
      if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
      const shipped = (await tx.shipment.count({ where: { sellerId: scope.sellerId, orderId } })) > 0;
      if (!refundable(order, shipped)) return { ok: false as const, reason: "not_refundable" as const };
      if ((await tx.refundRequest.count({ where: { sellerId: scope.sellerId, orderId, status: "REQUESTED" } })) > 0) return { ok: false as const, reason: "active_exists" as const };
      const orderItems = await tx.orderItem.findMany({ where: { sellerId: scope.sellerId, orderId }, select: { id: true, quantity: true, refundedQuantity: true } });
      if (!itemsValid(parsed.v.items, orderItems)) return { ok: false as const, reason: "invalid_items" as const };
      const created = await tx.refundRequest.create({
        data: {
          sellerId: scope.sellerId,
          orderId,
          buyerMemberId: scope.buyerMemberId,
          reason: parsed.v.reason,
          reasonText: parsed.v.reasonText,
          items: parsed.v.items ?? Prisma.DbNull,
          createdAt: await clockNow(tx),
        },
        select: viewSelect,
      });
      await buyerAudit(tx, scope, meta, "buyer_refund_request.create", created.id, { orderId, reason: parsed.v.reason, items: parsed.v.items?.length ?? null });
      return { ok: true as const, request: view(created) };
    });
  } catch (e) {
    // 동시에 두 번 요청하면 부분 유니크 인덱스가 하나만 남긴다
    if (isUniqueViolation(e)) return { ok: false as const, reason: "active_exists" as const };
    throw e;
  }
}

// 철회: 요청 단계만, 본인 요청만
export async function cancelRefundRequest(db: PrismaClient, scope: BuyerScope, id: string, meta: AuditMeta = {}) {
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const pre = await tx.refundRequest.findFirst({ where: { id, ...scope }, select: { orderId: true } });
    if (!pre) return { ok: false as const, reason: "not_found" as const };
    await lockOrder(tx, scope.sellerId, pre.orderId);
    const [r] = await tx.$queryRaw<{ status: RefundRequestStatus }[]>`
      SELECT "status"::text AS "status" FROM "RefundRequest" WHERE "id" = ${id}::uuid AND "sellerId" = ${scope.sellerId}::uuid FOR UPDATE`;
    if (r?.status !== "REQUESTED") return { ok: false as const, reason: "invalid_transition" as const };
    const now = await clockNow(tx);
    const row = await tx.refundRequest.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: now }, select: viewSelect });
    await buyerAudit(tx, scope, meta, "buyer_refund_request.cancel", id, { status: "CANCELLED" });
    return { ok: true as const, request: view(row) };
  });
}

// ───────────── 파트너스 ─────────────

const STATUSES: readonly RefundRequestStatus[] = ["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"];

// 목록·상태별 건수. ?status, 커서(createdAt 내림, id 내림)
export async function listSellerRefundRequests(db: PrismaClient, ctx: TenantContext, q: { status?: unknown; cursor?: unknown } = {}) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const status = STATUSES.find((s) => s === q.status);
  let after: Prisma.RefundRequestWhereInput = {};
  if (isUuid(q.cursor)) {
    const c = await db.refundRequest.findFirst({ where: { id: q.cursor, sellerId: ctx.sellerId }, select: { id: true, createdAt: true } });
    if (c) after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
  }
  const rows = await db.refundRequest.findMany({
    where: { sellerId: ctx.sellerId, order: { legalHoldAt: null }, ...(status ? { status } : {}), ...after },
    select: { ...viewSelect, order: { select: { orderNo: true, createdAt: true, broadcastNicknameSnapshot: true, totalAmount: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE + 1,
  });
  const page = rows.slice(0, PAGE);
  const counts = await db.refundRequest.groupBy({ by: ["status"], where: { sellerId: ctx.sellerId, order: { legalHoldAt: null } }, _count: { _all: true } });
  return {
    requests: page.map(({ order, ...r }) => ({ ...view(r), orderNo: order.orderNo, orderNoLabel: orderNoLabel(order.createdAt, order.orderNo), nickname: order.broadcastNicknameSnapshot, totalAmount: order.totalAmount })),
    nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<RefundRequestStatus, number>>,
  };
}

// 상세: 요청 + 주문 요약 + (진행 중이면) 요청한 품목으로 계산한 환불 미리보기와 승인 때 보낼 버전
export async function getSellerRefundRequest(db: PrismaClient, ctx: TenantContext, id: string) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  if (!isUuid(id)) return null;
  const r = await db.refundRequest.findFirst({
    where: { id, sellerId: ctx.sellerId, order: { legalHoldAt: null } },
    select: { ...viewSelect, order: { select: { orderNo: true, createdAt: true, status: true, totalAmount: true, broadcastNicknameSnapshot: true } } },
  });
  if (!r) return null;
  const { order, ...rest } = r;
  const v = view(rest);
  let refundPreview = null;
  let previewError: string | null = null;
  if (v.status === "REQUESTED") {
    const p = await previewRefundSelection(db, ctx, v.orderId, v.items ?? undefined);
    if (p.ok) refundPreview = p.value;
    else previewError = p.reason;
  }
  return {
    ...v,
    orderNo: order.orderNo,
    orderNoLabel: orderNoLabel(order.createdAt, order.orderNo),
    nickname: order.broadcastNicknameSnapshot,
    order: { status: order.status, totalAmount: order.totalAmount },
    refundPreview,
    // 미리보기를 못 만든 이유(요청 뒤 주문 화면에서 환불했거나 품목이 개봉 대기에 들어간 경우 등). 승인하면 같은 이유로 거절된다
    previewError,
    queueVersion: v.status === "REQUESTED" ? await getRefundVersion(db, ctx) : null,
  };
}

// 거절: 요청 단계만. 사유 필수(1~200자, 구매자에게 보인다)
export async function rejectRefundRequest(db: PrismaClient, ctx: TenantContext, id: string, body: { reason?: unknown }) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  const reason = cleanText(body.reason, REJECT_REASON_MAX, "memo");
  if (!reason) return { ok: false as const, reason: "invalid_reject_reason" as const };
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const pre = await tx.refundRequest.findFirst({ where: { id, sellerId: ctx.sellerId }, select: { orderId: true } });
    if (!pre) return { ok: false as const, reason: "not_found" as const };
    await lockOrder(tx, ctx.sellerId, pre.orderId);
    const [r] = await tx.$queryRaw<{ status: RefundRequestStatus }[]>`
      SELECT "status"::text AS "status" FROM "RefundRequest" WHERE "id" = ${id}::uuid AND "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    if (r?.status !== "REQUESTED") return { ok: false as const, reason: "invalid_transition" as const };
    const row = await tx.refundRequest.update({ where: { id }, data: { status: "REJECTED", rejectReason: reason, decidedAt: await clockNow(tx) }, select: viewSelect });
    await writeAudit(tx, {
      actorType: ctx.actorType as ActorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "refund_request.reject",
      targetType: "RefundRequest",
      targetId: id,
      reason,
      before: { status: "REQUESTED" },
      after: { status: "REJECTED" },
    });
    return { ok: true as const, request: view(row) };
  });
}

// 승인: 요청한 품목(없으면 남은 품목 전부)으로 환불한다. 화면이 본 버전(expectedVersion)과 확인받은 금액(expectedRefundAmount)으로만 실행하고,
// 환불과 같은 트랜잭션에서 요청을 승인으로 닫는다. 환불 거부 사유(fault_required·opened_items_present·refund_amount_changed 등)는 그대로 돌려준다.
export async function approveRefundRequest(
  db: PrismaClient,
  ctx: TenantContext,
  id: string,
  body: { expectedVersion: number; expectedRefundAmount: number; fault?: RefundFault; confirmOpened?: boolean },
) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  const r = await db.refundRequest.findFirst({ where: { id, sellerId: ctx.sellerId }, select: { orderId: true, status: true, reason: true, items: true } });
  if (!r) return { ok: false as const, reason: "not_found" as const };
  if (r.status !== "REQUESTED") return { ok: false as const, reason: "invalid_transition" as const };
  const out = await refundOrder(db, ctx, r.orderId, {
    reason: `구매자 환불 요청: ${REASON_LABEL[r.reason]}`,
    expectedLiveVersion: body.expectedVersion,
    confirmOpened: body.confirmOpened === true,
    fault: body.fault,
    expectedRefundAmount: body.expectedRefundAmount,
    items: (r.items as RefundSelection | null) ?? undefined,
    refundRequestId: id,
  });
  if (!out.ok) return { ok: false as const, reason: out.reason, refund: true as const };
  const row = await db.refundRequest.findUniqueOrThrow({ where: { id }, select: viewSelect });
  return { ok: true as const, request: view(row), refund: out.value, version: out.version };
}

// API 공통 응답: 거부 사유를 상태 코드와 화면 문구(구매자 해요체 / 파트너스 합니다체)로
export function refundRequestError(reason: RefundRequestFailure, who: "buyer" | "seller") {
  const messages = who === "buyer" ? BUYER_REFUND_REQUEST_MESSAGES : SELLER_REFUND_REQUEST_MESSAGES;
  return { body: { error: reason, message: messages[reason] }, status: refundRequestStatus(reason) };
}
