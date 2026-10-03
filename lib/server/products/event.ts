import type { EventDiscountType, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { dbNow } from "../billing/subscription";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 상품 이벤트 할인·마감 임박 표시(대표님 결정 2026-10-03, PRODUCT_SCOPE 「상품 이벤트 할인·마감 임박 표시」).
// - 판매자가 상품마다 할인율(RATE, 1~90%) 또는 할인 금액(AMOUNT, 원)과 시작·종료 시각을 정한다.
// - 할인은 단가(상품 가격 + 옵션 추가금)에 적용한다. 할인율은 원 단위 버림. 할인 뒤 단가는 모든 옵션에서 1원 이상이어야 한다.
// - 할인 적용 여부는 주문할 때 서버가 DB 시계로 판단하고(시작 ≤ 지금 < 종료), 주문 품목에 그때 단가를 남긴다.
// - 마감 임박: 종료일이 오늘(KST)이면 「오늘 마감」, 7일 안이면 「D-n」, 하루 안이면 「n시간 m분 남았어요」.

export const MAX_EVENT_RATE = 90;
export const MAX_EVENT_DAYS = 365;
export const DEADLINE_BADGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProductEvent = { type: EventDiscountType; value: number; startsAt: Date; endsAt: Date };
type EventColumns = { eventDiscountType: EventDiscountType | null; eventDiscountValue: number | null; eventStartsAt: Date | null; eventEndsAt: Date | null };

export function eventOf(p: EventColumns): ProductEvent | null {
  if (!p.eventDiscountType || p.eventDiscountValue === null || !p.eventStartsAt || !p.eventEndsAt) return null;
  return { type: p.eventDiscountType, value: p.eventDiscountValue, startsAt: p.eventStartsAt, endsAt: p.eventEndsAt };
}

export const isEventActive = (e: ProductEvent | null, now: Date): e is ProductEvent => !!e && e.startsAt <= now && now < e.endsAt;

// 할인 뒤 단가(기간과 상관없이 계산). 할인율은 원 단위 버림.
export function discountedUnit(unit: number, e: ProductEvent): number {
  return e.type === "RATE" ? Math.floor((unit * (100 - e.value)) / 100) : unit - e.value;
}

// 주문 단가: 기간 안이면 할인 뒤 단가, 아니면 정가
export const orderUnitPrice = (unit: number, e: ProductEvent | null, now: Date) => (isEventActive(e, now) ? discountedUnit(unit, e) : unit);

// 할인을 걸어도 모든 옵션의 단가가 1원 이상인지(가격·옵션 추가금을 바꿀 때도 확인한다)
export const eventFits = (e: ProductEvent | null, price: number, deltas: number[]) => !e || deltas.every((d) => discountedUnit(price + d, e) >= 1);

const kstDate = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

// 화면 표시용(상품 목록·상세·방송 오버레이). 남은 시간 문구는 해요체.
export function eventView(e: ProductEvent | null, price: number, now: Date) {
  if (!e) return null;
  const active = isEventActive(e, now);
  const remainingMs = Math.max(0, e.endsAt.getTime() - now.getTime());
  const daysLeft = Math.round((Date.parse(kstDate(e.endsAt)) - Date.parse(kstDate(now))) / DAY_MS);
  const badge = !active ? null : daysLeft === 0 ? "오늘 마감" : daysLeft <= DEADLINE_BADGE_DAYS ? `D-${daysLeft}` : null;
  const minutes = Math.ceil(remainingMs / 60_000);
  const remainingLabel =
    active && remainingMs < DAY_MS ? (minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 남았어요` : `${minutes}분 남았어요`) : null;
  return {
    type: e.type,
    value: e.value,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    active,
    // 상품 가격 기준 할인가(옵션 추가금이 있으면 옵션마다 다르다)
    discountedPrice: discountedUnit(price, e),
    discountRate: e.type === "RATE" ? e.value : Math.floor((e.value / price) * 100),
    badge,
    remainingSeconds: active ? Math.floor(remainingMs / 1000) : null,
    remainingLabel,
  };
}

export type EventFailure = "invalid_event" | "invalid_event_period" | "event_price_too_low";

function parseEvent(raw: unknown, now: Date): ProductEvent | EventFailure {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid_event";
  const b = raw as Record<string, unknown>;
  const type = b.type === "RATE" || b.type === "AMOUNT" ? b.type : null;
  const value = b.value;
  if (!type || typeof value !== "number" || !Number.isInteger(value) || value < 1 || (type === "RATE" && value > MAX_EVENT_RATE) || value > 2147483647) {
    return "invalid_event";
  }
  const at = (v: unknown) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
  const startsAt = at(b.startsAt);
  const endsAt = at(b.endsAt);
  if (!startsAt || !endsAt || endsAt <= startsAt || endsAt <= now || endsAt.getTime() - startsAt.getTime() > MAX_EVENT_DAYS * DAY_MS) return "invalid_event_period";
  return { type, value, startsAt, endsAt };
}

// 이벤트 할인 설정(덮어쓰기). 본문 { type: "RATE" | "AMOUNT", value, startsAt, endsAt(ISO) }.
export async function setProductEvent(db: PrismaClient, ctx: TenantContext, productId: string, raw: unknown) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (!UUID.test(productId)) throw notFound();
  return db.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id: productId, sellerId: ctx.sellerId, deletedAt: null } });
    if (!product) throw notFound();
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId}::uuid FOR UPDATE`;
    const now = await dbNow(tx);
    const e = parseEvent(raw, now);
    if (typeof e === "string") return { ok: false as const, reason: e };
    const options = await tx.productOption.findMany({ where: { sellerId: ctx.sellerId, productId, deletedAt: null }, select: { priceDelta: true } });
    if (!eventFits(e, product.price, [0, ...options.map((o) => o.priceDelta)])) return { ok: false as const, reason: "event_price_too_low" as const };
    await tx.product.update({
      where: { id: productId },
      data: { eventDiscountType: e.type, eventDiscountValue: e.value, eventStartsAt: e.startsAt, eventEndsAt: e.endsAt },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product.event_set",
      targetType: "Product",
      targetId: productId,
      before: eventOf(product),
      after: e,
    });
    return { ok: true as const, value: eventView(e, product.price, now) };
  });
}

// 이벤트 할인 끄기. 이미 만든 주문 금액은 바뀌지 않는다.
export async function clearProductEvent(db: PrismaClient, ctx: TenantContext, productId: string) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (!UUID.test(productId)) throw notFound();
  return db.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id: productId, sellerId: ctx.sellerId, deletedAt: null } });
    if (!product) throw notFound();
    await tx.product.update({ where: { id: productId }, data: { eventDiscountType: null, eventDiscountValue: null, eventStartsAt: null, eventEndsAt: null } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product.event_clear",
      targetType: "Product",
      targetId: productId,
      before: eventOf(product),
    });
  });
}
