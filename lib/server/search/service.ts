import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { sellerCan, IMPERSONATION_READ_ACTIONS, type SellerAction } from "../authz/permissions";
import type { TenantContext } from "../tenant/context";
import { orderNoLabel, parseOrderNoLabel } from "../orders/orderNoLabel";

// 전역 검색(마스터 MA-001 상단 · 파트너스 SA 상단). 항목마다 { id, title, sub, href }, 종류별 최대 5건. 조회만, 로그 추적 없음.
// - 마스터(platform.read): 파트너스(쇼핑몰 이름·주소) · 주문번호(숫자 그대로) · 결제번호(PG 거래 번호·구독 결제 번호·결제 id와 똑같이) · 문의(제목) · 자동 연결 작업 id(똑같이).
//   구매자 이름·연락처는 검색하지도 응답에 넣지도 않는다.
// - 파트너스: 항상 ctx.sellerId 안에서만 찾는다(다른 쇼핑몰 것은 없는 것과 같다). 상품(상품 관리) · 주문번호(주문 처리) · 회원 닉네임(회원·포인트 관리) ·
//   내 문의(제목, 대표자는 쇼핑몰 전체·직원은 자기 문의). 권한이 없는 종류는 빈 목록으로 주고, 마스터 대리 조회는 정해 둔 조회 범위만 본다.
//   회원은 닉네임만 찾는다(이름·휴대폰은 개인정보 권한과 로그 기록이 필요해 검색에 쓰지 않는다).
export const SEARCH_MAX = 50;
export const PER_KIND = 5;

// 결과의 sub에 쓰는 상태 이름(파트너스 화면의 상태 배지와 같은 용어, 영문 코드를 그대로 내려주지 않는다)
const PRODUCT_STATUS: Record<string, string> = { ON_SALE: "판매 중", SOLD_OUT: "품절", HIDDEN: "숨김", DRAFT: "임시 저장" };
const ORDER_STATUS: Record<string, string> = { PENDING_PAYMENT: "결제 대기", PAID: "결제 완료", CANCELLED: "취소", REFUNDED: "환불됨" };
const MEMBER_STATUS: Record<string, string> = { ACTIVE: "활동", DORMANT: "휴면", WITHDRAWN: "탈퇴" };
const INQUIRY_STATUS: Record<string, string> = { OPEN: "답변 대기", ANSWERED: "답변 완료", CLOSED: "종료" };
const label = (map: Record<string, string>, code: string): string | null => map[code] ?? null;

