import { allPeriodHref } from "../../client/filterDefaults";
import { Prisma, type PrismaClient } from "@prisma/client";
import { sellerFeatures } from "../billing/features";
import { LOW_STOCK_MAX } from "../products/manage";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import type { SellerAction } from "../authz/permissions";
import { num, statsSnapshot, type StatsDb } from "./sql";

// 파트너스 홈 「오늘 처리할 일」 요약(SA-002). 숫자와 처리 화면 주소만 주고 구매자 개인정보는 넣지 않는다.
// 항목마다 { key, count, href }. href는 해당 목록 화면을 처리할 건만 걸러 연 주소다(화면 문구는 화면에서 붙인다).
// 지금 목록 화면 중 쿼리로 필터를 받는 곳은 상품(stock=out·low)뿐이다. 나머지 href의 쿼리는 목록 화면이 읽도록 맞춰야 한다(PR 본문 참고).
// - depositPending: 입금 확인을 기다리는 주문(입금 확인 화면·listPendingDeposits와 같은 기준)         ORDER_SHIPPING
// - shipPending: 결제 완료됐지만 아직 배송 정보가 없는 주문(주문 목록 status=PAID&shipped=false와 같은 기준)   ORDER_SHIPPING
// - returnRequested: 구매자가 요청해 아직 받지 않은 교환·반품(REQUESTED)                                ORDER_SHIPPING
// - inquiryWaiting: 답변을 기다리는 구매자 문의(WAITING)                                               INQUIRY_REPLY, 스토어 운영 기능
// - stockOut / stockLow: 판매 중·품절 상품(display=shown) 중 살아 있는 옵션 재고 합이 0 / 1~LOW_STOCK_MAX(상품 목록 stock 필터와 같은 기준)  PRODUCT_MANAGE, 스토어 운영 기능
// 항목 숫자는 href로 연 목록의 전체 행 수와 같아야 한다(tests/integration/sellerTodayTasks.test.ts가 목록 함수와 맞춰 본다).
// 조회 권한이 없는 항목은 목록에서 뺀다(403으로 홈 전체를 막지 않는다). 잠금 중에도 이미 받은 주문 처리 항목은 보인다.
export const SELLER_TASK_KEYS = ["depositPending", "shipPending", "returnRequested", "inquiryWaiting", "stockOut", "stockLow"] as const;
export type SellerTaskKey = (typeof SELLER_TASK_KEYS)[number];

const TASKS: { key: SellerTaskKey; action: SellerAction; store: boolean; href: string }[] = [
  { key: "depositPending", action: "ORDER_SHIPPING", store: false, href: "/seller/orders/deposits" },
  { key: "shipPending", action: "ORDER_SHIPPING", store: false, href: allPeriodHref("/seller/orders", { status: "PAID", shipped: "false" }) },
  { key: "returnRequested", action: "ORDER_SHIPPING", store: false, href: "/seller/returns?status=REQUESTED" },
  { key: "inquiryWaiting", action: "INQUIRY_REPLY", store: true, href: allPeriodHref("/seller/buyer-inquiries", { status: "WAITING" }) },
  { key: "stockOut", action: "PRODUCT_MANAGE", store: true, href: allPeriodHref("/seller/products", { stock: "out", display: "shown" }) },
  { key: "stockLow", action: "PRODUCT_MANAGE", store: true, href: allPeriodHref("/seller/products", { stock: "low", display: "shown" }) },
];

function readable(ctx: TenantContext, action: SellerAction) {
  try {
    requireSellerRead(ctx, action);
    return true;
  } catch {
    return false;
  }
}

async function stockCounts(tx: StatsDb, sellerId: string) {
  const rows = await tx.$queryRaw<{ out: number; low: number }[]>`
    SELECT count(*) FILTER (WHERE COALESCE(st."total", 0) = 0)::int AS "out",
           count(*) FILTER (WHERE COALESCE(st."total", 0) BETWEEN 1 AND ${LOW_STOCK_MAX})::int AS "low"
    FROM "Product" p
    LEFT JOIN (
      SELECT o."productId", SUM(o."stock") AS "total" FROM "ProductOption" o
      WHERE o."sellerId" = ${sellerId}::uuid AND o."deletedAt" IS NULL GROUP BY o."productId") st ON st."productId" = p."id"
    WHERE p."sellerId" = ${sellerId}::uuid AND p."deletedAt" IS NULL AND p."status" IN ('ON_SALE', 'SOLD_OUT')`;
  return { out: num(rows[0]?.out), low: num(rows[0]?.low) };
}

export async function sellerTodayTasks(db: PrismaClient, ctx: TenantContext) {
  const features = await sellerFeatures(db, ctx.sellerId);
  const allowed = TASKS.filter((t) => readable(ctx, t.action) && (!t.store || features.includes("STORE_OPERATIONS")));
  const has = (k: SellerTaskKey) => allowed.some((t) => t.key === k);
  const sellerId = ctx.sellerId;
  const counts = await statsSnapshot(db, async (tx) => {
    const [deposit, ship, returns, inquiry, stock] = await Promise.all([
      has("depositPending")
        ? tx.order.count({
            where: { sellerId, status: "PENDING_PAYMENT", legalHoldAt: null, payments: { none: { status: { in: ["APPROVING", "PAID", "PARTIAL_CANCELLED"] } } } },
          })
        : 0,
      has("shipPending") ? tx.order.count({ where: { sellerId, status: "PAID", legalHoldAt: null, shipment: { is: null } } }) : 0,
      has("returnRequested") ? tx.returnRequest.count({ where: { sellerId, status: "REQUESTED" } }) : 0,
      has("inquiryWaiting") ? tx.buyerInquiry.count({ where: { sellerId, status: "WAITING" } }) : 0,
      has("stockOut") || has("stockLow") ? stockCounts(tx, sellerId) : { out: 0, low: 0 },
    ]);
    return { depositPending: deposit, shipPending: ship, returnRequested: returns, inquiryWaiting: inquiry, stockOut: stock.out, stockLow: stock.low } satisfies Record<SellerTaskKey, number>;
  });
  const items = allowed.map((t) => ({ key: t.key, count: counts[t.key], href: t.href }));
  return { total: items.reduce((a, i) => a + i.count, 0), items };
}
