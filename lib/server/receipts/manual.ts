import type { ActorType, PrismaClient, ReceiptIssueMode, ReceiptIssueStatus, ReceiptKind } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { openBillingKey } from "../billing/secret";
import { dbNow } from "../billing/subscription";
import { orderNoLabel } from "../orders/orderNoLabel";
import { formatCsv, guardText } from "../shop-bulk-io/csv";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { isUuid, listWhere, lockOrder, receiptFilterValid, view, viewSelect, type AuditMeta, type ReceiptListQuery } from "./service";

// 직접 발행 후 완료 처리(SA-024, 정본 v320 「직접 발행 후 목록에서 발행 완료 처리 + 구매자 알림 + 발행 방식 설정」).
// 파트너스가 홈택스 등에서 직접 발행하고 목록에서 「발행 완료 처리」를 누르면 발행 이력을 발행 완료로 닫고 구매자 안내를 남긴다.
// 자동 발행(발행 업체 연동)은 준비 중이라 기존 다시 발행(service.ts retryReceiptIssue) 흐름은 그대로 두고, 직접 발행한 건은 외부 건당비가 없어 충전금 차감 대상이 아니다(chargeable=false).
// 구매자 안내: 발송 채널 연동 전이라 안내 기록(OrderNotification RECEIPT_ISSUED, PENDING)만 남기고, 구매자는 주문 화면에서 발행 완료를 본다.

export const RECEIPT_BULK_MAX = 50;
export const RECEIPT_EXPORT_MAX = 5000;

const actorOf = (ctx: TenantContext) => ({ actorType: ctx.actorType as ActorType, actorId: ctx.actorId, sellerId: ctx.sellerId });

