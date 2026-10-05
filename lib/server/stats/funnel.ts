import { createHmac } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { kstDate, ratio, type StatsRange } from "./range";
import { num, statsSnapshot } from "./sql";

// 전환 단계 통계(상품 상세 → 장바구니 → 주문 → 결제, 대표님 결정 2026-10-05 A안).
// 기록: 로그인한 구매자 회원의 상품 상세 조회·장바구니 담기만 일(KST) 단위로 센다. 비회원·익명 쿠키 기록은 없다.
// - 같은 회원이 같은 상품을 같은 날 여러 번 보거나 담아도 한 번만 센다(ProductFunnelSeen 유니크, on conflict do nothing).
// - 회원은 HMAC(서버 비밀키, 일|쇼핑몰|회원) 값으로만 둔다(원문 식별자 없음). 비밀키는 본인확인 해시 키(IDENTITY_HASH_KEY)를 쓰되
//   「funnel」 이름표를 붙여 다른 해시와 섞이지 않게 한다. 키가 없거나 짧으면 기록하지 않는다(화면을 막지 않음).
// - 기록 함수는 절대 던지지 않는다(실패는 삼킴). 구매자 화면의 응답을 늦추거나 막지 않게 await 한 줄로 부른다.
// - 같은 서버 안에서는 최근에 센 (회원·상품·일·종류)를 메모리에 기억해 DB 쓰기를 건너뛴다(한도 있는 단순 기억).
// 보관: 중복 제거 표는 8일, 일 집계는 400일(정리 작업, jobs/scheduler.ts).
export const FUNNEL_SEEN_KEEP_DAYS = 8;
export const FUNNEL_DAILY_KEEP_DAYS = 400;
export const FUNNEL_ROWS = 20;
const MEMO_MAX = 50_000;

export type FunnelScope = { sellerId: string; buyerMemberId: string };
type Kind = "V" | "C";

const memo = new Map<string, true>();

function viewerHash(day: string, scope: FunnelScope): string | null {
  const key = process.env.IDENTITY_HASH_KEY;
  if (!key || key.length < 32) return null;
  return createHmac("sha256", key).update(`funnel:v1|${day}|${scope.sellerId}|${scope.buyerMemberId}`, "utf8").digest("hex");
}

async function record(db: PrismaClient, scope: FunnelScope, productId: string, kind: Kind, now: Date) {
  try {
    const day = kstDate(now);
    const hash = viewerHash(day, scope);
    if (!hash) return;
    const memoKey = `${kind}|${hash}|${productId}`;
    if (memo.has(memoKey)) return;
    await db.$transaction(async (tx) => {
      const seen = await tx.$executeRaw`
        INSERT INTO "ProductFunnelSeen" ("sellerId", "productId", "day", "kind", "viewerHash")
        VALUES (${scope.sellerId}::uuid, ${productId}::uuid, ${day}::date, ${kind}, ${hash})
        ON CONFLICT DO NOTHING`;
      if (seen === 0) return;
      const views = kind === "V" ? 1 : 0;
      const carts = kind === "C" ? 1 : 0;
      await tx.$executeRaw`
        INSERT INTO "ProductFunnelDaily" ("sellerId", "productId", "day", "views", "cartAdds")
        VALUES (${scope.sellerId}::uuid, ${productId}::uuid, ${day}::date, ${views}, ${carts})
        ON CONFLICT ("sellerId", "productId", "day") DO UPDATE
          SET "views" = "ProductFunnelDaily"."views" + ${views}, "cartAdds" = "ProductFunnelDaily"."cartAdds" + ${carts}`;
    });
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(memoKey, true);
  } catch {
    // 기록 실패는 구매자 화면에 영향이 없어야 한다
  }
}

// 로그인한 회원이 상품 상세를 봤다. 상품 상세 화면(서버)에서 부른다.
export const recordProductView = (db: PrismaClient, scope: FunnelScope, productId: string, now: Date = new Date()) => record(db, scope, productId, "V", now);
// 로그인한 회원이 상품을 장바구니에 담았다. 담기가 성공한 뒤에 부른다.
export const recordCartAdd = (db: PrismaClient, scope: FunnelScope, productId: string, now: Date = new Date()) => record(db, scope, productId, "C", now);

// 장바구니 담기는 옵션 id만 알 때가 많아 옵션에서 상품을 찾아 센다(같은 쇼핑몰 옵션만, 못 찾으면 기록하지 않음). 절대 던지지 않는다.
export async function recordCartAddForOption(db: PrismaClient, scope: FunnelScope, optionId: string, now: Date = new Date()): Promise<void> {
  try {
    const o = await db.productOption.findFirst({ where: { id: optionId, sellerId: scope.sellerId }, select: { productId: true } });
    if (o) await recordCartAdd(db, scope, o.productId, now);
  } catch {
    // 기록 실패는 구매자 화면에 영향이 없어야 한다
  }
}

