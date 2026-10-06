import { Prisma, type ActorType, type PrismaClient, type ReceiptIssueStatus, type ReceiptKind } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { sealBillingKey } from "../billing/secret";
import { orderServiceOpen } from "../buyers/signup";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";
import { dbNow } from "../billing/subscription";
import { kstDayStart } from "../orders/read";
import { orderNoLabel } from "../orders/orderNoLabel";

// 현금영수증·세금계산서 신청과 발행 상태(SA-024 · SH-005·SH-022, MASTER 배정 2026-10-05).
// - 구매자: 무통장·계좌이체 주문(입금 전·결제 완료)에 신청한다. 카드 결제는 카드 매출전표로 대신해 신청할 수 없다. 주문당 진행 중인 신청은 1건(DB 부분 유니크).
//   발행 전(대기·보류·실패)에는 철회할 수 있다.
// - 신청하면 발행 이력(ReceiptIssue)이 대기(PENDING)로 생긴다. 외부 발급 연동(발행 업체)은 결정 전이라 아직 없고, 연동이 붙기 전까지 대기로 남는다.
// - 휴대폰·사업자등록번호는 원문으로 저장하지 않고 봉인(AES-256-GCM, 판매자 id를 AAD로 묶음)해 두며 화면에는 뒤 4자리만 보인다.
// - 파트너스(RECEIPT_TAX): 목록·상태 조회, 실패·보류한 발행을 다시 시도(→ 대기). 보류(ON_HOLD)는 충전금 잔액이 모자라 발급을 미룬 상태이고 chargeable은 건당비를 충전금에서 차감하는 발급이라는 표시다(차감·보류 전환은 발행 업체 결정 뒤). 변경은 로그 추적(AuditLog)에 남는다.
// - 환불 때 발행 취소 연동은 후속(발행 업체 결정 뒤).
type Tx = Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };
export type BuyerScope = { sellerId: string; buyerMemberId: string };
const PAGE = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export const RECEIPT_KINDS: readonly ReceiptKind[] = ["CASH_RECEIPT_INCOME", "CASH_RECEIPT_EXPENSE", "TAX_INVOICE"];
const STATUSES: readonly ReceiptIssueStatus[] = ["PENDING", "ON_HOLD", "ISSUED", "FAILED", "CANCELLED"];

export type ReceiptFailure =
  | "shop_unavailable"
  | "not_found"
  | "not_requestable"
  | "active_exists"
  | "invalid_transition"
  | "not_paid"
  | "auto_unavailable"
  | "invalid_kind"
  | "invalid_identity"
  | "invalid_tax_info";

// 구매자 화면(해요체) / 파트너스 화면(합니다체) 안내
export const BUYER_RECEIPT_MESSAGES: Record<ReceiptFailure, string> = {
  shop_unavailable: "지금은 신청할 수 없어요",
  not_found: "신청을 찾을 수 없어요",
  not_requestable: "무통장·계좌이체 주문만 신청할 수 있어요. 카드는 카드 매출전표로 확인해 주세요",
  active_exists: "이미 신청한 주문이에요",
  invalid_transition: "이미 발행된 신청은 철회할 수 없어요. 판매자에게 문의해 주세요",
  not_paid: "입금이 확인된 뒤에 처리돼요",
  auto_unavailable: "지금은 쓸 수 없어요",
  invalid_kind: "발행 종류를 골라 주세요",
  invalid_identity: "번호를 다시 확인해 주세요",
  invalid_tax_info: "사업자 정보를 다시 확인해 주세요",
};
export const SELLER_RECEIPT_MESSAGES: Record<ReceiptFailure, string> = {
  shop_unavailable: "지금은 처리할 수 없습니다",
  not_found: "신청을 찾을 수 없습니다",
  not_requestable: "신청할 수 없는 주문입니다",
  active_exists: "이미 신청한 주문입니다",
  invalid_transition: "처리할 수 없는 상태입니다. 화면을 새로 고쳐 주십시오",
  not_paid: "입금 확인 후에 처리할 수 있습니다",
  auto_unavailable: "자동 발행은 준비 중입니다",
  invalid_kind: "발행 종류를 확인해 주십시오",
  invalid_identity: "번호를 확인해 주십시오",
  invalid_tax_info: "사업자 정보를 확인해 주십시오",
};

