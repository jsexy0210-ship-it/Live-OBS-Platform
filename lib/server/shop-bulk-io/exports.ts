import type { BulkJobKind, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { forbidden } from "../authz/errors";
import { itemSummary, itemSummarySelect, kstDayStart } from "../orders/read";
import { orderNoLabel } from "../orders/orderNoLabel";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";
import { formatCsv, guardText } from "./csv";

// 주문·회원 내보내기와 내보내기 이력(SA-018 정본 「내보내기」·「처리 이력」). 내려받은 사실은 BulkJob(kind *_EXPORT, status COMMITTED, 되돌리기 없음)에 남아 처리 이력에 「누가·언제」로 보인다.
// - 주문 내보내기(ORDER_SHIPPING): 기간(from·to, KST 날짜, 최대 366일)의 주문·결제·배송 상태·송장·금액. 받는 분·연락처·주소는 넣지 않는다. 5,000건까지.
// - 회원 내보내기(대표자만): 사유(1~100자) 필수. 기본은 닉네임·등급·상태·가입일·최근 접속·마케팅 수신 동의·적립금 잔액이고, 이름·연락처는 includePii일 때만 넣는다.
//   내려받은 사실과 사유는 로그 추적(bulk_io.member_export)에, 개인정보를 넣었으면 customer.pii.view도 남긴다. 5,000명까지.
export const MAX_EXPORT_ORDERS = 5000;
export const MAX_EXPORT_MEMBERS = 5000;
export const EXPORT_REASON_MAX = 100;
export const ORDER_EXPORT_MAX_DAYS = 366;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

export type ExportFailure = "invalid_period" | "invalid_reason" | "too_many_orders" | "too_many_members";
export const EXPORT_MESSAGES: Record<ExportFailure, string> = {
  invalid_period: "기간을 확인해 주십시오. 시작일과 종료일이 필요하며 최대 366일까지 선택할 수 있습니다",
  invalid_reason: `내보내는 사유를 ${EXPORT_REASON_MAX}자 이내로 입력해 주십시오`,
  too_many_orders: `주문이 ${MAX_EXPORT_ORDERS}건을 넘어 한 번에 내보낼 수 없습니다. 기간을 줄여 주십시오`,
  too_many_members: `회원이 ${MAX_EXPORT_MEMBERS}명을 넘어 한 번에 내보낼 수 없습니다`,
};
export const exportFailureStatus = (_reason: ExportFailure) => 400;
type Result<T> = { ok: true; value: T } | { ok: false; reason: ExportFailure };

const kst = (d: Date | null) => {
  if (!d) return "";
  const k = new Date(d.getTime() + KST_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};

// 내려받은 사실을 이력과 로그 추적에 남긴다(내용을 다 만든 뒤 마지막에)
export async function recordExport(
  db: PrismaClient,
  ctx: TenantContext,
  e: { kind: BulkJobKind; rows: number; fileName?: string | null; reason?: string | null; meta?: Record<string, unknown>; action: string; targetType: string },
) {
  const now = await dbNow(db);
  const job = await db.bulkJob.create({
    data: {
      sellerId: ctx.sellerId,
      kind: e.kind,
      status: "COMMITTED",
      fileName: e.fileName ?? null,
      totalRows: e.rows,
      productCount: 0,
      reason: e.reason ?? null,
      meta: (e.meta ?? {}) as Prisma.InputJsonValue,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      committedAt: now,
    },
    select: { id: true },
  });
  await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: e.action, targetType: e.targetType, targetId: job.id, reason: e.reason ?? undefined, after: { rows: e.rows, ...(e.meta ?? {}) } });
  return job.id;
}

// ───────────── 주문 ─────────────

const ORDER_STATUS_TEXT = { PENDING_PAYMENT: "입금 대기", PAID: "결제 완료", CANCELLED: "취소", REFUNDED: "환불" } as const;
const METHOD_TEXT = { CARD: "카드", BANK_TRANSFER: "무통장 · 계좌이체" } as const;
const SHIPMENT_TEXT = { READY: "발송 전", IN_TRANSIT: "배송 중", DELIVERED: "배송 완료" } as const;

export function parseExportPeriod(from: unknown, to: unknown): { from: Date; toExclusive: Date; fromText: string; toText: string } | null {
  if (typeof from !== "string" || typeof to !== "string") return null;
  const f = kstDayStart(from);
  const t = kstDayStart(to);
  if (!f || !t || t < f || t.getTime() - f.getTime() >= ORDER_EXPORT_MAX_DAYS * DAY_MS) return null;
  return { from: f, toExclusive: new Date(t.getTime() + DAY_MS), fromText: from, toText: to };
}