// 발행 완료 처리: 발행 대기(PENDING)만, 입금이 확인된(결제 완료) 주문만. 실패·보류는 다시 발행으로 대기에 돌린 뒤 처리한다.
export async function completeReceiptIssue(db: PrismaClient, ctx: TenantContext, requestId: string) {
  requireSellerPermission(ctx, "RECEIPT_TAX");
  if (!isUuid(requestId)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const pre = await tx.orderReceiptRequest.findFirst({ where: { id: requestId, sellerId: ctx.sellerId }, select: { orderId: true } });
    if (!pre) return { ok: false as const, reason: "not_found" as const };
    const order = await lockOrder(tx, ctx.sellerId, pre.orderId);
    if (!order || order.legalHoldAt) return { ok: false as const, reason: "not_found" as const };
    const [r] = await tx.$queryRaw<{ withdrawnAt: Date | null }[]>`
      SELECT "withdrawnAt" FROM "OrderReceiptRequest" WHERE "id" = ${requestId}::uuid AND "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    const latest = await tx.receiptIssue.findFirst({ where: { sellerId: ctx.sellerId, requestId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } });
    if (!r || r.withdrawnAt || !latest || latest.status !== "PENDING") return { ok: false as const, reason: "invalid_transition" as const };
    if (order.status !== "PAID") return { ok: false as const, reason: "not_paid" as const };
    const now = await dbNow(tx);
    await tx.receiptIssue.update({ where: { id: latest.id }, data: { status: "ISSUED", issuedAt: now, chargeable: false, failureCode: null } });
    await tx.orderNotification.createMany({ data: [{ sellerId: ctx.sellerId, orderId: pre.orderId, kind: "RECEIPT_ISSUED", claimedAt: now }], skipDuplicates: true });
    await writeAudit(tx, {
      ...actorOf(ctx),
      action: "receipt_issue.complete",
      targetType: "OrderReceiptRequest",
      targetId: requestId,
      before: { status: "PENDING" },
      after: { status: "ISSUED", manual: true },
    });
    const row = await tx.orderReceiptRequest.findUniqueOrThrow({ where: { id: requestId }, select: viewSelect });
    return { ok: true as const, request: view(row) };
  });
}

// 선택한 여러 건을 발행 완료 처리(최대 RECEIPT_BULK_MAX건). 건마다 따로 처리해 결과를 돌려준다(일부 실패해도 나머지는 처리).
export async function completeReceiptIssues(db: PrismaClient, ctx: TenantContext, ids: unknown) {
  requireSellerPermission(ctx, "RECEIPT_TAX");
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > RECEIPT_BULK_MAX || ids.some((i) => typeof i !== "string")) return { ok: false as const };
  const results: { id: string; ok: boolean; reason?: string }[] = [];
  for (const id of [...new Set(ids as string[])]) {
    const r = await completeReceiptIssue(db, ctx, id);
    results.push(r.ok ? { id, ok: true } : { id, ok: false, reason: r.reason });
  }
  return { ok: true as const, results, completed: results.filter((r) => r.ok).length };
}

// 상세(처리 창·보기): 직접 발행에 필요한 번호 전체와 사업자 정보. 번호를 연 사실은 로그 추적에 남긴다.
export async function getSellerReceiptRequest(db: PrismaClient, ctx: TenantContext, id: string) {
  requireSellerRead(ctx, "RECEIPT_TAX");
  if (!isUuid(id)) return null;
  const r = await db.orderReceiptRequest.findFirst({
    where: { id, sellerId: ctx.sellerId, order: { legalHoldAt: null } },
    select: { ...viewSelect, identitySealed: true, order: { select: { orderNo: true, createdAt: true, status: true, totalAmount: true, broadcastNicknameSnapshot: true } } },
  });
  if (!r) return null;
  const { order, identitySealed, ...rest } = r;
  const identity = openBillingKey(identitySealed, ctx.sellerId);
  await writeAudit(db, { ...actorOf(ctx), action: "receipt_request.reveal_identity", targetType: "OrderReceiptRequest", targetId: id, after: { kind: r.kind } });
  return {
    ...view(rest),
    identity,
    orderNo: order.orderNo,
    orderNoLabel: orderNoLabel(order.createdAt, order.orderNo),
    nickname: order.broadcastNicknameSnapshot,
    order: { status: order.status, totalAmount: order.totalAmount },
  };
}

// ───────────── 발행 방식 ─────────────

export const RECEIPT_ISSUE_MODES: readonly ReceiptIssueMode[] = ["DIRECT", "AUTO"];

export async function readReceiptSetting(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "RECEIPT_TAX");
  const row = await db.sellerReceiptSetting.findUnique({ where: { sellerId: ctx.sellerId }, select: { issueMode: true } });
  return { issueMode: row?.issueMode ?? ("DIRECT" as ReceiptIssueMode) };
}

// 저장. DIRECT(직접 발행 후 완료 처리)만 고를 수 있고, AUTO(자동 발행)는 발행 업체 연동 전이라 auto_unavailable(준비 중). 모르는 값은 invalid_mode.
export async function saveReceiptSetting(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "RECEIPT_TAX");
  const mode = (raw as { issueMode?: unknown } | null)?.issueMode;
  if (!(RECEIPT_ISSUE_MODES as readonly unknown[]).includes(mode)) return { ok: false as const, reason: "invalid_mode" as const };
  if (mode === "AUTO") return { ok: false as const, reason: "auto_unavailable" as const };
  return db.$transaction(async (tx) => {
    const before = await tx.sellerReceiptSetting.findUnique({ where: { sellerId: ctx.sellerId }, select: { issueMode: true } });
    const row = await tx.sellerReceiptSetting.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, issueMode: "DIRECT" }, update: { issueMode: "DIRECT" }, select: { issueMode: true } });
    if ((before?.issueMode ?? "DIRECT") !== row.issueMode) {
      await writeAudit(tx, { ...actorOf(ctx), action: "receipt_setting.update", targetType: "Seller", targetId: ctx.sellerId, before: before ?? { issueMode: "DIRECT" }, after: row });
    }
    return { ok: true as const, issueMode: row.issueMode };
  });
}

// ───────────── 내려받기 ─────────────

const KIND_TEXT: Record<ReceiptKind, string> = { CASH_RECEIPT_INCOME: "현금영수증 · 소득공제", CASH_RECEIPT_EXPENSE: "현금영수증 · 지출증빙", TAX_INVOICE: "세금계산서" };
const STATUS_TEXT: Record<ReceiptIssueStatus, string> = { PENDING: "발행 대기", ON_HOLD: "보류", ISSUED: "발행 완료", FAILED: "실패", CANCELLED: "발행 취소" };
const KST_MS = 9 * 3_600_000;
const KST_TEXT = (d: Date | null) => {
  if (!d) return "";
  const k = new Date(d.getTime() + KST_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};

// month(YYYY-MM, KST)는 from·to를 그 달 1일~말일로 채우는 줄임말(「이번 달 내려받기」). 달 형식이 틀리면 null.
export function receiptMonthRange(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

// 목록과 같은 조건(status·kind·from·to·field·q)으로 CSV를 만든다(최대 RECEIPT_EXPORT_MAX건, 접수 시각 오래된 순). 번호는 뒤 4자리만 넣는다.
// 열: 접수 시각·닉네임·주문번호·종류·번호(뒤 4자리)·금액·상태·발행 시각. 내려받은 사실은 로그 추적(receipt_request.export)에 남긴다.
export async function exportSellerReceiptRequests(db: PrismaClient, ctx: TenantContext, query: ReceiptListQuery & { month?: unknown }, meta: AuditMeta = {}) {
  requireSellerRead(ctx, "RECEIPT_TAX");
  let q: ReceiptListQuery = query;
  if (typeof query.month === "string" && query.month) {
    const range = receiptMonthRange(query.month);
    if (!range) return { ok: false as const };
    q = { ...query, ...range };
  }
  if (!receiptFilterValid(q)) return { ok: false as const };
  const rows = await db.orderReceiptRequest.findMany({
    where: { sellerId: ctx.sellerId, order: { legalHoldAt: null }, AND: listWhere(q) },
    select: { ...viewSelect, order: { select: { orderNo: true, createdAt: true, broadcastNicknameSnapshot: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: RECEIPT_EXPORT_MAX + 1,
  });
  const page = rows.slice(0, RECEIPT_EXPORT_MAX);
  const csv = formatCsv([
    ["접수 시각", "닉네임", "주문번호", "종류", "번호(뒤 4자리)", "금액", "상태", "발행 시각"],
    ...page.map((r) => {
      const v = view(r);
      return [KST_TEXT(r.createdAt), guardText(r.order.broadcastNicknameSnapshot), orderNoLabel(r.order.createdAt, r.order.orderNo), KIND_TEXT[r.kind], `****${r.identityLast4}`, String(v.issue?.amount ?? 0), STATUS_TEXT[v.issue?.status ?? "CANCELLED"], KST_TEXT(v.issue?.issuedAt ?? null)];
    }),
  ]);
  await writeAudit(db, {
    ...actorOf(ctx),
    action: "receipt_request.export",
    targetType: "SellerReceiptList",
    targetId: ctx.sellerId,
    after: { rows: page.length, truncated: rows.length > RECEIPT_EXPORT_MAX, filters: Object.fromEntries(Object.entries(query).filter(([k, v]) => v && k !== "cursor")) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, csv, rows: page.length };
}