export function receiptStatus(reason: string): number {
  if (reason === "not_found") return 404;
  if (reason === "shop_unavailable") return 402;
  if (reason.startsWith("invalid_") && reason !== "invalid_transition") return 400;
  return 409;
}

// ───────────── 입력 검사 ─────────────

const digits = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/[\s-]/g, "") : null);
const isPhone = (d: string) => /^01[016789]\d{7,8}$/.test(d);
// 사업자등록번호: 10자리 + 검증 자리
export function isBizNo(d: string): boolean {
  if (!/^\d{10}$/.test(d)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const n = [...d].map(Number);
  const sum = w.reduce((s, x, i) => s + x * n[i], 0) + Math.floor((n[8] * 5) / 10);
  return (10 - (sum % 10)) % 10 === n[9];
}
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

type NewRequest = { kind: ReceiptKind; identity: string; taxInfo: { companyName: string; representative: string; email: string } | null };
export function parseNewReceiptRequest(raw: Record<string, unknown>): { ok: true; v: NewRequest } | { ok: false; reason: ReceiptFailure } {
  if (typeof raw.kind !== "string" || !(RECEIPT_KINDS as readonly string[]).includes(raw.kind)) return { ok: false, reason: "invalid_kind" };
  const kind = raw.kind as ReceiptKind;
  const identity = digits(raw.identity);
  if (identity === null || !(kind === "CASH_RECEIPT_INCOME" ? isPhone(identity) : isBizNo(identity))) return { ok: false, reason: "invalid_identity" };
  if (kind !== "TAX_INVOICE") return { ok: true, v: { kind, identity, taxInfo: null } };
  const t = (raw.taxInfo ?? {}) as Record<string, unknown>;
  const companyName = cleanText(t.companyName, 100);
  const representative = cleanText(t.representative, 50);
  const email = typeof t.email === "string" ? t.email.trim() : "";
  if (!companyName || !representative || email.length > 254 || !EMAIL.test(email)) return { ok: false, reason: "invalid_tax_info" };
  return { ok: true, v: { kind, identity, taxInfo: { companyName, representative, email } } };
}

// ───────────── 보기 ─────────────

const issueSelect = { id: true, status: true, amount: true, chargeable: true, attempts: true, failureCode: true, issuedAt: true, cancelledAt: true, createdAt: true } satisfies Prisma.ReceiptIssueSelect;
export const viewSelect = {
  id: true,
  orderId: true,
  kind: true,
  identityLast4: true,
  taxInfo: true,
  withdrawnAt: true,
  createdAt: true,
  issues: { select: issueSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
} satisfies Prisma.OrderReceiptRequestSelect;
type Row = Prisma.OrderReceiptRequestGetPayload<{ select: typeof viewSelect }>;
type TaxInfo = { companyName: string; representative: string; email: string };
export const view = ({ issues, taxInfo, ...r }: Row) => ({ ...r, taxInfo: (taxInfo as TaxInfo | null) ?? null, issue: issues[0] ?? null });
export type ReceiptRequestView = ReturnType<typeof view>;

// 신청할 수 있는 주문: 무통장·계좌이체, 입금 전이거나 결제 완료
const requestable = (o: { status: string; paymentMethod: string | null }) => o.paymentMethod === "BANK_TRANSFER" && (o.status === "PENDING_PAYMENT" || o.status === "PAID");

export async function lockOrder(tx: Tx, sellerId: string, orderId: string) {
  const [o] = await tx.$queryRaw<{ status: string; paymentMethod: string | null; buyerMemberId: string; totalAmount: number; legalHoldAt: Date | null }[]>`
    SELECT "status"::text AS "status", "paymentMethod"::text AS "paymentMethod", "buyerMemberId", "totalAmount", "legalHoldAt" FROM "Order"
    WHERE "id" = ${orderId}::uuid AND "sellerId" = ${sellerId}::uuid FOR UPDATE`;
  return o ?? null;
}

// ───────────── 구매자 ─────────────

const buyerAudit = (tx: Tx, scope: BuyerScope, meta: AuditMeta, action: string, targetId: string, after: unknown) =>
  writeAudit(tx, { actorType: "BUYER", actorId: scope.buyerMemberId, sellerId: scope.sellerId, action, targetType: "OrderReceiptRequest", targetId, after, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });

// 신청 화면: 신청할 수 있는지(못 하면 이유)와 진행 중인 신청·지난 신청
export async function buyerReceiptContext(db: PrismaClient, scope: BuyerScope, orderId: string) {
  if (!isUuid(orderId)) return null;
  const order = await db.order.findFirst({ where: { id: orderId, ...scope, legalHoldAt: null }, select: { status: true, paymentMethod: true } });
  if (!order) return null;
  const rows = await db.orderReceiptRequest.findMany({ where: { sellerId: scope.sellerId, orderId }, select: viewSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const requests = rows.map(view);
  const active = requests.find((r) => r.withdrawnAt === null) ?? null;
  const blocked = !(await orderServiceOpen(db, scope.sellerId)) ? "shop_unavailable" : !requestable(order) ? "not_requestable" : active ? "active_exists" : null;
  return { canRequest: blocked === null, blocked, active, requests };
}

export async function createReceiptRequest(db: PrismaClient, scope: BuyerScope, orderId: string, body: Record<string, unknown>, meta: AuditMeta = {}) {
  if (!isUuid(orderId)) return { ok: false as const, reason: "not_found" as const };
  const parsed = parseNewReceiptRequest(body);
  if (!parsed.ok) return parsed;
  if (!(await orderServiceOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  const { kind, identity, taxInfo } = parsed.v;
  try {
    return await db.$transaction(async (tx) => {
      const order = await lockOrder(tx, scope.sellerId, orderId);
      if (!order || order.buyerMemberId !== scope.buyerMemberId || order.legalHoldAt) return { ok: false as const, reason: "not_found" as const };
      const [member] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
      if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
      if (!requestable(order)) return { ok: false as const, reason: "not_requestable" as const };
      if ((await tx.orderReceiptRequest.count({ where: { sellerId: scope.sellerId, orderId, withdrawnAt: null } })) > 0) return { ok: false as const, reason: "active_exists" as const };
      const created = await tx.orderReceiptRequest.create({
        data: {
          sellerId: scope.sellerId,
          orderId,
          buyerMemberId: scope.buyerMemberId,
          kind,
          identitySealed: sealBillingKey(identity, scope.sellerId),
          identityLast4: identity.slice(-4),
          taxInfo: taxInfo ?? Prisma.DbNull,
          issues: { create: { amount: order.totalAmount } },
        },
        select: viewSelect,
      });
      await buyerAudit(tx, scope, meta, "buyer_receipt_request.create", created.id, { orderId, kind });
      return { ok: true as const, request: view(created) };
    });
  } catch (e) {
    // 동시에 두 번 신청하면 부분 유니크 인덱스가 하나만 남긴다
    if (isUniqueViolation(e)) return { ok: false as const, reason: "active_exists" as const };
    throw e;
  }
}

// 철회: 발행 전(대기·보류·실패)만, 본인 신청만. 발행 이력은 취소로 닫는다.
export async function withdrawReceiptRequest(db: PrismaClient, scope: BuyerScope, id: string, meta: AuditMeta = {}) {
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const pre = await tx.orderReceiptRequest.findFirst({ where: { id, ...scope }, select: { orderId: true } });
    if (!pre) return { ok: false as const, reason: "not_found" as const };
    await lockOrder(tx, scope.sellerId, pre.orderId);
    const [r] = await tx.$queryRaw<{ withdrawnAt: Date | null }[]>`
      SELECT "withdrawnAt" FROM "OrderReceiptRequest" WHERE "id" = ${id}::uuid AND "sellerId" = ${scope.sellerId}::uuid FOR UPDATE`;
    const latest = await tx.receiptIssue.findFirst({ where: { sellerId: scope.sellerId, requestId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } });
    if (!r || r.withdrawnAt || !latest || (latest.status !== "PENDING" && latest.status !== "ON_HOLD" && latest.status !== "FAILED")) return { ok: false as const, reason: "invalid_transition" as const };
    const now = new Date();
    await tx.receiptIssue.update({ where: { id: latest.id }, data: { status: "CANCELLED", cancelledAt: now } });
    const row = await tx.orderReceiptRequest.update({ where: { id }, data: { withdrawnAt: now }, select: viewSelect });
    await buyerAudit(tx, scope, meta, "buyer_receipt_request.withdraw", id, { status: "CANCELLED" });
    return { ok: true as const, request: view(row) };
  });
}

// ───────────── 파트너스 ─────────────

// 목록 조건(SA-024 검색 패널): 상태 · 종류(CASH_RECEIPT = 소득공제·지출증빙 전체, TAX_INVOICE, 또는 세부 종류) · 접수 기간(from·to, KST 날짜 YYYY-MM-DD, to 포함) · 검색어.
// 검색어: field = nickname(닉네임 포함 검색) · bizno(사업자등록번호: 지출증빙·세금계산서) · phone(휴대폰 번호: 소득공제). 번호는 봉인해 두어 뒤 4자리로만 찾는다. field 없이 숫자 4자리 이상이면 번호, 아니면 닉네임.
export type ReceiptListQuery = { status?: unknown; kind?: unknown; from?: unknown; to?: unknown; field?: unknown; q?: unknown; cursor?: unknown };
export const RECEIPT_SEARCH_FIELDS = ["nickname", "bizno", "phone"] as const;
const SEARCH_MAX = 50;
const DAY_MS = 86_400_000;

// 날짜·검색 칸 값이 잘못됐는지(API가 400으로 거른다). 모르는 상태·종류는 거르지 않고 무시한다(다른 목록과 같음).
export function receiptFilterValid(q: ReceiptListQuery): boolean {
  const date = (v: unknown) => v === undefined || v === null || v === "" || (typeof v === "string" && kstDayStart(v) !== null);
  if (!date(q.from) || !date(q.to)) return false;
  if (typeof q.from === "string" && typeof q.to === "string" && q.from && q.to && kstDayStart(q.from)! > kstDayStart(q.to)!) return false;
  if (q.q !== undefined && q.q !== null && (typeof q.q !== "string" || q.q.length > SEARCH_MAX)) return false;
  if (q.field !== undefined && q.field !== null && q.field !== "" && !(RECEIPT_SEARCH_FIELDS as readonly unknown[]).includes(q.field)) return false;
  return true;
}

export function listWhere(q: ReceiptListQuery): Prisma.OrderReceiptRequestWhereInput[] {
  const and: Prisma.OrderReceiptRequestWhereInput[] = [];
  const status = STATUSES.find((s) => s === q.status);
  // 최근 발행 상태로 거르려면 신청마다 마지막 발행 행이 필요하다. 발행은 신청당 한두 건이라 상태로 먼저 후보를 좁힌다.
  if (status) and.push({ issues: { some: { status } } });
  if (q.kind === "CASH_RECEIPT") and.push({ kind: { in: ["CASH_RECEIPT_INCOME", "CASH_RECEIPT_EXPENSE"] } });
  else if (RECEIPT_KINDS.find((k) => k === q.kind)) and.push({ kind: q.kind as ReceiptKind });
  const from = typeof q.from === "string" && q.from ? kstDayStart(q.from) : null;
  const to = typeof q.to === "string" && q.to ? kstDayStart(q.to) : null;
  if (from) and.push({ createdAt: { gte: from } });
  if (to) and.push({ createdAt: { lt: new Date(to.getTime() + DAY_MS) } });
  const text = typeof q.q === "string" ? q.q.trim() : "";
  if (text) {
    const num = text.replace(/[\s-]/g, "");
    const byNumber = q.field === "bizno" || q.field === "phone" || (!q.field && /^\d{4,}$/.test(num));
    if (!byNumber) and.push({ order: { broadcastNicknameSnapshot: { contains: text, mode: "insensitive" } } });
    else if (!/^\d{4,}$/.test(num)) and.push({ id: { in: [] } });
    else {
      const kinds: ReceiptKind[] = q.field === "phone" ? ["CASH_RECEIPT_INCOME"] : q.field === "bizno" ? ["CASH_RECEIPT_EXPENSE", "TAX_INVOICE"] : [...RECEIPT_KINDS];
      and.push({ kind: { in: kinds }, identityLast4: num.slice(-4) });
    }
  }
  return and;
}

// 목록·상태별 건수(최근 발행 상태 기준). 조건은 위와 같고 커서(createdAt 내림, id 내림). 철회한 신청도 취소로 보인다.
// summary: 발행 대기·실패·취소 건수, 이번 달(KST) 발행 완료 건수·금액(상단 요약 칸).
export async function listSellerReceiptRequests(db: PrismaClient, ctx: TenantContext, q: ReceiptListQuery = {}) {
  requireSellerRead(ctx, "RECEIPT_TAX");
  let after: Prisma.OrderReceiptRequestWhereInput = {};
  if (isUuid(q.cursor)) {
    const c = await db.orderReceiptRequest.findFirst({ where: { id: q.cursor, sellerId: ctx.sellerId }, select: { id: true, createdAt: true } });
    if (c) after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
  }
  const rows = await db.orderReceiptRequest.findMany({
    where: { sellerId: ctx.sellerId, order: { legalHoldAt: null }, AND: listWhere(q), ...after },
    select: { ...viewSelect, order: { select: { orderNo: true, createdAt: true, broadcastNicknameSnapshot: true, totalAmount: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE + 1,
  });
  const page = rows.slice(0, PAGE);
  const counts = await db.receiptIssue.groupBy({ by: ["status"], where: { sellerId: ctx.sellerId, request: { order: { legalHoldAt: null } } }, _count: { _all: true } });
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<ReceiptIssueStatus, number>>;
  const now = await dbNow(db);
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const monthStart = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 1) - 9 * 3_600_000);
  const issued = await db.receiptIssue.aggregate({
    where: { sellerId: ctx.sellerId, status: "ISSUED", issuedAt: { gte: monthStart }, request: { order: { legalHoldAt: null } } },
    _count: { _all: true },
    _sum: { amount: true },
  });
  return {
    requests: page.map(({ order, ...r }) => ({ ...view(r), orderNo: order.orderNo, orderNoLabel: orderNoLabel(order.createdAt, order.orderNo), nickname: order.broadcastNicknameSnapshot, totalAmount: order.totalAmount })),
    nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
    counts: byStatus,
    summary: { pending: byStatus.PENDING ?? 0, failed: byStatus.FAILED ?? 0, cancelled: byStatus.CANCELLED ?? 0, issuedThisMonth: issued._count._all, issuedAmountThisMonth: issued._sum.amount ?? 0 },
  };
}

// 실패·보류(충전금 잔액 부족)한 발행을 다시 시도(→ 대기). 연동이 붙으면 작업이 대기 건을 가져가 발행한다.
export async function retryReceiptIssue(db: PrismaClient, ctx: TenantContext, requestId: string) {
  requireSellerPermission(ctx, "RECEIPT_TAX");
  if (!isUuid(requestId)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const pre = await tx.orderReceiptRequest.findFirst({ where: { id: requestId, sellerId: ctx.sellerId }, select: { orderId: true } });
    if (!pre) return { ok: false as const, reason: "not_found" as const };
    await lockOrder(tx, ctx.sellerId, pre.orderId);
    const [r] = await tx.$queryRaw<{ withdrawnAt: Date | null }[]>`
      SELECT "withdrawnAt" FROM "OrderReceiptRequest" WHERE "id" = ${requestId}::uuid AND "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    const latest = await tx.receiptIssue.findFirst({ where: { sellerId: ctx.sellerId, requestId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } });
    if (!r || r.withdrawnAt || !latest || (latest.status !== "FAILED" && latest.status !== "ON_HOLD")) return { ok: false as const, reason: "invalid_transition" as const };
    await tx.receiptIssue.update({ where: { id: latest.id }, data: { status: "PENDING", failureCode: null } });
    await writeAudit(tx, {
      actorType: ctx.actorType as ActorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "receipt_issue.retry",
      targetType: "OrderReceiptRequest",
      targetId: requestId,
      before: { status: latest.status },
      after: { status: "PENDING" },
    });
    const row = await tx.orderReceiptRequest.findUniqueOrThrow({ where: { id: requestId }, select: viewSelect });
    return { ok: true as const, request: view(row) };
  });
}

// API 공통 응답: 거부 사유를 상태 코드와 화면 문구(구매자 해요체 / 파트너스 합니다체)로
export function receiptError(reason: ReceiptFailure, who: "buyer" | "seller") {
  const messages = who === "buyer" ? BUYER_RECEIPT_MESSAGES : SELLER_RECEIPT_MESSAGES;
  return { body: { error: reason, message: messages[reason] }, status: receiptStatus(reason) };
}
