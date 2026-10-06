import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as hidePost } from "../../app/api/seller/reviews/[reviewId]/hide/route";
import { POST as publishPost } from "../../app/api/seller/reviews/[reviewId]/publish/route";
import { PUT as replyPut } from "../../app/api/seller/reviews/[reviewId]/reply/route";
import { GET as sellerDetailGet } from "../../app/api/seller/reviews/[reviewId]/route";
import { GET as sellerImageGet } from "../../app/api/seller/reviews/images/[imageId]/route";
import { GET as policyGet, PUT as policyPut } from "../../app/api/seller/reviews/policy/route";
import { GET as sellerList } from "../../app/api/seller/reviews/route";
import { GET as productReviewsGet } from "../../app/api/shop/[slug]/products/[productId]/reviews/route";
import { DELETE as reportDelete, POST as reportPost } from "../../app/api/shop/[slug]/reviews/[reviewId]/report/route";
import { DELETE as reviewDelete, GET as reviewGet, PUT as reviewPut } from "../../app/api/shop/[slug]/reviews/[reviewId]/route";
import { GET as myImageGet } from "../../app/api/shop/[slug]/reviews/images/[imageId]/route";
import { POST as imagePost } from "../../app/api/shop/[slug]/reviews/images/route";
import { GET as itemGet, POST as itemPost } from "../../app/api/shop/[slug]/reviews/items/[orderItemId]/route";
import { GET as publicImageGet } from "../../app/api/shop/[slug]/reviews/public-images/[imageId]/route";
import { GET as mineGet } from "../../app/api/shop/[slug]/reviews/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { refundOrder } from "../../lib/server/queue/service";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { hasImageMetadata } from "../../lib/server/product-reviews/image";
import { jpeg, webp } from "../unit/productImageFormatsFixtures";
import { fakeJpeg } from "../unit/reviewFixtures";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-048 리뷰 관리 · SH-029 리뷰 쓰기(2026-10-04 대표님 지시, MASTER 결정 A~F):
// 작성 자격(배송 완료·기간·결제 상태·본인)·주문 품목당 1개(동시)·자동 보류·공개 방식·리뷰 적립금 지급/회수·고치기 7일·신고 누적 보류·
// 권한·테넌트 격리·공개 목록·사진(메타데이터 제거·남의 사진)·잠긴 쇼핑몰·탈퇴.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const json = (path: string, method: string, cookie: string, body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (path: string, cookie?: string) => new Request(BASE + path, { headers: { ...H, ...(cookie ? { cookie } : {}) } });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const DAY = 86_400_000;
const BODY = "포장이 꼼꼼하고 카드 상태가 정말 좋았어요";

async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function buyerCookie(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

let orderNo = 0;
async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const csStaff = await createSellerUser(seller.id, { permissions: ["INQUIRY_REPLY"] });
  const other = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const buyer2 = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "스타라이트 부스터 박스", price: 30000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 50 } });
  // 결제·배송 완료된 주문 품목(배송 완료 시각은 daysAgo일 전)
  const delivered = async (buyerId = buyer.id, opts: { daysAgo?: number; status?: "PAID" | "REFUNDED"; deliveredAt?: Date | null } = {}) => {
    const order = await db.order.create({
      data: { sellerId: seller.id, orderNo: ++orderNo, buyerMemberId: buyerId, status: opts.status ?? "PAID", broadcastNicknameSnapshot: "닉", totalAmount: 30000, paidAt: new Date() },
    });
    const item = await db.orderItem.create({
      data: { sellerId: seller.id, orderId: order.id, productId: product.id, optionId: option.id, productNameSnapshot: product.name, optionNameSnapshot: option.name, unitPrice: 30000, quantity: 1 },
    });
    const at = opts.deliveredAt === undefined ? new Date(Date.now() - (opts.daysAgo ?? 1) * DAY) : opts.deliveredAt;
    await db.shipment.create({ data: { sellerId: seller.id, orderId: order.id, courier: "CJ", trackingNumber: "123456789012", status: at ? "DELIVERED" : "IN_TRANSIT", shippedAt: new Date(Date.now() - 40 * DAY), deliveredAt: at } });
    return item;
  };
  return {
    seller,
    slug: seller.slug,
    grade,
    buyer,
    buyer2,
    product,
    delivered,
    owner: await sellerCookie(owner.email),
    ctx: { sellerId: seller.id, actorType: "SELLER_USER" as const, actorId: owner.id, isOwner: true, permissions: [], readOnly: false },
    cs: await sellerCookie(csStaff.email),
    noPerm: await sellerCookie(other.email),
    b1: await buyerCookie(seller.id, buyer.loginId!),
    b2: await buyerCookie(seller.id, buyer2.loginId!),
  };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const write = (s: Shop, itemId: string, body: unknown, cookie = s.b1) => itemPost(json(`/x`, "POST", cookie, body), p({ slug: s.slug, orderItemId: itemId }));
const upload = (s: Shop, bytes: Buffer, cookie = s.b1) =>
  imagePost(new Request(BASE + "/x", { method: "POST", headers: { ...H, cookie }, body: new Uint8Array(bytes) }), p({ slug: s.slug }));
const setPolicy = (s: Shop, v: Record<string, unknown>) =>
  policyPut(json("/x", "PUT", s.owner, { publishMode: "IMMEDIATE", rewardText: 0, rewardPhoto: 0, writableDays: 30, bannedWords: [], ...v }));
