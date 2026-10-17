import type { PrismaClient } from "@prisma/client";
import { notFound } from "../authz/errors";
import { dbNow } from "../billing/subscription";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { eventOf, eventView } from "./event";
import { listProductImages } from "./images";
import { LOW_STOCK_MAX, productCode } from "./manage";

// 상품 상세 미리보기(SA-013): 구매자 화면에 보이는 값을 그대로 모아 주고, 점검 항목과 공유 링크를 함께 준다. 쓰기 없음.
// - 권한: 「상품 관리」(PRODUCT_MANAGE) 보기. 숨김·판매 대기 상품도 미리볼 수 있다(open.canOpen만 false).
// - 가격은 이벤트 할인 기간 안이면 할인가(discountedPrice·discountRate)가 같이 나간다(서버 시계). 옵션 추가금이 있으면 옵션마다 다르다.
// - 적립 안내는 기본 등급(BASIC)의 카드·무통장 적립률(적립금 정책에 없으면 null).
// - 점검 항목(checks)은 status = ok(확인) | warn(주의). 판매자가 고쳐야 할 것만 warn.
// - 상품별 구매 제한(1인 N개 등)은 아직 모델이 없어 purchaseLimits는 null이다.
// - 공유 카드(공유 링크의 미리보기)는 대표 이미지·상품명·가격으로 만든다.

export type PreviewCheckStatus = "ok" | "warn";
export type PreviewCheck = { key: "images" | "description" | "price" | "stock" | "categories"; status: PreviewCheckStatus; detail: string };

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const ratioOf = (w: number, h: number) => {
  const g = gcd(w, h) || 1;
  return `${w / g}:${h / g}`;
};

export async function previewProduct(db: PrismaClient, ctx: TenantContext, productId: string) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const now = await dbNow(db);
  const [product, seller] = await Promise.all([
    db.product.findFirst({
      where: { id: productId, sellerId: ctx.sellerId, deletedAt: null },
      include: { options: { where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] }, categories: { include: { category: { select: { name: true } } } }, detail: { select: { blocks: true, html: true } } },
    }),
    db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { slug: true, shopName: true } }),
  ]);
  if (!product) throw notFound();
  const [images, basic, policy] = await Promise.all([
    listProductImages(db, ctx.sellerId, productId),
    db.memberGrade.findFirst({ where: { sellerId: ctx.sellerId, systemKey: "BASIC" }, select: { id: true, displayName: true } }),
    db.rewardPolicy.findUnique({ where: { sellerId: ctx.sellerId }, select: { rates: true } }),
  ]);
  const event = eventView(eventOf(product), product.price, now);
  const stock = product.options.reduce((n, o) => n + o.stock, 0);
  const soldOut = product.status === "SOLD_OUT" || stock === 0;
  const rates = (policy?.rates && typeof policy.rates === "object" ? policy.rates : {}) as Record<string, { card?: number; bankTransfer?: number } | undefined>;
  const rate = basic ? rates[basic.id] : undefined;
  const categories = product.categories.map((c) => c.category.name);
  const hasDescription = !!product.description?.trim() || !!product.detail?.html?.trim() || (Array.isArray(product.detail?.blocks) && product.detail.blocks.length > 0);
  const ratios = [...new Set(images.map((i) => ratioOf(i.width, i.height)))];
  const thumb = images.find((i) => i.isThumbnail) ?? images[0] ?? null;
  const shown = product.status === "ON_SALE" || product.status === "SOLD_OUT";
  const path = `/shop/${seller.slug}/products/${product.id}`;
  const price = event?.active ? event.discountedPrice : product.price;

  const checks: PreviewCheck[] = [
    images.length > 0
      ? { key: "images", status: "ok", detail: `${images.length}장 · ${ratios.length === 1 ? ratios[0] : "비율이 섞여 있음"}` }
      : { key: "images", status: "warn", detail: "상품 이미지가 없습니다" },
    hasDescription ? { key: "description", status: "ok", detail: "표시 정상" } : { key: "description", status: "warn", detail: "상품 설명이 비어 있습니다" },
    { key: "price", status: "ok", detail: event?.active ? `정가 ${product.price.toLocaleString("ko-KR")}원 · 할인가 ${price.toLocaleString("ko-KR")}원` : `${product.price.toLocaleString("ko-KR")}원` },
    stock === 0 ? { key: "stock", status: "warn", detail: "재고가 없습니다" } : stock <= LOW_STOCK_MAX ? { key: "stock", status: "warn", detail: `재고 ${stock} · 방송 중에 품절될 수 있습니다` } : { key: "stock", status: "ok", detail: `재고 ${stock}` },
    categories.length > 0 ? { key: "categories", status: "ok", detail: categories.join(" · ") } : { key: "categories", status: "warn", detail: "카테고리가 지정되지 않았습니다" },
  ];

  return {
    shop: { slug: seller.slug, name: seller.shopName },
    product: {
      id: product.id,
      code: productCode(product.codeNo),
      name: product.name,
      description: product.description ?? "",
      status: product.status,
      price: product.price,
      event,
      stock,
      soldOut,
      // 구매자 화면 플래그: 판매 중·품절만 쇼핑몰에 보인다. 숨김·판매 대기는 보이지 않는다.
      visibleToBuyers: shown,
      images: images.map((i) => ({ id: i.id, url: i.url, width: i.width, height: i.height, isThumbnail: i.isThumbnail })),
      categories,
      options: product.options.map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta, stock: o.stock })),
      purchaseLimits: null,
    },
    earn: basic ? { gradeName: basic.displayName, card: rate?.card ?? 0, bankTransfer: rate?.bankTransfer ?? 0 } : null,
    checks,
    open: { canOpen: shown, path },
    share: {
      path,
      card: { title: product.name, price, imageUrl: thumb ? `/api/shop/${encodeURIComponent(seller.slug)}/products/${product.id}/images/${thumb.id}` : null },
    },
  };
}
