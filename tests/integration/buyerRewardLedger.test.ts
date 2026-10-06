import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as ledgerGet } from "../../app/api/shop/[slug]/me/reward-ledger/route";
import { GET as rewardsGet } from "../../app/api/shop/[slug]/me/rewards/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createLoginBuyer, createPaidOrderItem, createSeller, db, resetDb } from "./helpers";

// 구매자 적립금 내역(GET /api/shop/{slug}/me/reward-ledger)과 곧 소멸(GET /me/rewards의 expiringSoon, SH-023).
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000" };
const call = (route: typeof ledgerGet, path: string, slug: string, cookie?: string) =>
  route(new Request(`http://localhost:3000/api/shop/${slug}/me/${path}`, { headers: { ...H, ...(cookie ? { cookie } : {}) } }), { params: Promise.resolve({ slug }) });
const ledgerOf = async (slug: string, qs: string, cookie?: string) => {
  const r = await call(ledgerGet, `reward-ledger${qs}`, slug, cookie);
  return { status: r.status, body: await r.json() };
};

async function cookie(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  return { seller, grade, buyer, cookie: await cookie(seller.id, buyer.loginId) };
}

let k = 0;
const row = (s: { seller: { id: string }; buyer: { id: string } }, data: { type: "EARN" | "REVOKE" | "USE" | "RANKING_BONUS" | "ADJUST" | "EXPIRE"; amount: number; at: string; status?: "PENDING" | "SUCCEEDED" | "FAILED"; testMode?: boolean; orderId?: string; key?: string; reason?: string }) =>
  db.rewardLedger.create({
    data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: data.orderId ?? null, type: data.type, amount: data.amount, status: data.status ?? "SUCCEEDED", testMode: data.testMode ?? false, reason: data.reason ?? null, idempotencyKey: data.key ?? `t${++k}`, createdAt: new Date(data.at) },
  });