// 정리 작업: 중복 제거 표 8일, 일 집계 400일(KST 날짜 기준)
export async function purgeFunnelSeen(tx: Prisma.TransactionClient, now: Date): Promise<number> {
  const cutoff = kstDate(new Date(now.getTime() - FUNNEL_SEEN_KEEP_DAYS * 86_400_000));
  return tx.$executeRaw`DELETE FROM "ProductFunnelSeen" WHERE "day" < ${cutoff}::date`;
}
export async function purgeFunnelDaily(tx: Prisma.TransactionClient, now: Date): Promise<number> {
  const cutoff = kstDate(new Date(now.getTime() - FUNNEL_DAILY_KEEP_DAYS * 86_400_000));
  return tx.$executeRaw`DELETE FROM "ProductFunnelDaily" WHERE "day" < ${cutoff}::date`;
}

// 시험용: 메모리 기억 비우기
export const resetFunnelMemo = () => memo.clear();

// 조회(SALES_VIEW). 기간(KST 날짜) 안의 조회·담기(일 집계)와 주문·결제(기존 주문 표)를 상품별로 붙인다.
// - 조회·담기 = 로그인 회원이 같은 상품을 같은 날 한 번으로 센 값의 합(회원-상품-일 수). 비회원 조회는 없다.
// - 주문 = 기간에 들어온 주문 중 그 상품이 든 주문 수(상태 무관), 결제 = 그 가운데 결제된 적 있는 주문(paidAt 있음). 지운 상품은 뺀다.
// - 단계 비율: 조회→담기, 담기→주문, 주문→결제. 분모가 0이면 null. 상품별은 조회 많은 순(같으면 주문 많은 순) 상위 20개.
type Row = { product_id: string; name: string; views: number; carts: number; orders: number; paid: number };

export async function funnelStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  return statsSnapshot(db, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      WITH d AS (
        SELECT "productId", sum("views")::int AS views, sum("cartAdds")::int AS carts FROM "ProductFunnelDaily"
        WHERE "sellerId" = ${ctx.sellerId}::uuid AND "day" >= ${range.from}::date AND "day" <= ${range.to}::date GROUP BY 1
      ),
      o AS (
        SELECT i."productId", count(DISTINCT r.id)::int AS orders, count(DISTINCT r.id) FILTER (WHERE r."paidAt" IS NOT NULL)::int AS paid
        FROM "OrderItem" i JOIN "Order" r ON r.id = i."orderId" AND r."sellerId" = i."sellerId"
        WHERE i."sellerId" = ${ctx.sellerId}::uuid AND r."createdAt" >= ${range.start} AND r."createdAt" < ${range.end} GROUP BY 1
      )
      SELECT p.id AS product_id, p.name, coalesce(d.views, 0) AS views, coalesce(d.carts, 0) AS carts, coalesce(o.orders, 0) AS orders, coalesce(o.paid, 0) AS paid
      FROM "Product" p LEFT JOIN d ON d."productId" = p.id LEFT JOIN o ON o."productId" = p.id
      WHERE p."sellerId" = ${ctx.sellerId}::uuid AND p."deletedAt" IS NULL AND (d."productId" IS NOT NULL OR o."productId" IS NOT NULL)`;
    const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + num(f(r)), 0);
    const views = sum((r) => r.views);
    const cartAdds = sum((r) => r.carts);
    const orders = sum((r) => r.orders);
    const paid = sum((r) => r.paid);
    const top = [...rows].sort((a, b) => b.views - a.views || b.orders - a.orders || (a.product_id < b.product_id ? -1 : 1)).slice(0, FUNNEL_ROWS);
    const steps = (v: number, c: number, o: number, p: number) => ({ viewToCart: ratio(c, v), cartToOrder: ratio(o, c), orderToPaid: ratio(p, o) });
    return {
      range: { from: range.from, to: range.to },
      basis: "login_members" as const,
      totals: { views, cartAdds, orders, paidOrders: paid, ...steps(views, cartAdds, orders, paid) },
      products: top.map((r) => ({ productId: r.product_id, name: r.name, views: r.views, cartAdds: r.carts, orders: r.orders, paidOrders: r.paid, ...steps(r.views, r.carts, r.orders, r.paid) })),
    };
  });
}
