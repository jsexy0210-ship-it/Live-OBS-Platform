import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { kstDayStart } from "../orders/read";
import { kstDate } from "../stats/range";

// 마스터 관리자 파트너스 상세 「쇼핑몰」 탭(MA-012-2, platform.read, 읽기 전용). 파트너스가 쇼핑몰 설정에서 관리하는 값을 보기만 한다.
// 판매자 격리: 모든 조회가 sellerId로 묶인다. 마스터 관리자 전 역할(조회 전용 포함)이 읽는다. 구매자 개인정보는 나가지 않는다.
function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}

const filled = (s: string | null | undefined) => !!s && s.trim() !== "";

// 없는 파트너스는 null.
// 정책 점검(법정 표시 기준 아님, 입력 여부만 본다): businessCsInfo = 사업자 검증 정보가 있고 고객센터 연락처(전화·이메일) 중 하나 입력 → DISPLAYED,
// refundPolicy = 이용안내·교환·환불 정책 글 입력 → WRITTEN, minorRestriction = 미성년자 구매 안내 글 입력 → WRITTEN. 아니면 MISSING.
// reportCount = 아직 확인하지 않았고 철회되지 않은 상품평 신고 수. products.visible = 판매 중·품절(쇼핑몰에 보이는 것), total = 삭제하지 않은 전체.
// members = 탈퇴하지 않은 회원 수. topProducts = 판매 수(결제 완료 주문 품목 수량 − 환불 수량) 상위 5.
export async function getSellerShop(db: PrismaClient, admin: AdminSessionContext, sellerId: string) {
  requireRead(admin);
  const seller = await db.seller.findUnique({
    where: { id: sellerId },
    select: {
      slug: true,
      shopName: true,
      shopTagline: true,
      shopTopNotice: true,
      shopUsageGuide: true,
      operatingState: true,
      primaryAddressKind: true,
      businessInfo: true,
      brandColor: { select: { color: true } },
      shopLegalNotice: { select: { csPhone: true, csEmail: true, minorNotice: true } },
      domains: { orderBy: { createdAt: "asc" }, select: { hostname: true, verifiedAt: true, suspendedAt: true } },
    },
  });
  if (!seller) return null;
  const now = await dbNow(db);
  const monthStart = kstDayStart(`${kstDate(now).slice(0, 7)}-01`)!;
  const live = { sellerId, deletedAt: null } as const;
  const [visible, total, members, reportCount, monthOrders, monthPaid, sold] = await Promise.all([
    db.product.count({ where: { ...live, status: { in: ["ON_SALE", "SOLD_OUT"] } } }),
    db.product.count({ where: live }),
    db.buyerMember.count({ where: { sellerId, status: { not: "WITHDRAWN" } } }),
    db.productReviewReport.count({ where: { sellerId, resolvedAt: null, withdrawnAt: null } }),
    db.order.count({ where: { sellerId, createdAt: { gte: monthStart } } }),
    db.order.aggregate({ where: { sellerId, paidAt: { gte: monthStart } }, _sum: { totalAmount: true, refundAmount: true } }),
    db.orderItem.groupBy({ by: ["productId"], where: { sellerId, order: { status: "PAID" } }, _sum: { quantity: true, refundedQuantity: true } }),
  ]);
  const ranked = sold
    .map((g) => ({ productId: g.productId, soldCount: (g._sum.quantity ?? 0) - (g._sum.refundedQuantity ?? 0) }))
    .sort((a, b) => b.soldCount - a.soldCount || (a.productId < b.productId ? -1 : 1))
    .slice(0, 5);
  const products = await db.product.findMany({ where: { sellerId, id: { in: ranked.map((r) => r.productId) } }, select: { id: true, name: true, status: true } });
  const byId = new Map(products.map((p) => [p.id, p]));
  const n = seller.shopLegalNotice;
  return {
    operatingState: seller.operatingState,
    shopName: seller.shopName,
    tagline: seller.shopTagline,
    slug: seller.slug,
    brandColor: seller.brandColor?.color ?? null,
    primaryAddressKind: seller.primaryAddressKind,
    domains: seller.domains.map((d) => ({ hostname: d.hostname, verified: d.verifiedAt != null, suspended: d.suspendedAt != null })),
    topNotice: seller.shopTopNotice,
    usageGuide: seller.shopUsageGuide,
    policyChecks: {
      businessCsInfo: seller.businessInfo != null && (filled(n?.csPhone) || filled(n?.csEmail)) ? ("DISPLAYED" as const) : ("MISSING" as const),
      refundPolicy: filled(seller.shopUsageGuide) ? ("WRITTEN" as const) : ("MISSING" as const),
      minorRestriction: filled(n?.minorNotice) ? ("WRITTEN" as const) : ("MISSING" as const),
    },
    reportCount,
    products: { visible, total },
    members,
    month: { since: monthStart, orders: monthOrders, amount: (monthPaid._sum.totalAmount ?? 0) - (monthPaid._sum.refundAmount ?? 0) },
    topProducts: ranked.flatMap((r) => {
      const p = byId.get(r.productId);
      return p ? [{ id: p.id, name: p.name, status: p.status, soldCount: r.soldCount }] : [];
    }),
  };
}