describe("구매자 적립금 내역 GET /api/shop/{slug}/me/reward-ledger", () => {
  it("본인의 처리 끝난 실지급 원장만 최신순으로 문구·상품 요약·부호 있는 금액과 준다. 대기·실패·시험 모드·내부 사유는 나오지 않는다", async () => {
    const s = await shop();
    const { order, item } = await createPaidOrderItem(s.seller.id, s.buyer.id);
    await db.orderItem.create({ data: { ...{ sellerId: s.seller.id, orderId: order.id, productId: item.productId, optionId: item.optionId, productNameSnapshot: "슬리브", optionNameSnapshot: "x", unitPrice: 1000, quantity: 1 } } });
    const gold = await db.memberGrade.create({ data: { sellerId: s.seller.id, displayName: "골드", sortOrder: 9 } });
    await db.order.update({ where: { id: order.id }, data: { rewardGradeId: gold.id, rewardRate: 2, rewardEarnTiming: "ON_DELIVERY", rewardEarnAmount: 100 } });
    await row(s, { type: "EARN", amount: 100, at: "2026-10-01T00:00:00Z", orderId: order.id, key: `earn:${order.id}` });
    await row(s, { type: "USE", amount: -300, at: "2026-10-02T00:00:00Z", orderId: order.id });
    await row(s, { type: "REVOKE", amount: -100, at: "2026-10-03T00:00:00Z", orderId: order.id });
    await row(s, { type: "RANKING_BONUS", amount: 500, at: "2026-10-04T00:00:00Z" });
    await row(s, { type: "ADJUST", amount: 70, at: "2026-10-05T00:00:00Z", reason: "내부 메모 노출 금지" });
    // 안 나오는 것
    await row(s, { type: "EARN", amount: 999, at: "2026-10-06T00:00:00Z", status: "PENDING" });
    await row(s, { type: "EARN", amount: 998, at: "2026-10-06T00:00:00Z", status: "FAILED" });
    await row(s, { type: "EARN", amount: 997, at: "2026-10-06T00:00:00Z", testMode: true });

    const r = await ledgerOf(s.seller.slug, "", s.cookie);
    expect(r.status).toBe(200);
    expect(r.body.nextCursor).toBeNull();
    expect(r.body.items.map((i: { amount: number }) => i.amount)).toEqual([70, 500, -100, -300, 100]);
    expect(r.body.items.map((i: { type: string }) => i.type)).toEqual(["earn", "earn", "clawback", "use", "earn"]);
    expect(r.body.items.map((i: { text: string }) => i.text)).toEqual(["운영 지급", "명예의 전당 1위 보너스", "주문 취소로 회수", "주문에 사용", "개봉 완료 적립 (골드 2%)"]);
    expect(r.body.items[4].productSummary).toBe("부스터 팩 외 1");
    expect(r.body.items[1].productSummary).toBeNull();
    expect(Object.keys(r.body.items[0]).sort()).toEqual(["amount", "at", "id", "productSummary", "text", "type"]);
    expect(JSON.stringify(r.body)).not.toContain("내부 메모");
  });

  it("탭으로 거르고(earn·use·clawback·expire), 커서로 쪽을 넘긴다. 잘못된 type·cursor·limit은 400", async () => {
    const s = await shop();
    await row(s, { type: "EARN", amount: 100, at: "2026-10-01T00:00:00Z" });
    await row(s, { type: "ADJUST", amount: 10, at: "2026-10-02T00:00:00Z" });
    await row(s, { type: "USE", amount: -50, at: "2026-10-03T00:00:00Z" });
    await row(s, { type: "ADJUST", amount: -5, at: "2026-10-04T00:00:00Z" });
    await row(s, { type: "REVOKE", amount: -20, at: "2026-10-05T00:00:00Z" });
    await row(s, { type: "EXPIRE", amount: -35, at: "2026-10-06T00:00:00Z" });
    const amounts = async (qs: string) => (await ledgerOf(s.seller.slug, qs, s.cookie)).body.items.map((i: { amount: number }) => i.amount);
    expect(await amounts("?type=earn")).toEqual([10, 100]);
    expect(await amounts("?type=use")).toEqual([-50]);
    expect(await amounts("?type=clawback")).toEqual([-20, -5]);
    expect(await amounts("?type=expire")).toEqual([-35]);
    expect(await amounts("?type=all")).toHaveLength(6);

    const p1 = (await ledgerOf(s.seller.slug, "?limit=4", s.cookie)).body;
    expect(p1.items).toHaveLength(4);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await ledgerOf(s.seller.slug, `?limit=4&cursor=${p1.nextCursor}`, s.cookie)).body;
    expect(p2.items.map((i: { amount: number }) => i.amount)).toEqual([10, 100]);
    expect(p2.nextCursor).toBeNull();
    for (const bad of ["?type=x", "?cursor=x", "?limit=0", "?limit=x"]) expect((await ledgerOf(s.seller.slug, bad, s.cookie)).status, bad).toBe(400);
  });

  it("다른 회원·다른 쇼핑몰 값은 섞이지 않고, 로그인 없으면 401, 없는 쇼핑몰은 404", async () => {
    const a = await shop();
    const b = await shop();
    await row(a, { type: "EARN", amount: 111, at: "2026-10-01T00:00:00Z" });
    await row(b, { type: "EARN", amount: 222, at: "2026-10-01T00:00:00Z" });
    expect((await ledgerOf(a.seller.slug, "", a.cookie)).body.items.map((i: { amount: number }) => i.amount)).toEqual([111]);
    expect((await ledgerOf(b.seller.slug, "", b.cookie)).body.items.map((i: { amount: number }) => i.amount)).toEqual([222]);
    expect((await ledgerOf(a.seller.slug, "")).status).toBe(401);
    expect((await ledgerOf(a.seller.slug, "", b.cookie)).status).toBe(401);
    expect((await ledgerOf("no-such-shop", "", a.cookie)).status).toBe(404);
  });
});

describe("곧 소멸 GET /api/shop/{slug}/me/rewards expiringSoon", () => {
  const expiring = async (s: { seller: { slug: string }; cookie: string }) => (await (await call(rewardsGet, "rewards", s.seller.slug, s.cookie)).json()).expiringSoon;
  const DAY = 86_400_000;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

  it("마지막 적립 3년 뒤가 30일 안일 때만 잔액 전체와 소멸일을 준다. 멀거나 잔액 0이거나 적립 기록이 없으면 null", async () => {
    const s = await shop();
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, balance: 4000 } });
    expect(await expiring(s)).toBeNull(); // 적립 기록 없음
    const last = new Date(Date.now() - (3 * 365 - 10) * DAY); // 소멸까지 약 10일(윤년 하루 오차 허용)
    await row(s, { type: "EARN", amount: 4000, at: last.toISOString() });
    const soon = await expiring(s);
    expect(soon.amount).toBe(4000);
    const left = (new Date(soon.expiresAt).getTime() - Date.now()) / DAY;
    expect(left).toBeGreaterThan(8);
    expect(left).toBeLessThan(12);
    // 새 적립이 생기면 기준일이 바뀌어 멀어진다
    await row(s, { type: "EARN", amount: 1, at: at(1) });
    expect(await expiring(s)).toBeNull();
  });

  it("잔액이 0이면 null, 시험 모드 적립은 기준일로 치지 않는다", async () => {
    const s = await shop();
    await row(s, { type: "EARN", amount: 100, at: at(3 * 365 - 10) });
    expect(await expiring(s)).toBeNull(); // 잔액 행 없음 = 0
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, balance: 100 } });
    expect((await expiring(s)).amount).toBe(100);
    await row(s, { type: "EARN", amount: 5, at: at(1), testMode: true });
    expect((await expiring(s)).amount).toBe(100);
  });
});