// 열: 주문번호·주문 시각·닉네임·상품·금액·환불 금액·결제수단·주문 상태·배송 상태·택배사·송장번호. 주문 시각 오래된 순.
export async function exportOrdersCsv(db: PrismaClient, ctx: TenantContext, q: { from?: unknown; to?: unknown }): Promise<Result<{ csv: string; count: number }>> {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  const period = parseExportPeriod(q.from, q.to);
  if (!period) return { ok: false, reason: "invalid_period" };
  const rows = await db.order.findMany({
    where: { sellerId: ctx.sellerId, legalHoldAt: null, createdAt: { gte: period.from, lt: period.toExclusive } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_EXPORT_ORDERS + 1,
    select: {
      orderNo: true,
      createdAt: true,
      broadcastNicknameSnapshot: true,
      totalAmount: true,
      refundAmount: true,
      paymentMethod: true,
      status: true,
      items: itemSummarySelect,
      shipment: { select: { status: true, courier: true, trackingNumber: true } },
    },
  });
  if (rows.length > MAX_EXPORT_ORDERS) return { ok: false, reason: "too_many_orders" };
  const csv = formatCsv([
    ["주문번호", "주문 시각", "닉네임", "상품", "금액", "환불 금액", "결제수단", "주문 상태", "배송 상태", "택배사", "송장번호"],
    ...rows.map((o) => {
      const s = itemSummary(o.items);
      const product = s.firstProductName ? `${s.firstProductName}${s.otherCount > 0 ? ` 외 ${s.otherCount}건` : ""}` : "";
      const shipped = o.shipment && o.shipment.status !== "READY";
      return [
        orderNoLabel(o.createdAt, o.orderNo),
        kst(o.createdAt),
        guardText(o.broadcastNicknameSnapshot),
        guardText(product),
        String(o.totalAmount),
        String(o.refundAmount ?? 0),
        o.paymentMethod ? METHOD_TEXT[o.paymentMethod] : "",
        ORDER_STATUS_TEXT[o.status],
        o.shipment ? SHIPMENT_TEXT[o.shipment.status] : "발송 전",
        shipped ? guardText(o.shipment!.courier) : "",
        shipped ? guardText(o.shipment!.trackingNumber) : "",
      ];
    }),
  ]);
  await recordExport(db, ctx, {
    kind: "ORDER_EXPORT",
    rows: rows.length,
    meta: { from: period.fromText, to: period.toText },
    action: "bulk_io.order_export",
    targetType: "BulkJob",
  });
  return { ok: true, value: { csv, count: rows.length } };
}

// ───────────── 회원 ─────────────

const MEMBER_STATUS_TEXT = { ACTIVE: "정상", DORMANT: "휴면", WITHDRAWN: "탈퇴" } as const;

// 대표자만(직원·마스터 대리 조회는 403). 열: 닉네임·등급·상태·가입일·최근 접속·마케팅 수신 동의·적립금 잔액(+ 이름·연락처). 탈퇴한 회원은 뺀다. 가입 시각 오래된 순.
export async function exportMembersCsv(db: PrismaClient, ctx: TenantContext, raw: { reason?: unknown; includePii?: unknown }): Promise<Result<{ csv: string; count: number }>> {
  if (!ctx.isOwner || ctx.readOnly) throw forbidden();
  const reason = cleanText(raw.reason, EXPORT_REASON_MAX, "memo");
  if (!reason || (raw.includePii !== undefined && typeof raw.includePii !== "boolean")) return { ok: false, reason: "invalid_reason" };
  const includePii = raw.includePii === true;
  const members = await db.buyerMember.findMany({
    where: { sellerId: ctx.sellerId, deletedAt: null, status: { in: ["ACTIVE", "DORMANT"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_EXPORT_MEMBERS + 1,
    select: { id: true, broadcastNickname: true, name: true, phone: true, status: true, createdAt: true, lastLoginAt: true, marketingConsentAt: true, grade: { select: { displayName: true } } },
  });
  if (members.length > MAX_EXPORT_MEMBERS) return { ok: false, reason: "too_many_members" };
  const balances = members.length
    ? await db.rewardBalance.findMany({ where: { sellerId: ctx.sellerId, buyerMemberId: { in: members.map((m) => m.id) } }, select: { buyerMemberId: true, balance: true } })
    : [];
  const balanceOf = new Map(balances.map((b) => [b.buyerMemberId, b.balance]));
  const head = ["닉네임", "등급", "상태", "가입일", "최근 접속", "마케팅 수신 동의", "적립금 잔액", ...(includePii ? ["이름", "연락처"] : [])];
  const csv = formatCsv([
    head,
    ...members.map((m) => [
      guardText(m.broadcastNickname),
      guardText(m.grade.displayName),
      MEMBER_STATUS_TEXT[m.status],
      kst(m.createdAt),
      kst(m.lastLoginAt),
      m.marketingConsentAt ? "예" : "아니오",
      String(balanceOf.get(m.id) ?? 0),
      ...(includePii ? [guardText(m.name), guardText(m.phone)] : []),
    ]),
  ]);
  const jobId = await recordExport(db, ctx, { kind: "MEMBER_EXPORT", rows: members.length, reason, meta: { includePii }, action: "bulk_io.member_export", targetType: "BulkJob" });
  if (includePii) {
    await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "customer.pii.view", targetType: "MemberExport", targetId: jobId, reason: "member_export", after: { count: members.length } });
  }
  return { ok: true, value: { csv, count: members.length } };
}
