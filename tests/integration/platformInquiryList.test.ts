import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminList } from "../../app/api/admin/platform-inquiries/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { ADMIN_PAGE_SIZE, OVERDUE_MS } from "../../lib/server/platform-inquiries/service";
import { createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// MA-051: 상단 요약 카드 · 긴급 우선/긴급만 · 파트너스 이름 검색
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const ago = (ms: number) => new Date(Date.now() - ms);
const H = 3_600_000;

async function admin(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "CS") {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const get = async (cookie: string, qs = "") => {
  const r = await adminList(new Request(`${BASE}/api/admin/platform-inquiries${qs}`, { headers: { host: "localhost:3000", origin: BASE, cookie } }));
  return { status: r.status, body: await r.json() };
};
let seq = 0;
async function shop(shopName?: string) {
  const { seller } = await createSeller();
  if (shopName) await db.seller.update({ where: { id: seller.id }, data: { shopName } });
  const user = await createSellerUser(seller.id, "OWNER");
  return { seller, user };
}
async function inquiry(s: Awaited<ReturnType<typeof shop>>, data: Record<string, unknown> = {}) {
  const createdAt = (data.createdAt as Date | undefined) ?? new Date();
  return db.platformInquiry.create({
    data: { sellerId: s.seller.id, createdBySellerUserId: s.user.id, category: "SUBSCRIPTION_FEE", title: `문의 ${++seq}`, createdAt, lastMessageAt: createdAt, ...data } as never,
  });
}
const adminMsg = (inq: { id: string; sellerId: string }, adminId: string, at: Date) =>
  db.platformInquiryMessage.create({ data: { sellerId: inq.sellerId, inquiryId: inq.id, authorType: "ADMIN", adminId, body: "답변", createdAt: at } });

describe("요약 카드", () => {
  it("답변 대기·긴급·4시간 초과·내 담당·오늘 접수·답변 완료(오늘)를 필터와 무관하게 센다", async () => {
    const me = await admin();
    const other = await admin("OPERATIONS");
    const a = await shop();
    await inquiry(a, { createdAt: ago(5 * H), urgent: true, assignedAdminId: me.id }); // 대기·긴급·초과·내 담당
    await inquiry(await shop(), { createdAt: ago(OVERDUE_MS + 1000) }); // 대기·초과
    await inquiry(await shop(), { createdAt: ago(1000), assignedAdminId: other.id }); // 대기·오늘 접수
    const answered = await inquiry(await shop(), { createdAt: ago(8 * H), status: "ANSWERED", lastMessageAt: ago(1000), lastAdminMessageAt: ago(1000) });
    await adminMsg(answered, me.id, ago(1000));
    const closed = await inquiry(await shop(), { createdAt: ago(30 * H), status: "CLOSED", closedAt: ago(29 * H) });
    expect(closed.status).toBe("CLOSED");
    const { status, body } = await get(me.cookie, "?status=CLOSED&category=BILLING");
    expect(status).toBe(200);
    expect(body.summary).toMatchObject({ waiting: 3, urgent: 1, overdue: 2, mine: 1, answeredToday: 1 });
    expect(body.summary.todayReceived).toBeGreaterThanOrEqual(1);
    expect(body.counts).toMatchObject({ OPEN: expect.any(Number) });
  });

  it("평균 첫 답변(시간)은 최근 7일에 접수해 답변받은 문의만, 도움됨 비율은 최근 7일 평가만", async () => {
    const me = await admin();
    const s1 = await shop();
    const s2 = await shop();
    const s3 = await shop();
    const i1 = await inquiry(s1, { createdAt: ago(10 * H), status: "ANSWERED", lastAdminMessageAt: ago(7 * H), helpful: true, helpfulAt: ago(H) });
    await adminMsg(i1, me.id, ago(7 * H)); // 3시간 뒤 첫 답변
    await adminMsg(i1, me.id, ago(1 * H)); // 두 번째 답변은 첫 답변이 아니다
    const i2 = await inquiry(s2, { createdAt: ago(9 * H), status: "ANSWERED", lastAdminMessageAt: ago(4 * H), helpful: false, helpfulAt: ago(2 * H) });
    await adminMsg(i2, me.id, ago(4 * H)); // 5시간 뒤
    await inquiry(s3, { createdAt: ago(20 * 24 * H), status: "ANSWERED", helpful: true, helpfulAt: ago(20 * 24 * H) }); // 오래된 평가·접수는 제외
    const { body } = await get(me.cookie);
    expect(body.summary.avgFirstReplyHours).toBe(4);
    expect(body.summary.helpful7d).toEqual({ answered: 2, helpful: 1, rate: 50 });
  });

  it("문의가 없으면 평균·비율은 null이고 건수는 0", async () => {
    const me = await admin();
    expect((await get(me.cookie)).body.summary).toEqual({ waiting: 0, urgent: 0, overdue: 0, mine: 0, todayReceived: 0, answeredToday: 0, avgFirstReplyHours: null, helpful7d: { answered: 0, helpful: 0, rate: null } });
  });
});

describe("긴급 필터·정렬", () => {
  it("긴급만은 긴급 문의만, 긴급 우선은 긴급을 위로(그 안에서는 최신 순)", async () => {
    const me = await admin();
    const s = await shop();
    const old = await inquiry(s, { createdAt: ago(10 * H), urgent: true, title: "오래된 긴급" });
    const mid = await inquiry(await shop(), { createdAt: ago(5 * H), title: "중간" });
    const fresh = await inquiry(await shop(), { createdAt: ago(1 * H), title: "최신" });
    const only = await get(me.cookie, "?urgent=only");
    expect(only.body.items.map((i: { id: string }) => i.id)).toEqual([old.id]);
    const first = await get(me.cookie, "?urgent=first");
    expect(first.body.items.map((i: { id: string }) => i.id)).toEqual([old.id, fresh.id, mid.id]);
    const normal = await get(me.cookie);
    expect(normal.body.items.map((i: { id: string }) => i.id)).toEqual([fresh.id, mid.id, old.id]);
    expect((await get(me.cookie, "?urgent=nope")).status).toBe(400);
  });

  it("긴급 우선 정렬도 쪽 나누기가 빠짐·중복 없이 이어진다", async () => {
    const me = await admin();
    const ids: string[] = [];
    const total = ADMIN_PAGE_SIZE + 5;
    for (let i = 0; i < total; i++) {
      const at = new Date(Date.now() - (total - i) * 60_000);
      ids.push((await inquiry(await shop(), { createdAt: at, urgent: i % 7 === 0 })).id);
    }
    const p1 = await get(me.cookie, "?urgent=first");
    expect(p1.body.items).toHaveLength(ADMIN_PAGE_SIZE);
    expect(p1.body.nextCursor).toMatch(/^U[01]_/);
    const p2 = await get(me.cookie, `?urgent=first&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    const got = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(got).size).toBe(total);
    expect(p2.body.nextCursor).toBeNull();
    // 긴급이 모두 앞에 온다
    const flags = [...p1.body.items, ...p2.body.items].map((i: { urgent: boolean }) => i.urgent);
    expect(flags.indexOf(false)).toBe(flags.filter(Boolean).length);
    expect((await get(me.cookie, "?urgent=first&cursor=garbage")).status).toBe(400);
  });
});

describe("파트너스 이름 검색", () => {
  it("이름(또는 주소) 일부로 대소문자 무시 검색하고, 건수에도 적용하며, 와일드카드는 글자 그대로 취급한다", async () => {
    const me = await admin();
    const moon = await shop("문라이트마켓");
    const pocket = await shop("Pocket Duck");
    await inquiry(moon);
    await inquiry(moon, { status: "ANSWERED" });
    await inquiry(pocket);
    const r = await get(me.cookie, `?seller=${encodeURIComponent("라이트")}`);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.counts).toEqual({ OPEN: 1, ANSWERED: 1, CLOSED: 0 });
    expect((await get(me.cookie, `?seller=${encodeURIComponent("pocket duck")}`)).body.items).toHaveLength(1);
    expect((await get(me.cookie, `?seller=${encodeURIComponent("%")}`)).body.items).toHaveLength(0);
    // 이름에 %·_가 실제로 든 쇼핑몰은 그 글자로 찾히고(이중 이스케이프가 아님), 다른 쇼핑몰은 와일드카드로 딸려 오지 않는다
    const pct = await shop("50% 할인샵");
    const under = await shop("a_b샵");
    await inquiry(pct);
    await inquiry(under);
    const byPct = await get(me.cookie, `?seller=${encodeURIComponent("%")}`);
    expect(byPct.body.items.map((i: { shopName: string }) => i.shopName)).toEqual(["50% 할인샵"]);
    expect((await get(me.cookie, `?seller=${encodeURIComponent("50%")}`)).body.items).toHaveLength(1);
    expect((await get(me.cookie, `?seller=${encodeURIComponent("a_b")}`)).body.items.map((i: { shopName: string }) => i.shopName)).toEqual(["a_b샵"]);
    expect((await get(me.cookie, `?seller=${encodeURIComponent("a%b")}`)).body.items).toHaveLength(0);
    expect((await get(me.cookie, `?seller=${encodeURIComponent("x".repeat(51))}`)).status).toBe(400);
    expect((await get(me.cookie, `?seller=${encodeURIComponent("없는이름")}`)).body.items).toEqual([]);
  });
});