// orderNoLabel: 주문 항목에만 있는 사람이 읽는 주문번호(「20261002-0409」). title은 기존대로 숫자 주문번호다.
export type SearchHit = { id: string; title: string; sub: string | null; href: string; orderNoLabel?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_NO = /^\d{1,9}$/;

// 주문번호 검색 조건: 숫자(「4」·「0004」)는 번호 전체 일치, 「20261005-0004」는 그날(KST) 만든 그 번호. 둘 다 아니면 null.
function orderNoWhere(q: string): { orderNo: number; createdAt?: { gte: Date; lt: Date } } | null {
  if (ORDER_NO.test(q)) return { orderNo: Number(q) };
  const l = parseOrderNoLabel(q);
  return l ? { orderNo: l.orderNo, createdAt: { gte: l.from, lt: l.to } } : null;
}

export function parseQuery(raw: string | null | undefined): { ok: true; q: string } | { ok: false } {
  const q = (raw ?? "").trim();
  if (q.length > SEARCH_MAX) return { ok: false };
  return { ok: true, q };
}

export async function adminSearch(db: PrismaClient, admin: AdminSessionContext, q: string) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  const empty = { sellers: [], orders: [], payments: [], inquiries: [], jobs: [] };
  if (q === "") return empty;
  const isUuid = UUID.test(q);
  const [sellers, orders, orderPays, subPays, inquiries, jobs] = await Promise.all([
    db.seller.findMany({
      where: { OR: [{ shopName: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PER_KIND,
      select: { id: true, shopName: true, slug: true, status: true },
    }),
    orderNoWhere(q)
      ? db.order.findMany({ where: orderNoWhere(q)!, orderBy: { createdAt: "desc" }, take: PER_KIND, select: { id: true, orderNo: true, createdAt: true, status: true, seller: { select: { id: true, shopName: true } } } })
      : [],
    db.payment.findMany({
      where: { OR: [{ pgTid: q }, ...(isUuid ? [{ id: q }] : [])] },
      take: PER_KIND,
      select: { id: true, sellerId: true, pgTid: true },
    }),
    db.subscriptionPayment.findMany({
      where: { OR: [{ providerPaymentId: q }, ...(isUuid ? [{ id: q }] : [])] },
      take: PER_KIND,
      select: { id: true, status: true, amount: true, seller: { select: { shopName: true } } },
    }),
    db.platformInquiry.findMany({
      where: { title: { contains: q, mode: "insensitive" } },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: PER_KIND,
      select: { id: true, title: true, status: true, seller: { select: { shopName: true } } },
    }),
    isUuid ? db.automationJob.findMany({ where: { id: q }, take: 1, select: { id: true, sellerId: true } }) : [],
  ]);
  // 결제·작업은 쇼핑몰 관계가 없어 이름을 따로 가져온다
  const need = [...new Set([...orderPays.map((p) => p.sellerId), ...jobs.map((j) => j.sellerId)])];
  const names = new Map((need.length ? await db.seller.findMany({ where: { id: { in: need } }, select: { id: true, shopName: true } }) : []).map((s) => [s.id, s.shopName]));
  return {
    sellers: sellers.map((s): SearchHit => ({ id: s.id, title: s.shopName, sub: s.slug, href: `/admin/partners/${s.id}` })),
    orders: orders.map((o): SearchHit => ({ id: o.id, title: String(o.orderNo), sub: o.seller.shopName, href: `/admin/partners/${o.seller.id}`, orderNoLabel: orderNoLabel(o.createdAt, o.orderNo) })),
    payments: [
      ...orderPays.map((p): SearchHit => ({ id: p.id, title: p.pgTid ?? p.id, sub: names.get(p.sellerId) ?? null, href: `/admin/partners/${p.sellerId}` })),
      ...subPays.map((p): SearchHit => ({ id: p.id, title: p.id, sub: p.seller.shopName, href: `/admin/billing/invoices/${p.id}` })),
    ].slice(0, PER_KIND),
    inquiries: inquiries.map((i): SearchHit => ({ id: i.id, title: i.title, sub: i.seller.shopName, href: `/admin/support/inquiries/${i.id}` })),
    jobs: jobs.map((j): SearchHit => ({ id: j.id, title: j.id, sub: names.get(j.sellerId) ?? null, href: `/admin/ops/automation/${j.id}` })),
  };
}

const canRead = (ctx: TenantContext, action: SellerAction) => (ctx.readOnly ? IMPERSONATION_READ_ACTIONS.includes(action) : sellerCan(ctx, action));

export async function sellerSearch(db: PrismaClient, ctx: TenantContext, q: string) {
  const empty = { products: [], orders: [], members: [], inquiries: [] };
  if (q === "") return empty;
  const [products, orders, members, inquiries] = await Promise.all([
    canRead(ctx, "PRODUCT_MANAGE")
      ? db.product.findMany({
          where: { sellerId: ctx.sellerId, deletedAt: null, name: { contains: q, mode: "insensitive" } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: PER_KIND,
          select: { id: true, name: true, status: true },
        })
      : [],
    canRead(ctx, "ORDER_SHIPPING") && orderNoWhere(q)
      ? db.order.findMany({ where: { sellerId: ctx.sellerId, legalHoldAt: null, ...orderNoWhere(q)! }, take: PER_KIND, select: { id: true, orderNo: true, createdAt: true, status: true } })
      : [],
    canRead(ctx, "MEMBER_POINTS")
      ? db.buyerMember.findMany({
          where: { sellerId: ctx.sellerId, deletedAt: null, broadcastNickname: { contains: q, mode: "insensitive" } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: PER_KIND,
          select: { id: true, broadcastNickname: true, status: true },
        })
      : [],
    db.platformInquiry.findMany({
      where: { sellerId: ctx.sellerId, ...(ctx.isOwner || ctx.readOnly ? {} : { createdBySellerUserId: ctx.actorId }), title: { contains: q, mode: "insensitive" } },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: PER_KIND,
      select: { id: true, title: true, status: true },
    }),
  ]);
  return {
    products: products.map((p): SearchHit => ({ id: p.id, title: p.name, sub: label(PRODUCT_STATUS, p.status), href: `/seller/products/${p.id}` })),
    orders: orders.map((o): SearchHit => ({ id: o.id, title: String(o.orderNo), sub: label(ORDER_STATUS, o.status), href: `/seller/orders/${o.id}`, orderNoLabel: orderNoLabel(o.createdAt, o.orderNo) })),
    members: members.map((m): SearchHit => ({ id: m.id, title: m.broadcastNickname, sub: label(MEMBER_STATUS, m.status), href: `/seller/members/${m.id}` })),
    inquiries: inquiries.map((i): SearchHit => ({ id: i.id, title: i.title, sub: label(INQUIRY_STATUS, i.status), href: `/seller/inquiries/${i.id}` })),
  };
}
