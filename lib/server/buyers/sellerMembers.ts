import type { BuyerMemberStatus, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { decodeCursor, encodeCursor } from "../orders/read";
import { canViewCustomerPii, requireSellerRead, type TenantContext } from "../tenant/context";

// 파트너스 회원 목록·상세(MEMBER_POINTS). 항상 ctx.sellerId 범위만 보고, 다른 쇼핑몰 회원은 없음(404)으로 다룬다.
// 탈퇴한 회원(deletedAt, 분리 보관)은 일반 목록·상세에서 없는 회원으로 다룬다(PRODUCT_SCOPE 탈퇴 규칙, buyers/withdraw.ts).
// 이름·휴대폰은 CUSTOMER_PII_VIEW가 있을 때만 응답에 넣고 검색하며, 넣었거나 그것으로 찾았으면 customer.pii.view를 남긴다
// (orders/read.ts와 같은 기준, 대표님 결정 2026-10-02).
export const SELLER_MEMBER_PAGE_DEFAULT = 50;
export const SELLER_MEMBER_PAGE_MAX = 200;
const LIST_STATUSES: readonly BuyerMemberStatus[] = ["ACTIVE", "DORMANT"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SellerMemberListQuery = {
  q?: string | null;
  gradeId?: string | null;
  status?: string | null;
  cursor?: string | null;
  limit?: string | null;
};

const LIST_SELECT = {
  id: true,
  broadcastNickname: true,
  name: true,
  phone: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  marketingConsentAt: true,
  grade: { select: { id: true, displayName: true } },
} as const satisfies Prisma.BuyerMemberSelect;

type MemberRow = Prisma.BuyerMemberGetPayload<{ select: typeof LIST_SELECT }>;

function view(m: MemberRow, pii: boolean) {
  return {
    id: m.id,
    broadcastNickname: m.broadcastNickname,
    ...(pii ? { name: m.name, phone: m.phone } : {}),
    grade: m.grade,
    status: m.status,
    marketingConsent: m.marketingConsentAt !== null,
    createdAt: m.createdAt,
    lastLoginAt: m.lastLoginAt,
  };
}

// 회원 목록(가입 시각 내림차순, (createdAt, id) 커서 페이지). 잘못된 값이면 { ok: false }.
// q: 방송 닉네임(부분 일치)은 누구나, 이름(부분 일치)·휴대폰 끝 4자리(숫자 4자리)는 CUSTOMER_PII_VIEW가 있을 때만 찾는다.
export async function listSellerMembers(db: PrismaClient, ctx: TenantContext, query: SellerMemberListQuery) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const limit = query.limit == null || query.limit === "" ? SELLER_MEMBER_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, SELLER_MEMBER_PAGE_MAX);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  if (query.status && !LIST_STATUSES.includes(query.status as BuyerMemberStatus)) return { ok: false as const };
  if (query.gradeId && !UUID_RE.test(query.gradeId)) return { ok: false as const };
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };

  const pii = canViewCustomerPii(ctx);
  const searchesPii = q !== "" && pii;
  const and: Prisma.BuyerMemberWhereInput[] = [{ sellerId: ctx.sellerId, deletedAt: null, status: { in: [...LIST_STATUSES] } }];
  if (query.status) and.push({ status: query.status as BuyerMemberStatus });
  if (query.gradeId) and.push({ gradeId: query.gradeId });
  if (q) {
    const or: Prisma.BuyerMemberWhereInput[] = [{ broadcastNickname: { contains: q, mode: "insensitive" } }];
    if (searchesPii) {
      or.push({ name: { contains: q, mode: "insensitive" } });
      if (/^\d{4}$/.test(q)) or.push({ phone: { endsWith: q } });
    }
    and.push({ OR: or });
  }
  if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });

  const rows = await db.buyerMember.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: LIST_SELECT,
  });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  // 이름·휴대폰을 내보냈거나 그것으로 찾았으면 열람 기록. 검색어는 남기지 않고 돌려준 회원 id·건수만 남긴다.
  // 개인정보로 찾았으면 결과가 0건이어도 남긴다(일치 여부도 개인정보 확인이다, #209 Codex).
  if (searchesPii || (pii && page.length > 0)) {
    await writeAudit(db, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "customer.pii.view",
      targetType: "MemberList",
      reason: searchesPii ? "member_list_search" : "member_list",
      after: { memberIds: page.map((m) => m.id), count: page.length },
    });
  }
  return {
    ok: true as const,
    members: page.map((m) => view(m, pii)),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

// 회원 상세: 목록 항목 + 주문 수·누적 결제(결제된 주문 금액 − 환불액)·적립금 잔액. 탈퇴·다른 쇼핑몰 회원은 404.
export async function getSellerMember(db: PrismaClient, ctx: TenantContext, memberId: string) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  if (!UUID_RE.test(memberId)) throw notFound();
  const m = await db.buyerMember.findFirst({ where: { id: memberId, sellerId: ctx.sellerId, deletedAt: null }, select: LIST_SELECT });
  if (!m) throw notFound();
  // 법정 보관으로 분리한 주문(legalHoldAt)은 일반 조회에서 없는 주문이다(orders/read.ts)
  const orders = { sellerId: ctx.sellerId, buyerMemberId: m.id, legalHoldAt: null } as const;
  const [orderCount, paid, balance] = await Promise.all([
    db.order.count({ where: orders }),
    db.order.aggregate({ where: { ...orders, paidAt: { not: null } }, _sum: { totalAmount: true, refundAmount: true } }),
    db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: ctx.sellerId, buyerMemberId: m.id } }, select: { balance: true } }),
  ]);
  const pii = canViewCustomerPii(ctx);
  if (pii) {
    await writeAudit(db, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "customer.pii.view",
      targetType: "BuyerMember",
      targetId: m.id,
    });
  }
  return {
    ...view(m, pii),
    orderCount,
    totalPaid: (paid._sum.totalAmount ?? 0) - (paid._sum.refundAmount ?? 0),
    rewardBalance: balance?.balance ?? 0,
  };
}