async function created(s: Shop, itemId: string, body: unknown = { rating: 5, body: BODY }, cookie = s.b1) {
  const res = await write(s, itemId, body, cookie);
  const j = (await res.json()) as { reviewId: string; status: string; grantedReward: number; error?: string };
  return { res, ...j };
}
// 판매자 화면(목록·상세)과 구매자 화면(내 리뷰)이 보여 주는 리뷰 적립 금액
const sellerReward = async (s: Shop, id: string) => {
  const d = ((await (await sellerDetailGet(get("/x", s.owner), p({ reviewId: id }))).json()) as { review: { rewardedAmount: number; orderNoLabel: string } }).review;
  const l = (await (await sellerList(get("/x", s.owner))).json()) as { reviews: { id: string; rewardedAmount: number; orderNoLabel: string }[] };
  // 사람이 읽는 주문번호(「20261002-0409」)가 상세·목록에 모두 있다
  expect(d.orderNoLabel).toMatch(/^\d{8}-\d{4,}$/);
  expect(l.reviews.find((x) => x.id === id)?.orderNoLabel).toMatch(/^\d{8}-\d{4,}$/);
  return [d.rewardedAmount, l.reviews.find((x) => x.id === id)?.rewardedAmount];
};
const buyerReward = async (s: Shop, id: string, cookie = s.b1) => {
  const mine = (await (await mineGet(get("/x", cookie), p({ slug: s.slug }))).json()) as { reviews: { id: string; rewardedAmount: number }[]; writable: { orderNoLabel: string }[] };
  // 리뷰를 기다리는 상품에도 사람이 읽는 주문번호가 있다
  for (const w of mine.writable) expect(w.orderNoLabel).toMatch(/^\d{8}-\d{4,}$/);
  return mine.reviews.find((x) => x.id === id)?.rewardedAmount;
};
// 다른 트랜잭션이 행 잠금을 기다리기 시작할 때까지(최대 5초)
async function waitForLockWaiter() {
  for (let i = 0; i < 100; i++) {
    const [w] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (w.n > 0n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
// 트랜잭션 하나를 열어 body를 실행한 채 release()가 불릴 때까지 커밋하지 않는다
function holdTx(body: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (ready = r));
  const done = db.$transaction(async (tx) => {
    await body(tx);
    ready();
    await gate;
  }, { timeout: 20_000 });
  return { started, release, done };
}
const ledger = (s: Shop) => db.rewardLedger.findMany({ where: { sellerId: s.seller.id }, orderBy: { createdAt: "asc" } });

describe("작성 자격", () => {
  it("배송 완료 뒤 기간 안의 본인 결제 주문만 쓸 수 있다(배송 전·기간 지남·환불·남의 주문은 거절)", async () => {
    const s = await shop();
    const ok = await s.delivered();
    expect((await itemGet(get("/x", s.b1), p({ slug: s.slug, orderItemId: ok.id }))).status).toBe(200);
    for (const item of [await s.delivered(s.buyer.id, { deliveredAt: null }), await s.delivered(s.buyer.id, { daysAgo: 31 }), await s.delivered(s.buyer.id, { status: "REFUNDED" }), await s.delivered(s.buyer2.id)]) {
      const r = await write(s, item.id, { rating: 5, body: BODY });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe("not_writable");
    }
    // 작성 기간을 40일로 늘리면 31일 전 배송도 쓸 수 있다
    expect((await setPolicy(s, { writableDays: 40 })).status).toBe(200);
    const old = await s.delivered(s.buyer.id, { daysAgo: 31 });
    expect((await created(s, old.id)).res.status).toBe(201);
    expect(await db.productReview.count()).toBe(1);
  });

  it("주문 품목당 1개: 동시에 두 번 올려도 하나만 생기고 둘째는 409", async () => {
    const s = await shop();
    const item = await s.delivered();
    const rs = await Promise.all([write(s, item.id, { rating: 5, body: BODY }), write(s, item.id, { rating: 4, body: BODY })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.productReview.count()).toBe(1);
  });
});

describe("공개 방식·자동 보류·적립금", () => {
  it("바로 공개: 공개되면 사진 리뷰 적립금(실지급 꺼짐이면 testMode)을 지급하고, 숨기면 회수, 다시 공개하면 새 회차로 지급", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500, rewardPhoto: 1000 });
    const item = await s.delivered();
    const img = (await (await upload(s, fakeJpeg(800, 600))).json()) as { image: { id: string } };
    const r = await created(s, item.id, { rating: 5, body: BODY, imageIds: [img.image.id] });
    expect([r.res.status, r.status, r.grantedReward]).toEqual([201, "VISIBLE", 1000]);
    expect((await hidePost(json("/x", "POST", s.cs, { reason: "PRIVACY", note: "연락처" }), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect((await publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId }))).status).toBe(200);
    const l = await ledger(s);
    expect(l.map((x) => [x.type, x.amount, x.testMode, x.idempotencyKey])).toEqual([
      ["EARN", 1000, true, `review_reward:${r.reviewId}:1`],
      ["REVOKE", -1000, true, `review_revoke:${r.reviewId}:1`],
      ["EARN", 1000, true, `review_reward:${r.reviewId}:2`],
    ]);
    // 지우면 회수
    expect((await reviewDelete(json("/x", "DELETE", s.b1), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(200);
    expect((await ledger(s)).map((x) => x.amount)).toEqual([1000, -1000, 1000, -1000]);
    expect(await db.productReviewImage.count()).toBe(0);
  });

  it("회수의 testMode는 지금 설정이 아니라 원래 적립 원장을 따른다(양방향, Codex 4176709615)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const live = (on: boolean) => db.rewardPolicy.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, livePayoutEnabled: on }, update: { livePayoutEnabled: on } });
    // 시험 적립 → 실지급 켬 → 숨김: 회수도 시험(testMode=true)
    const a = await created(s, (await s.delivered()).id);
    await live(true);
    expect((await hidePost(json("/x", "POST", s.cs, { reason: "OTHER" }), p({ reviewId: a.reviewId }))).status).toBe(200);
    // 실지급 적립 → 실지급 끔 → 지우기: 회수도 실지급(testMode=false)
    const b = await created(s, (await s.delivered()).id);
    await live(false);
    expect((await reviewDelete(json("/x", "DELETE", s.b1), p({ slug: s.slug, reviewId: b.reviewId }))).status).toBe(200);
    const l = await ledger(s);
    const mode = (key: string) => l.find((x) => x.idempotencyKey === key)?.testMode;
    expect([mode(`review_reward:${a.reviewId}:1`), mode(`review_revoke:${a.reviewId}:1`)]).toEqual([true, true]);
    expect([mode(`review_reward:${b.reviewId}:1`), mode(`review_revoke:${b.reviewId}:1`)]).toEqual([false, false]);
  });

  it("적립 원장이 없으면 회수 원장을 만들지 않는다", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const r = await created(s, (await s.delivered()).id);
    await db.rewardLedger.deleteMany({ where: { sellerId: s.seller.id } });
    expect((await hidePost(json("/x", "POST", s.cs, { reason: "OTHER" }), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect(await ledger(s)).toEqual([]);
  });

  it("같은 사진으로 두 리뷰를 동시에 올리면 하나만 붙고, 사진 리뷰 적립은 한 번만(Codex 4176709627)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500, rewardPhoto: 1000 });
    const [i1, i2] = [await s.delivered(), await s.delivered()];
    const img = (await (await upload(s, fakeJpeg(800, 600))).json()) as { image: { id: string } };
    const rs = await Promise.all([i1, i2].map((i) => write(s, i.id, { rating: 5, body: BODY, imageIds: [img.image.id] })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await db.productReview.count()).toBe(1);
    expect((await ledger(s)).map((x) => [x.type, x.amount])).toEqual([["EARN", 1000]]);
  });

  it("탈퇴 회원의 리뷰를 공개하면 원하는 적립이 0이라 원장을 만들지 않고, 지급으로 기록하지 않으며 숨겨도 회수하지 않는다(Codex 4176768630)", async () => {
    const s = await shop();
    await setPolicy(s, { publishMode: "REVIEW", rewardText: 500 });
    const r = await created(s, (await s.delivered()).id);
    expect(r.status).toBe("PENDING");
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect((await publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect(await sellerReward(s, r.reviewId)).toEqual([0, 0]);
    const audit = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "review.publish", targetId: r.reviewId } });
    expect((audit.after as { grantedReward: number }).grantedReward).toBe(0);
    expect((await hidePost(json("/x", "POST", s.cs, { reason: "OTHER" }), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect(await ledger(s)).toEqual([]);
  });

  it("공개 리뷰의 대기 적립이 있는 회원이 탈퇴하면 리뷰 적립 금액은 원장대로 0이 된다(Codex 4176818122)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const r = await created(s, (await s.delivered()).id);
    expect(await sellerReward(s, r.reviewId)).toEqual([500, 500]);
    expect(await buyerReward(s, r.reviewId)).toBe(500);
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect(await sellerReward(s, r.reviewId)).toEqual([0, 0]);
    expect((await hidePost(json("/x", "POST", s.cs, { reason: "OTHER" }), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect((await ledger(s)).map((x) => [x.type, x.status])).toEqual([["EARN", "FAILED"]]);
  });

  it("리뷰 300개(유효 적립 300건)인 회원도 탈퇴가 집합 단위로 끝난다: 쿼리 수가 리뷰 수에 비례하지 않는다(Codex 4177188519)", async () => {
    const s = await shop();
    const n = 300;
    const base = 800000;
    await db.order.createMany({ data: Array.from({ length: n }, (_, i) => ({ sellerId: s.seller.id, orderNo: base + i, buyerMemberId: s.buyer.id, status: "PAID" as const, broadcastNicknameSnapshot: "닉", totalAmount: 30000, paidAt: new Date(), purchaseConfirmedAt: new Date() })) });
    const orders = await db.order.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id, orderNo: { gte: base } }, select: { id: true } });
    await db.shipment.createMany({ data: orders.map((o) => ({ sellerId: s.seller.id, orderId: o.id, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED" as const, shippedAt: new Date(Date.now() - 2 * DAY), deliveredAt: new Date(Date.now() - DAY) })) });
    const option = await db.productOption.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } });
    await db.orderItem.createMany({ data: orders.map((o) => ({ sellerId: s.seller.id, orderId: o.id, productId: s.product.id, optionId: option.id, productNameSnapshot: "상품", optionNameSnapshot: "옵션", unitPrice: 30000, quantity: 1 })) });
    const items = await db.orderItem.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id, orderId: { in: orders.map((o) => o.id) } }, select: { id: true, orderId: true } });
    await db.productReview.createMany({ data: items.map((it) => ({ sellerId: s.seller.id, orderId: it.orderId, orderItemId: it.id, productId: s.product.id, buyerMemberId: s.buyer.id, authorNickname: "닉", rating: 5, body: BODY, status: "VISIBLE" as const, rewardRound: 1 })) });
    const reviews = await db.productReview.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id }, select: { id: true, orderId: true } });
    await db.rewardLedger.createMany({ data: reviews.map((r, i) => ({ sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: r.orderId, type: "EARN" as const, amount: 500, testMode: true, status: i % 2 ? ("SUCCEEDED" as const) : ("PENDING" as const), idempotencyKey: `review_reward:${r.id}:1` })) });
    // 탈퇴 트랜잭션 안의 쿼리 수를 센다
    let calls = 0;
    const counting = new Proxy(db, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (k !== "$transaction") return typeof v === "function" ? v.bind(t) : v;
        return (fn: (tx: unknown) => unknown, opts?: unknown) =>
          t.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(x, kk, rr) {
                    const m = Reflect.get(x, kk, rr);
                    if (typeof m === "function") return (...a: unknown[]) => (calls++, (m as (...b: unknown[]) => unknown).apply(x, a));
                    if (m && typeof m === "object") return new Proxy(m, { get: (d, f) => { const g = Reflect.get(d, f); return typeof g === "function" ? (...a: unknown[]) => (calls++, g.apply(d, a)) : g; } });
                    return m;
                  },
                }),
              ) as Promise<unknown>,
            opts as never,
          );
      },
    }) as typeof db;
    expect(await withdrawBuyer(counting, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect(calls).toBeLessThan(100);
    const l = await db.rewardLedger.findMany({ where: { sellerId: s.seller.id, type: "REVOKE" } });
    // 대기 중이던 적립은 탈퇴가 실패로 닫았으니 회수할 것이 없고, 이미 지급된 150건만 회수 원장(탈퇴 회원이라 실패)이 생긴다
    expect([l.length, l.every((x) => x.status === "FAILED")]).toEqual([n / 2, true]);
    const d = ((await (await sellerDetailGet(get("/x", s.owner), p({ reviewId: reviews[1].id }))).json()) as { review: { rewardedAmount: number } }).review;
    expect(d.rewardedAmount).toBe(0);
  }, 60_000);

  it("이미 지급(SUCCEEDED)된 리뷰 적립이 있는 회원이 탈퇴해도 settleReward로 맞춰 화면 금액은 0", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const r = await created(s, (await s.delivered()).id);
    await db.rewardLedger.updateMany({ where: { sellerId: s.seller.id }, data: { status: "SUCCEEDED", processedAt: new Date() } });
    expect(await sellerReward(s, r.reviewId)).toEqual([500, 500]);
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect(await sellerReward(s, r.reviewId)).toEqual([0, 0]);
    expect((await ledger(s)).map((x) => [x.type, x.idempotencyKey])).toEqual([["EARN", `review_reward:${r.reviewId}:1`], ["REVOKE", `review_revoke:${r.reviewId}:1`]]);
  });

  it("리뷰에서 뗀 사진은 소진돼 다른 리뷰에 붙일 수 없고, 사진을 모두 떼면 글 리뷰 금액으로 조정된다(Codex 4176818118)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500, rewardPhoto: 1000 });
    const [i1, i2] = [await s.delivered(), await s.delivered()];
    const img = (await (await upload(s, fakeJpeg(800, 600))).json()) as { image: { id: string } };
    const r = await created(s, i1.id, { rating: 5, body: BODY, imageIds: [img.image.id] });
    expect(r.grantedReward).toBe(1000);
    expect((await reviewPut(json("/x", "PUT", s.b1, { rating: 5, body: BODY, imageIds: [] }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(200);
    expect(await db.productReviewImage.count({ where: { id: img.image.id } })).toBe(0);
    const again = await write(s, i2.id, { rating: 5, body: BODY, imageIds: [img.image.id] });
    expect([again.status, ((await again.json()) as { error: string }).error]).toEqual([400, "invalid_images"]);
    expect((await ledger(s)).map((x) => [x.type, x.amount, x.idempotencyKey])).toEqual([
      ["EARN", 1000, `review_reward:${r.reviewId}:1`],
      ["REVOKE", -1000, `review_revoke:${r.reviewId}:1`],
      ["EARN", 500, `review_reward:${r.reviewId}:2`],
    ]);
    expect(await sellerReward(s, r.reviewId)).toEqual([500, 500]);
    expect(await buyerReward(s, r.reviewId)).toBe(500);
  });

  it("글 리뷰에 첫 사진을 붙이면 같은 재조정으로 사진 리뷰 금액이 된다(회수 −500, 적립 1,000, Codex 4176882129)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500, rewardPhoto: 1000 });
    const r = await created(s, (await s.delivered()).id);
    expect(r.grantedReward).toBe(500);
    const img = (await (await upload(s, fakeJpeg(800, 600))).json()) as { image: { id: string } };
    expect((await reviewPut(json("/x", "PUT", s.b1, { rating: 5, body: BODY, imageIds: [img.image.id] }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(200);
    expect((await ledger(s)).map((x) => [x.type, x.amount])).toEqual([["EARN", 500], ["REVOKE", -500], ["EARN", 1000]]);
    expect(await sellerReward(s, r.reviewId)).toEqual([1000, 1000]);
    // 같은 자격으로 다시 고치면(사진 유지) 재조정하지 않는다
    expect((await reviewPut(json("/x", "PUT", s.b1, { rating: 4, body: BODY, imageIds: [img.image.id] }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(200);
    expect(await ledger(s)).toHaveLength(3);
  });

  it("적립금 기본값은 0원(끔)이라 공개돼도 원장을 만들지 않는다", async () => {
    const s = await shop();
    const r = await created(s, (await s.delivered()).id);
    expect([r.status, r.grantedReward]).toEqual(["VISIBLE", 0]);
    expect(await ledger(s)).toEqual([]);
  });

  it("연락처·금지어가 있으면 보류(적립금 없음), 확인 뒤 공개 쇼핑몰은 공개 대기. 공개하면 그때 지급", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500, bannedWords: ["사기"] });
    const held = await created(s, (await s.delivered()).id, { rating: 1, body: "사기 판매자예요 010-1234-5678로 연락 주세요" });
    expect([held.status, held.grantedReward]).toEqual(["HELD", 0]);
    await setPolicy(s, { publishMode: "REVIEW", rewardText: 500 });
    const pending = await created(s, (await s.delivered()).id);
    expect([pending.status, pending.grantedReward]).toEqual(["PENDING", 0]);
    const pub = await publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: pending.reviewId }));
    expect(((await pub.json()) as { grantedReward: number }).grantedReward).toBe(500);
    const list = (await (await sellerList(get("/api/seller/reviews?status=HELD", s.noPerm))).json()) as { reviews: { heldLabel: string }[]; summary: { autoHeld: number } };
    expect(list.reviews.map((x) => x.heldLabel)).toEqual(["연락처 패턴 감지 · 자동 보류"]);
    expect(list.summary.autoHeld).toBe(1);
  });
});

describe("고치기·지우기·신고", () => {
  it("7일 안에만 고치고(답글 유지), 숨긴 리뷰는 고칠 수 없다. 남의 리뷰는 404", async () => {
    const s = await shop();
    const r = await created(s, (await s.delivered()).id);
    await replyPut(json("/x", "PUT", s.owner, { reply: "감사합니다" }), p({ reviewId: r.reviewId }));
    const ok = await reviewPut(json("/x", "PUT", s.b1, { rating: 4, body: "다시 보니 모서리가 살짝 눌렸어요" }), p({ slug: s.slug, reviewId: r.reviewId }));
    expect(ok.status).toBe(200);
    const row = await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } });
    expect([row.rating, row.reply]).toEqual([4, "감사합니다"]);
    expect((await reviewPut(json("/x", "PUT", s.b2, { rating: 1, body: BODY }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(404);
    await db.productReview.update({ where: { id: r.reviewId }, data: { createdAt: new Date(Date.now() - 8 * DAY) } });
    expect((await reviewPut(json("/x", "PUT", s.b1, { rating: 5, body: BODY }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(409);
    const r2 = await created(s, (await s.delivered()).id);
    await hidePost(json("/x", "POST", s.owner, { reason: "ABUSE" }), p({ reviewId: r2.reviewId }));
    expect((await reviewPut(json("/x", "PUT", s.b1, { rating: 5, body: BODY }), p({ slug: s.slug, reviewId: r2.reviewId }))).status).toBe(409);
  });

  it("신고는 1인 1번·내 리뷰 제외, 3건이 쌓이면 보류되고 공개 목록에서 빠진다", async () => {
    const s = await shop();
    const r = await created(s, (await s.delivered()).id);
    expect((await reportPost(json("/x", "POST", s.b1, { reason: "AD" }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(400);
    expect((await reportPost(json("/x", "POST", s.b2, { reason: "AD" }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(201);
    expect((await reportPost(json("/x", "POST", s.b2, { reason: "AD" }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(409);
    for (let i = 0; i < 2; i++) {
      const m = await createLoginBuyer(s.seller.id, s.grade.id);
      const c = await buyerCookie(s.seller.id, m.loginId!);
      expect((await reportPost(json("/x", "POST", c, { reason: "OFF_TOPIC" }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(201);
    }
    const row = await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } });
    expect([row.status, row.heldBy, await db.productReviewReport.count({ where: { reviewId: r.reviewId, resolvedAt: null } })]).toEqual(["HELD", "reports", 3]);
    // 신고 누적 보류도 「자동 보류」 집계에 들어간다(Codex 4177247987)
    const sum = (await (await sellerList(get("/x", s.owner))).json()) as { summary: { autoHeld: number } };
    expect(sum.summary.autoHeld).toBe(1);
    const pub = (await (await productReviewsGet(get("/x"), p({ slug: s.slug, productId: s.product.id }))).json()) as { total: number; reviews: unknown[] };
    expect([pub.total, pub.reviews.length]).toEqual([0, 0]);
  });

  it("신고 철회: 내 신고만 철회돼 미확인 신고 수·사유 집계에서 빠지고, 리뷰 상태·적립은 그대로이며 다시 신고할 수 없다", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const r = await created(s, (await s.delivered()).id);
    const reporters: { cookie: string }[] = [];
    for (const reason of ["AD", "ABUSE", "OFF_TOPIC"]) {
      const m = await createLoginBuyer(s.seller.id, s.grade.id);
      const cookie = await buyerCookie(s.seller.id, m.loginId!);
      reporters.push({ cookie });
      await reportPost(json("/x", "POST", cookie, { reason }), p({ slug: s.slug, reviewId: r.reviewId }));
    }
    const del = (cookie: string) => reportDelete(json("/x", "DELETE", cookie), p({ slug: s.slug, reviewId: r.reviewId }));
    const detail = async () => ((await (await sellerDetailGet(get("/x", s.owner), p({ reviewId: r.reviewId }))).json()) as { review: { status: string; reportCount: number; reportReasons: Record<string, number> } }).review;
    // 3건으로 보류된 상태에서 한 명이 철회하면 수는 줄지만 보류·적립은 그대로(판매자가 공개할 때만 풀린다)
    expect((await detail()).status).toBe("HELD");
    const ledgerBefore = (await ledger(s)).map((x) => [x.type, x.amount]);
    const w = await del(reporters[0].cookie);
    expect([w.status, ((await w.json()) as { openReports: number }).openReports]).toEqual([200, 2]);
    const d = await detail();
    expect([d.status, d.reportCount, d.reportReasons]).toEqual(["HELD", 2, { ABUSE: 1, OFF_TOPIC: 1 }]);
    expect((await ledger(s)).map((x) => [x.type, x.amount])).toEqual(ledgerBefore);
    expect((await reviewPut(json("/x", "PUT", s.b1, { rating: 5, body: "신고 보류 중 글만 고쳐요. 카드 상태는 좋았어요" }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(200);
    expect((await detail()).status).toBe("HELD");
    // 철회는 한 번만(두 번째는 404), 신고하지 않은 사람은 철회할 것이 없다(404), 작성자도 마찬가지(404)
    expect((await del(reporters[0].cookie)).status).toBe(404);
    const stranger = await createLoginBuyer(s.seller.id, s.grade.id);
    expect((await del(await buyerCookie(s.seller.id, stranger.loginId!))).status).toBe(404);
    expect((await del(s.b1)).status).toBe(404);
    expect(await db.productReviewReport.count({ where: { reviewId: r.reviewId } })).toBe(3);
    // 판매자가 공개하면 그때 풀리고 적립이 다시 나간다. 공개로 확인 처리된 신고는 철회할 수 없다(404)
    expect((await publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect((await detail()).status).toBe("VISIBLE");
    expect((await ledger(s)).map((x) => x.amount)).toEqual([500, -500, 500]);
    expect((await del(reporters[1].cookie)).status).toBe(404);
  });

  it("공개 리뷰의 신고를 철회하면 신고 수가 줄고, 같은 사람이 다시 신고할 수 없다(409)", async () => {
    const s = await shop();
    const r = await created(s, (await s.delivered()).id);
    const rep1 = () => reportPost(json("/x", "POST", s.b2, { reason: "AD" }), p({ slug: s.slug, reviewId: r.reviewId }));
    expect((await rep1()).status).toBe(201);
    const w = await reportDelete(json("/x", "DELETE", s.b2), p({ slug: s.slug, reviewId: r.reviewId }));
    expect([w.status, ((await w.json()) as { openReports: number }).openReports]).toEqual([200, 0]);
    expect((await rep1()).status).toBe(409);
    const d = ((await (await sellerDetailGet(get("/x", s.owner), p({ reviewId: r.reviewId }))).json()) as { review: { status: string; reportCount: number } }).review;
    expect([d.status, d.reportCount]).toEqual(["VISIBLE", 0]);
  });

  it("판매자가 공개하면 옛 신고는 확인 처리돼, 새 신고 1건 뒤 신고 수와 사유 합계가 모두 1(Codex 4177057980)", async () => {
    const s = await shop();
    const r = await created(s, (await s.delivered()).id);
    const report = async (reason: string) => {
      const m = await createLoginBuyer(s.seller.id, s.grade.id);
      return reportPost(json("/x", "POST", await buyerCookie(s.seller.id, m.loginId!), { reason }), p({ slug: s.slug, reviewId: r.reviewId }));
    };
    for (const reason of ["AD", "AD", "ABUSE"]) await report(reason);
    expect((await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } })).status).toBe("HELD");
    expect((await publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect((await report("OFF_TOPIC")).status).toBe(201);
    const d = ((await (await sellerDetailGet(get("/x", s.owner), p({ reviewId: r.reviewId }))).json()) as { review: { status: string; reportCount: number; reportReasons: Record<string, number> } }).review;
    const sum = Object.values(d.reportReasons).reduce((a, b) => a + b, 0);
    expect([d.status, d.reportCount, sum, d.reportReasons]).toEqual(["VISIBLE", 1, 1, { OFF_TOPIC: 1 }]);
    const l = (await (await sellerList(get("/x", s.owner))).json()) as { reviews: { id: string; reportCount: number }[] };
    expect(l.reviews.find((x) => x.id === r.reviewId)?.reportCount).toBe(1);
    // 옛 신고 기록은 남는다
    expect(await db.productReviewReport.count({ where: { reviewId: r.reviewId } })).toBe(4);
  });

  it("신고 보류 뒤 신고자가 탈퇴해 미확인 신고가 줄어도, 작성자가 고쳐서 풀 수 없다(보류는 판매자만 품, MASTER 검수 ①)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const r = await created(s, (await s.delivered()).id);
    const reporters = [];
    for (let i = 0; i < 3; i++) {
      const m = await createLoginBuyer(s.seller.id, s.grade.id);
      reporters.push(m);
      await reportPost(json("/x", "POST", await buyerCookie(s.seller.id, m.loginId!), { reason: "AD" }), p({ slug: s.slug, reviewId: r.reviewId }));
    }
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: reporters[0].id }, { password: PASSWORD })).toEqual({ ok: true });
    expect(await db.productReviewReport.count({ where: { reviewId: r.reviewId, resolvedAt: null } })).toBe(3);
    expect((await reviewPut(json("/x", "PUT", s.b1, { rating: 4, body: BODY }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(200);
    const row = await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } });
    expect([row.status, row.heldBy]).toEqual(["HELD", "reports"]);
    // 처음 적립 500은 신고 보류 때 회수됐고, 고치기로 새 적립이 나가지 않는다
    expect((await ledger(s)).map((x) => [x.type, x.amount])).toEqual([["EARN", 500], ["REVOKE", -500]]);
  });

  it("신고로 보류된 리뷰는 금지어를 넣었다 빼도 판매자가 공개하기 전까지 보류로 남는다(Codex 4176768623)", async () => {
    const s = await shop();
    await setPolicy(s, { bannedWords: ["사기"] });
    const r = await created(s, (await s.delivered()).id);
    for (let i = 0; i < 3; i++) {
      const m = await createLoginBuyer(s.seller.id, s.grade.id);
      await reportPost(json("/x", "POST", await buyerCookie(s.seller.id, m.loginId!), { reason: "AD" }), p({ slug: s.slug, reviewId: r.reviewId }));
    }
    const edit = (body: string) => reviewPut(json("/x", "PUT", s.b1, { rating: 5, body }), p({ slug: s.slug, reviewId: r.reviewId }));
    const state = async () => {
      const row = await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } });
      return [row.status, row.heldBy];
    };
    expect(await state()).toEqual(["HELD", "reports"]);
    expect((await edit("사기 아니에요 카드 상태 정말 좋아요")).status).toBe(200);
    expect(await state()).toEqual(["HELD", "reports"]);
    expect((await edit(BODY)).status).toBe(200);
    expect(await state()).toEqual(["HELD", "reports"]);
    // 판매자가 확인해 공개하면 신고 수가 0이 되고, 그 뒤 고치기는 보통 규칙(금지어면 보류, 깨끗하면 공개)
    expect((await publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect(await db.productReviewReport.count({ where: { reviewId: r.reviewId, resolvedAt: null } })).toBe(0);
    await edit("사기 아니에요 카드 상태 정말 좋아요");
    expect(await state()).toEqual(["HELD", "banned_word"]);
    await edit(BODY);
    expect(await state()).toEqual(["VISIBLE", null]);
  });
});

describe("권한·테넌트·공개 목록", () => {
  it("답글·숨김·공개·설정은 대표자·구매자 문의 직원만, 다른 직원은 목록만(canEdit=false, 403)", async () => {
    const s = await shop();
    const r = await created(s, (await s.delivered()).id);
    const list = await sellerList(get("/api/seller/reviews", s.noPerm));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { canEdit: boolean }).canEdit).toBe(false);
    expect((await replyPut(json("/x", "PUT", s.noPerm, { reply: "x" }), p({ reviewId: r.reviewId }))).status).toBe(403);
    expect((await hidePost(json("/x", "POST", s.noPerm, { reason: "AD" }), p({ reviewId: r.reviewId }))).status).toBe(403);
    expect((await setPolicy({ ...s, owner: s.noPerm }, {})).status).toBe(403);
    expect((await policyGet(get("/x", s.noPerm))).status).toBe(200);
    expect((await replyPut(json("/x", "PUT", s.cs, { reply: "소중한 리뷰 감사합니다" }), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect((await db.auditLog.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id, action: { startsWith: "review." } } })).map((a) => a.action)).toEqual(["review.reply"]);
  });

  it("다른 쇼핑몰의 리뷰·사진은 404이고 바뀌지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const img = (await (await upload(a, fakeJpeg(400, 400))).json()) as { image: { id: string } };
    const r = await created(a, (await a.delivered()).id, { rating: 5, body: BODY, imageIds: [img.image.id] });
    expect((await hidePost(json("/x", "POST", b.owner, { reason: "AD" }), p({ reviewId: r.reviewId }))).status).toBe(404);
    expect((await sellerImageGet(get("/x", b.owner), p({ imageId: img.image.id }))).status).toBe(404);
    expect((await sellerImageGet(get("/x", a.owner), p({ imageId: img.image.id }))).status).toBe(200);
    // 남이 올린 사진은 내 리뷰에 붙일 수 없다
    const img2 = (await (await upload(a, fakeJpeg(400, 400), a.b2)).json()) as { image: { id: string } };
    const bad = await write(a, (await a.delivered()).id, { rating: 5, body: BODY, imageIds: [img2.image.id] });
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_images");
    expect((await myImageGet(get("/x", a.b1), p({ slug: a.slug, imageId: img2.image.id }))).status).toBe(404);
    expect((await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } })).status).toBe("VISIBLE");
  });

  it("공개 목록은 공개 리뷰만(평균·분포), 숨긴 리뷰의 사진은 바로 404", async () => {
    const s = await shop();
    const img = (await (await upload(s, fakeJpeg(400, 400))).json()) as { image: { id: string } };
    const r1 = await created(s, (await s.delivered()).id, { rating: 5, body: BODY, imageIds: [img.image.id] });
    await created(s, (await s.delivered()).id, { rating: 3, body: BODY });
    const pub = (await (await productReviewsGet(get("/x"), p({ slug: s.slug, productId: s.product.id }))).json()) as {
      average: number;
      total: number;
      reviews: { images: { url: string }[] }[];
    };
    expect([pub.average, pub.total]).toEqual([4, 2]);
    expect((await publicImageGet(get("/x"), p({ slug: s.slug, imageId: img.image.id }))).status).toBe(200);
    await hidePost(json("/x", "POST", s.owner, { reason: "OTHER" }), p({ reviewId: r1.reviewId }));
    expect((await publicImageGet(get("/x"), p({ slug: s.slug, imageId: img.image.id }))).status).toBe(404);
    const after = (await (await productReviewsGet(get("/x"), p({ slug: s.slug, productId: s.product.id }))).json()) as { average: number; total: number };
    expect([after.average, after.total]).toEqual([3, 1]);
  });
});

describe("잠금 순서(주문 → 회원 → 리뷰 → 원장)", () => {
  it("구매 확정 주문의 리뷰 쓰기(주문 → 회원)와 그 회원의 탈퇴가 겹쳐도 교착·500이 없다: 탈퇴도 주문을 회원보다 먼저 잠근다(Codex 4177123328)", async () => {
    const s = await shop();
    const item = await s.delivered();
    await db.order.update({ where: { id: item.orderId }, data: { purchaseConfirmedAt: new Date() } });
    const r = await created(s, item.id);
    let go!: () => void;
    let locked!: () => void;
    const proceed = new Promise<void>((res) => (go = res));
    const orderLocked = new Promise<void>((res) => (locked = res));
    // 리뷰 쓰기와 같은 순서: 주문 FOR SHARE → (탈퇴가 기다리기 시작한 뒤) 작성자 회원 FOR SHARE → 리뷰 FOR UPDATE
    const review = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${item.orderId}::uuid FOR SHARE`;
      locked();
      await proceed;
      await tx.$queryRaw`SELECT "id" FROM "BuyerMember" WHERE "id" = ${s.buyer.id}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "ProductReview" WHERE "id" = ${r.reviewId}::uuid FOR UPDATE`;
    }, { timeout: 20_000 });
    await orderLocked;
    const withdrawing = withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD });
    await waitForLockWaiter();
    go();
    await review;
    expect(await withdrawing).toEqual({ ok: true });
    expect((await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } })).authorNickname).toBe("탈퇴 회원");
  });

  it("리뷰 고치기와 탈퇴를 실제로 동시에 해도 500·교착이 없다", async () => {
    const s = await shop();
    const item = await s.delivered();
    await db.order.update({ where: { id: item.orderId }, data: { purchaseConfirmedAt: new Date() } });
    const r = await created(s, item.id);
    const [ed, wd] = await Promise.allSettled([
      reviewPut(json("/x", "PUT", s.b1, { rating: 4, body: BODY }), p({ slug: s.slug, reviewId: r.reviewId })),
      withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD }),
    ]);
    expect(wd).toEqual({ status: "fulfilled", value: { ok: true } });
    expect(ed.status).toBe("fulfilled");
    if (ed.status === "fulfilled") expect(ed.value.status).not.toBe(500);
  });

  it("환불이 주문을 바꾸는 중이면 리뷰 작성은 기다렸다가 환불된 주문으로 보고 거절한다(리뷰·적립 없음, Codex 4176882125)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const item = await s.delivered();
    const refund = holdTx(async (tx) => {
      await tx.order.update({ where: { id: item.orderId }, data: { status: "REFUNDED", refundedAt: new Date() } });
    });
    await refund.started;
    const writing = write(s, item.id, { rating: 5, body: BODY });
    await waitForLockWaiter();
    refund.release();
    await refund.done;
    const r = await writing;
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([403, "not_writable"]);
    expect(await db.productReview.count()).toBe(0);
    expect(await ledger(s)).toEqual([]);
  });

  it("공개와 탈퇴가 겹쳐도 교착 없이 끝난다: 공개는 회원 잠금을 먼저 기다리고, 탈퇴 쪽 리뷰 갱신은 막히지 않는다(Codex 4176882128)", async () => {
    const s = await shop();
    await setPolicy(s, { publishMode: "REVIEW", rewardText: 500 });
    const r = await created(s, (await s.delivered()).id);
    expect(r.status).toBe("PENDING");
    // 탈퇴와 같은 순서: 회원 행 NO KEY UPDATE → (공개가 기다리기 시작한 뒤) 그 회원의 리뷰 행 갱신
    let go!: () => void;
    let locked!: () => void;
    const proceed = new Promise<void>((r) => (go = r));
    const memberLocked = new Promise<void>((r) => (locked = r));
    const withdraw = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "BuyerMember" WHERE "id" = ${s.buyer.id}::uuid FOR NO KEY UPDATE`;
      locked();
      await proceed;
      await tx.productReview.updateMany({ where: { buyerMemberId: s.buyer.id }, data: { authorNickname: "탈퇴 회원" } });
    }, { timeout: 20_000 });
    await memberLocked;
    const publishing = publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId }));
    await waitForLockWaiter();
    go();
    await withdraw;
    expect((await publishing).status).toBe(200);
  });

  it("공개와 실제 탈퇴(withdrawBuyer)를 동시에 해도 500·교착이 없다", async () => {
    const s = await shop();
    await setPolicy(s, { publishMode: "REVIEW", rewardText: 500 });
    const r = await created(s, (await s.delivered()).id);
    const [pub, wd] = await Promise.all([
      publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId })),
      withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD }),
    ]);
    expect([pub.status, wd]).toEqual([200, { ok: true }]);
    expect((await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } })).authorNickname).toBe("탈퇴 회원");
  });
});

describe("환불과 리뷰 적립", () => {
  const refund = async (s: Shop, orderId: string) =>
    refundOrder(db, s.ctx, orderId, { reason: "불량", fault: "SELLER", expectedLiveVersion: (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion });

  it("리뷰를 쓴 뒤 환불하면(회수 방식 AUTO) 리뷰 적립도 회수 원장이 생기고, 화면 금액은 0", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const item = await s.delivered();
    const r = await created(s, item.id);
    expect((await refund(s, item.orderId)).ok).toBe(true);
    expect((await ledger(s)).map((x) => [x.type, x.amount, x.idempotencyKey])).toEqual([
      ["EARN", 500, `review_reward:${r.reviewId}:1`],
      ["REVOKE", -500, `review_revoke:${r.reviewId}:1`],
    ]);
    expect(await sellerReward(s, r.reviewId)).toEqual([0, 0]);
  });

  it("회수 방식이 MANUAL이면 주문 적립처럼 회수 원장을 만들지 않고 수동 확인 대상으로 남는다", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    await db.rewardPolicy.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, revokeMode: "MANUAL" }, update: { revokeMode: "MANUAL" } });
    const item = await s.delivered();
    await created(s, item.id);
    expect((await refund(s, item.orderId)).ok).toBe(true);
    expect((await ledger(s)).map((x) => x.type)).toEqual(["EARN"]);
  });

  it("환불 결과와 로그 추적에 리뷰 적립 회수가 드러난다: AUTO는 revoked와 금액, MANUAL은 manual_review와 회수할 금액(MASTER 검수 ②)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const a = await s.delivered();
    await created(s, a.id);
    const ra = await refund(s, a.orderId);
    expect(ra.ok && ra.value.reviewRewardRevoke).toEqual({ outcome: "revoked", amount: 500 });
    await db.rewardPolicy.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, revokeMode: "MANUAL" }, update: { revokeMode: "MANUAL" } });
    const b = await s.delivered();
    await created(s, b.id);
    const rb = await refund(s, b.orderId);
    expect(rb.ok && rb.value.reviewRewardRevoke).toEqual({ outcome: "manual_review", amount: 500 });
    const audit = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "order.refund", targetId: b.orderId } });
    expect((audit.after as { reviewRewardRevoke: unknown }).reviewRewardRevoke).toEqual({ outcome: "manual_review", amount: 500 });
    // SA-048 목록·상세에 「적립금 수동 회수 필요」 금액이 나온다(자동 회수된 건은 0)
    const lst = (await (await sellerList(get("/x", s.owner))).json()) as { reviews: { id: string; revokePending: number }[] };
    const mine = await db.productReview.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { orderId: b.orderId } });
    expect(lst.reviews.find((x) => x.id === mine.id)?.revokePending).toBe(500);
    expect(lst.reviews.filter((x) => x.id !== mine.id).every((x) => x.revokePending === 0)).toBe(true);
    const det = ((await (await sellerDetailGet(get("/x", s.owner), p({ reviewId: mine.id }))).json()) as { review: { revokePending: number } }).review;
    expect(det.revokePending).toBe(500);
    const c = await s.delivered();
    const rc = await refund(s, c.orderId);
    expect(rc.ok && rc.value.reviewRewardRevoke).toEqual({ outcome: "none", amount: 0 });
  });

  it("MANUAL로 환불된 주문의 리뷰를 구매자가 고쳐도 리뷰 적립을 자동 회수하지 않는다(수동 확인 대상 유지, Codex 4177247985)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    await db.rewardPolicy.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, revokeMode: "MANUAL" }, update: { revokeMode: "MANUAL" } });
    const item = await s.delivered();
    const r = await created(s, item.id);
    expect((await refund(s, item.orderId)).ok).toBe(true);
    expect((await reviewPut(json("/x", "PUT", s.b1, { rating: 3, body: "별점만 바꿔요. 카드 상태는 좋았어요" }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(200);
    expect((await ledger(s)).map((x) => x.type)).toEqual(["EARN"]);
    // 리뷰 쪽 사유(숨김)는 그 사유로 회수한다
    expect((await hidePost(json("/x", "POST", s.cs, { reason: "OTHER" }), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect((await ledger(s)).map((x) => x.type)).toEqual(["EARN", "REVOKE"]);
  });

  it("공개와 환불을 동시에 해도 교착·500 없이 끝나고, 환불된 주문의 리뷰에는 유효한 적립이 남지 않는다", async () => {
    const s = await shop();
    await setPolicy(s, { publishMode: "REVIEW", rewardText: 500 });
    const item = await s.delivered();
    const r = await created(s, item.id);
    const [pub, ref] = await Promise.all([publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId })), refund(s, item.orderId)]);
    expect([pub.status, ref.ok]).toEqual([200, true]);
    expect(await sellerReward(s, r.reviewId)).toEqual([0, 0]);
  });
});

describe("적립은 settleReward 하나로(원하는 상태와 원장을 맞춤, Codex 4176954752)", () => {
  const edit = (s: Shop, id: string, body: string, imageIds: string[] = []) => reviewPut(json("/x", "PUT", s.b1, { rating: 5, body, imageIds }), p({ slug: s.slug, reviewId: id }));
  const amounts = async (s: Shop) => (await ledger(s)).map((x) => x.amount);

  it("글 리뷰 적립 → 첫 사진과 금지어를 함께 넣어 보류 → 공개하면 사진 금액", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500, rewardPhoto: 1000, bannedWords: ["사기"] });
    const r = await created(s, (await s.delivered()).id);
    const img = (await (await upload(s, fakeJpeg(800, 600))).json()) as { image: { id: string } };
    expect((await edit(s, r.reviewId, "사기 아니에요 카드 상태 정말 좋아요", [img.image.id])).status).toBe(200);
    expect((await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } })).status).toBe("HELD");
    expect(await amounts(s)).toEqual([500, -500]);
    expect((await publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect(await amounts(s)).toEqual([500, -500, 1000]);
    expect(await sellerReward(s, r.reviewId)).toEqual([1000, 1000]);
  });

  it("신고로 보류된 사진 리뷰에서 사진을 떼고 공개하면 글 금액", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500, rewardPhoto: 1000 });
    const img = (await (await upload(s, fakeJpeg(800, 600))).json()) as { image: { id: string } };
    const r = await created(s, (await s.delivered()).id, { rating: 5, body: BODY, imageIds: [img.image.id] });
    for (let i = 0; i < 3; i++) {
      const m = await createLoginBuyer(s.seller.id, s.grade.id);
      await reportPost(json("/x", "POST", await buyerCookie(s.seller.id, m.loginId!), { reason: "AD" }), p({ slug: s.slug, reviewId: r.reviewId }));
    }
    expect(await amounts(s)).toEqual([1000, -1000]);
    expect((await edit(s, r.reviewId, BODY)).status).toBe(200);
    expect(await amounts(s)).toEqual([1000, -1000]);
    expect((await publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId }))).status).toBe(200);
    expect(await amounts(s)).toEqual([1000, -1000, 500]);
  });

  it("설정을 바꾼 뒤 별점·본문만 고치면 이미 준 적립을 그대로 두고, 사진 자격이 바뀔 때만 새 설정으로 맞춘다(Codex 4177188513)", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500, rewardPhoto: 1000 });
    const r = await created(s, (await s.delivered()).id);
    expect(r.grantedReward).toBe(500);
    await setPolicy(s, { rewardText: 0, rewardPhoto: 300 });
    expect((await edit(s, r.reviewId, "별점만 바꿔요. 카드 상태는 좋았어요", [])).status).toBe(200);
    expect(await amounts(s)).toEqual([500]);
    expect(await sellerReward(s, r.reviewId)).toEqual([500, 500]);
    // 사진을 붙여 자격이 바뀌면 지금 설정(사진 300)으로
    const img = (await (await upload(s, fakeJpeg(800, 600))).json()) as { image: { id: string } };
    expect((await edit(s, r.reviewId, BODY, [img.image.id])).status).toBe(200);
    expect(await amounts(s)).toEqual([500, -500, 300]);
    // 다시 설정을 바꾸고 사진 그대로 고치면 300 유지
    await setPolicy(s, { rewardText: 0, rewardPhoto: 2000 });
    expect((await edit(s, r.reviewId, "사진은 그대로 두고 글만 고쳐요", [img.image.id])).status).toBe(200);
    expect(await amounts(s)).toEqual([500, -500, 300]);
  });

  it("적립이 없던 리뷰는 설정을 올린 뒤 별점·본문만 고쳐도 새로 지급하지 않는다(고치기는 적립 상태를 바꾸지 않음)", async () => {
    const s = await shop();
    const r = await created(s, (await s.delivered()).id);
    await setPolicy(s, { rewardText: 500 });
    expect((await edit(s, r.reviewId, "별점과 글만 고쳐요. 카드 상태는 좋았어요", [])).status).toBe(200);
    expect(await amounts(s)).toEqual([]);
  });

  it("같은 상태로 여러 번 바꿔도(같은 내용 고치기·두 번 공개·두 번 숨김) 원장은 바뀌지 않는다", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500 });
    const r = await created(s, (await s.delivered()).id);
    await edit(s, r.reviewId, BODY);
    await edit(s, r.reviewId, BODY);
    await publishPost(json("/x", "POST", s.owner, {}), p({ reviewId: r.reviewId }));
    expect(await amounts(s)).toEqual([500]);
    await hidePost(json("/x", "POST", s.cs, { reason: "OTHER" }), p({ reviewId: r.reviewId }));
    await hidePost(json("/x", "POST", s.cs, { reason: "OTHER" }), p({ reviewId: r.reviewId }));
    expect(await amounts(s)).toEqual([500, -500]);
  });
});

describe("지우기는 묘비로(주문 상품 1개당 1번, Codex 4176954756)", () => {
  it("지운 리뷰는 목록·집계·공개에서 빠지고, 같은 주문 상품에는 다시 쓸 수 없다", async () => {
    const s = await shop();
    await setPolicy(s, { rewardText: 500, rewardPhoto: 500 });
    const item = await s.delivered();
    const img = (await (await upload(s, fakeJpeg(800, 600))).json()) as { image: { id: string } };
    const r = await created(s, item.id, { rating: 5, body: BODY, imageIds: [img.image.id] });
    expect((await reviewDelete(json("/x", "DELETE", s.b1), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(200);
    const row = await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } });
    expect([row.deletedAt !== null, row.body]).toEqual([true, ""]);
    expect(await db.productReviewImage.count()).toBe(0);
    expect(await amounts(s)).toEqual([500, -500]);
    const again = await write(s, item.id, { rating: 4, body: BODY });
    expect([again.status, ((await again.json()) as { error: string }).error]).toEqual([409, "already_written"]);
    const mine = (await (await mineGet(get("/x", s.b1), p({ slug: s.slug }))).json()) as { writable: unknown[]; reviews: unknown[] };
    expect([mine.writable.length, mine.reviews.length]).toEqual([0, 0]);
    const list = (await (await sellerList(get("/x", s.owner))).json()) as { reviews: unknown[]; summary: { total: number; weekNew: number } };
    expect([list.reviews.length, list.summary.total, list.summary.weekNew]).toEqual([0, 0, 0]);
    expect((await sellerDetailGet(get("/x", s.owner), p({ reviewId: r.reviewId }))).status).toBe(404);
    const pub = (await (await productReviewsGet(get("/x"), p({ slug: s.slug, productId: s.product.id }))).json()) as { total: number };
    expect(pub.total).toBe(0);
    expect((await reviewDelete(json("/x", "DELETE", s.b1), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(404);
  });
  const amounts = async (s: Shop) => (await ledger(s)).map((x) => x.amount);
});

describe("내 리뷰 목록 쪽 나눔(Codex 4176954762)", () => {
  it("리뷰를 기다리는 상품 101개·내가 쓴 리뷰 101개를 커서로 빠짐없이 모두 읽는다", async () => {
    const s = await shop();
    const items = [];
    for (let i = 0; i < 101; i++) items.push(await s.delivered());
    const readAll = async (key: "writable" | "reviews") => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q = cursor ? `?${key === "writable" ? "writableCursor" : "cursor"}=${cursor}` : "";
        const d = (await (await mineGet(get(`/x${q}`, s.b1), p({ slug: s.slug }))).json()) as {
          writable: { orderItemId: string }[];
          reviews: { id: string }[];
          nextCursor: string | null;
          writableNextCursor: string | null;
        };
        seen.push(...(key === "writable" ? d.writable.map((w) => w.orderItemId) : d.reviews.map((r) => r.id)));
        cursor = key === "writable" ? d.writableNextCursor : d.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      return { seen, pages };
    };
    const w = await readAll("writable");
    expect([w.seen.length, new Set(w.seen).size, w.pages]).toEqual([101, 101, 3]);
    await db.productReview.createMany({
      data: items.map((it, i) => ({
        sellerId: s.seller.id, orderId: it.orderId, orderItemId: it.id, productId: s.product.id, buyerMemberId: s.buyer.id,
        authorNickname: "닉", rating: 5, body: BODY, status: "VISIBLE" as const, createdAt: new Date(Date.now() - (i % 7) * 1000),
      })),
    });
    const r = await readAll("reviews");
    expect([r.seen.length, new Set(r.seen).size, r.pages]).toEqual([101, 101, 3]);
  });
});

describe("고치기 화면은 id로 직접 읽는다(Codex 4177019076)", () => {
  it("내 리뷰가 51개를 넘어도 가장 오래된 리뷰를 단건 조회로 열 수 있고(editable은 서버 판정), 남의 리뷰·지운 리뷰는 404", async () => {
    const s = await shop();
    const items = [];
    for (let i = 0; i < 55; i++) items.push(await s.delivered());
    await db.productReview.createMany({
      data: items.map((it, i) => ({
        sellerId: s.seller.id, orderId: it.orderId, orderItemId: it.id, productId: s.product.id, buyerMemberId: s.buyer.id,
        authorNickname: "닉", rating: 4, body: BODY, status: "VISIBLE" as const, createdAt: new Date(Date.now() - (i + 1) * 60_000),
      })),
    });
    const oldest = await db.productReview.findFirstOrThrow({ where: { sellerId: s.seller.id }, orderBy: { createdAt: "asc" } });
    const first = (await (await mineGet(get("/x", s.b1), p({ slug: s.slug }))).json()) as { reviews: { id: string }[] };
    expect(first.reviews.some((r) => r.id === oldest.id)).toBe(false);
    const res = await reviewGet(get("/x", s.b1), p({ slug: s.slug, reviewId: oldest.id }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { review: { id: string; editable: boolean } }).review).toMatchObject({ id: oldest.id, editable: true });
    expect((await reviewGet(get("/x", s.b2), p({ slug: s.slug, reviewId: oldest.id }))).status).toBe(404);
    await db.productReview.update({ where: { id: oldest.id }, data: { createdAt: new Date(Date.now() - 8 * DAY) } });
    expect(((await (await reviewGet(get("/x", s.b1), p({ slug: s.slug, reviewId: oldest.id }))).json()) as { review: { editable: boolean } }).review.editable).toBe(false);
    expect((await reviewDelete(json("/x", "DELETE", s.b1), p({ slug: s.slug, reviewId: oldest.id }))).status).toBe(200);
    expect((await reviewGet(get("/x", s.b1), p({ slug: s.slug, reviewId: oldest.id }))).status).toBe(404);
  });
});

describe("공개 범위", () => {
  it("매장에 보이지 않는 상품(숨김·임시 저장·삭제)의 공개 리뷰 목록과 사진은 404(Codex 4176768626)", async () => {
    const s = await shop();
    const img = (await (await upload(s, fakeJpeg(800, 600))).json()) as { image: { id: string } };
    await created(s, (await s.delivered()).id, { rating: 5, body: BODY, imageIds: [img.image.id] });
    const list = () => productReviewsGet(get("/x"), p({ slug: s.slug, productId: s.product.id }));
    const photo = () => publicImageGet(get("/x"), p({ slug: s.slug, imageId: img.image.id }));
    expect([(await list()).status, (await photo()).status]).toEqual([200, 200]);
    for (const data of [{ status: "HIDDEN" as const }, { status: "DRAFT" as const }, { status: "ON_SALE" as const, deletedAt: new Date() }]) {
      await db.product.update({ where: { id: s.product.id }, data: { deletedAt: null, ...data } });
      expect([(await list()).status, (await photo()).status]).toEqual([404, 404]);
    }
    await db.product.update({ where: { id: s.product.id }, data: { status: "SOLD_OUT", deletedAt: null } });
    expect([(await list()).status, (await photo()).status]).toEqual([200, 200]);
  });
});

describe("사진·잠긴 쇼핑몰·탈퇴", () => {
  it("올린 사진은 EXIF(위치 정보)가 지워진 채 저장되고, 붙지 않은 사진은 회원당 10장까지만 남는다", async () => {
    const s = await shop();
    const res = await upload(s, fakeJpeg(1200, 900, true));
    expect(res.status).toBe(201);
    const { image } = (await res.json()) as { image: { id: string } };
    const row = await db.productReviewImage.findUniqueOrThrow({ where: { id: image.id } });
    expect(hasImageMetadata(Buffer.from(row.data))).toBe(false);
    const served = Buffer.from(await (await myImageGet(get("/x", s.b1), p({ slug: s.slug, imageId: image.id }))).arrayBuffer());
    expect(hasImageMetadata(served)).toBe(false);
    for (let i = 0; i < 11; i++) await upload(s, fakeJpeg(100 + i, 100));
    expect(await db.productReviewImage.count({ where: { buyerMemberId: s.buyer.id, reviewId: null } })).toBe(10);
    expect((await upload(s, Buffer.from("not an image"))).status).toBe(400);
  });

  it("휴대폰 사진: GPS EXIF가 든 JPG(1MB 넘음)와 WEBP는 올라가고 저장본에 EXIF가 없다. 5MB를 넘으면 413, 지원하지 않는 형식은 400", async () => {
    const s = await shop();
    const big = jpeg(3000, 2000, { exif: true, comment: true, xmp: true, trailer: Buffer.alloc(2 * 1024 * 1024, 7) });
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const r1 = await upload(s, big);
    expect(r1.status).toBe(201);
    const id1 = ((await r1.json()) as { image: { id: string } }).image.id;
    const row1 = await db.productReviewImage.findUniqueOrThrow({ where: { id: id1 } });
    expect([row1.contentType, row1.width, row1.height]).toEqual(["image/jpeg", 3000, 2000]);
    expect(hasImageMetadata(Buffer.from(row1.data))).toBe(false);
    expect(Buffer.from(row1.data).includes(Buffer.from("GPSLatitude"))).toBe(false);
    const r2 = await upload(s, webp(800, 600, { exif: true }));
    expect(r2.status).toBe(201);
    const id2 = ((await r2.json()) as { image: { id: string } }).image.id;
    const row2 = await db.productReviewImage.findUniqueOrThrow({ where: { id: id2 } });
    expect([row2.contentType, hasImageMetadata(Buffer.from(row2.data))]).toEqual(["image/webp", false]);
    const served = await myImageGet(get("/x", s.b1), p({ slug: s.slug, imageId: id2 }));
    expect(served.headers.get("content-type")).toBe("image/webp");
    // 5MB 초과는 끝까지 받지 않고 413, 다른 형식(GIF)은 400
    expect((await upload(s, Buffer.alloc(5 * 1024 * 1024 + 1, 1))).status).toBe(413);
    expect((await upload(s, Buffer.from("GIF89a" + "x".repeat(200)))).status).toBe(400);
    // 올린 사진은 리뷰에 붙여 쓸 수 있다
    const w = await created(s, (await s.delivered()).id, { rating: 5, body: BODY, imageIds: [id1, id2] });
    expect(w.res.status).toBe(201);
  });

  it("이용이 막힌 쇼핑몰은 쓰기·고치기·지우기·사진·신고 402(Codex 4176709637), 내 리뷰는 읽을 수 있다", async () => {
    const s = await shop();
    const r = await created(s, (await s.delivered()).id);
    const item = await s.delivered();
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date(Date.now() - DAY) } });
    expect((await write(s, item.id, { rating: 5, body: BODY })).status).toBe(402);
    expect((await upload(s, fakeJpeg(100, 100))).status).toBe(402);
    expect((await reportPost(json("/x", "POST", s.b2, { reason: "AD" }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(402);
    expect((await reviewPut(json("/x", "PUT", s.b1, { rating: 1, body: "고친 리뷰 본문이에요 열 글자 넘게" }), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(402);
    expect((await reviewDelete(json("/x", "DELETE", s.b1), p({ slug: s.slug, reviewId: r.reviewId }))).status).toBe(402);
    expect(await db.productReview.findUnique({ where: { id: r.reviewId }, select: { rating: true, body: true } })).toEqual({ rating: 5, body: BODY });
    const mine = await mineGet(get("/x", s.b1), p({ slug: s.slug }));
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { reviews: unknown[] }).reviews).toHaveLength(1);
  });

  it("탈퇴: 리뷰는 남기고 작성자 표시를 「탈퇴 회원」으로, 붙지 않은 사진은 지우고 신고 기록은 남긴다", async () => {
    const s = await shop();
    const r = await created(s, (await s.delivered()).id);
    const other = await created(s, (await s.delivered(s.buyer2.id)).id, { rating: 4, body: BODY }, s.b2);
    await reportPost(json("/x", "POST", s.b1, { reason: "AD" }), p({ slug: s.slug, reviewId: other.reviewId }));
    await upload(s, fakeJpeg(100, 100));
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect((await db.productReview.findUniqueOrThrow({ where: { id: r.reviewId } })).authorNickname).toBe("탈퇴 회원");
    expect(await db.productReviewReport.count({ where: { buyerMemberId: s.buyer.id } })).toBe(1);
    expect(await db.productReviewImage.count({ where: { buyerMemberId: s.buyer.id, reviewId: null } })).toBe(0);
    const audit = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.withdraw", actorId: s.buyer.id } });
    expect((audit.after as { reviews: { reviews: number } }).reviews.reviews).toBe(1);
  });
});

describe("공개 옵션(SH-029 닉네임 공개 · 개봉 결과 함께 보여 주기)", () => {
  const publicList = async (s: Shop) =>
    ((await (await productReviewsGet(get("/x"), p({ slug: s.slug, productId: s.product.id }))).json()) as { reviews: { id: string; author: string; showOpeningResult: boolean }[] }).reviews;

  it("보내지 않으면 닉네임 공개·개봉 결과 숨김이 기본이고, 보내면 저장해 내 리뷰·공개 목록에 반영한다", async () => {
    const s = await shop();
    const a = await created(s, (await s.delivered()).id);
    expect(a.res.status).toBe(201);
    expect(await publicList(s)).toEqual([expect.objectContaining({ id: a.reviewId, author: s.buyer.broadcastNickname, showOpeningResult: false })]);
    const b = await created(s, (await s.delivered(s.buyer2.id)).id, { rating: 4, body: BODY, showNickname: false, showOpeningResult: true }, s.b2);
    expect(b.res.status).toBe(201);
    const list = await publicList(s);
    expect(list.find((r) => r.id === b.reviewId)).toMatchObject({ author: "구매자", showOpeningResult: true });
    // 판매자 화면은 실제 닉네임을 그대로 본다
    const seller = (await (await sellerDetailGet(get("/x", s.owner), p({ reviewId: b.reviewId }))).json()) as { review: { author: string } };
    expect(seller.review.author).toBe(s.buyer2.broadcastNickname);
    const mine = (await (await mineGet(get("/x", s.b2), p({ slug: s.slug }))).json()) as { reviews: { id: string; showNickname: boolean; showOpeningResult: boolean }[] };
    expect(mine.reviews[0]).toMatchObject({ id: b.reviewId, showNickname: false, showOpeningResult: true });
  });

  it("고칠 때 보낸 옵션만 바꾸고 안 보내면 지금 값을 유지하며, 불리언이 아니면 400", async () => {
    const s = await shop();
    const a = await created(s, (await s.delivered()).id, { rating: 5, body: BODY, showNickname: false, showOpeningResult: true });
    const upd = (body: unknown) => reviewPut(json("/x", "PUT", s.b1, body), p({ slug: s.slug, reviewId: a.reviewId }));
    expect((await upd({ rating: 5, body: BODY })).status).toBe(200);
    expect(await db.productReview.findUniqueOrThrow({ where: { id: a.reviewId } })).toMatchObject({ showNickname: false, showOpeningResult: true });
    expect((await upd({ rating: 5, body: BODY, showOpeningResult: false })).status).toBe(200);
    expect(await db.productReview.findUniqueOrThrow({ where: { id: a.reviewId } })).toMatchObject({ showNickname: false, showOpeningResult: false });
    const bad = await upd({ rating: 5, body: BODY, showNickname: "yes" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_options");
    const bad2 = await write(s, (await s.delivered()).id, { rating: 5, body: BODY, showOpeningResult: 1 });
    expect(bad2.status).toBe(400);
  });
});
