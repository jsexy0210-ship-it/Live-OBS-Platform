import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as ledgerRoute } from "../../app/api/seller/reward-ledger/route";
import { loginSeller } from "../../lib/server/auth/login";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 적립금 지급·회수 원장 조회(GET /api/seller/reward-ledger, SA-032). MEMBER_POINTS 권한, 판매자 격리, 상태 필터, 커서, 조회만.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000" };

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const member = await createBuyer(seller.id, grade.id);
  return { seller, grade, member, cookie: await cookieOf(owner.email) };
}

let n = 0;
async function entry(
  s: { seller: { id: string }; member: { id: string } },
  data: { status?: "PENDING" | "SUCCEEDED" | "FAILED"; amount?: number; createdAt?: Date; orderId?: string; type?: "EARN" | "REVOKE" } = {},
) {
  return db.rewardLedger.create({
    data: {
      sellerId: s.seller.id,
      buyerMemberId: s.member.id,
      orderId: data.orderId ?? null,
      type: data.type ?? "EARN",
      amount: data.amount ?? 100,
      status: data.status ?? "PENDING",
      testMode: true,
      idempotencyKey: `k${n++}`,
      ...(data.status === "FAILED" ? { failureReason: "member_withdrawn" } : {}),
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

async function list(cookie: string, qs = "") {
  const r = await ledgerRoute(new Request(`http://localhost:3000/api/seller/reward-ledger${qs}`, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
}
const ids = (b: { entries: { id: string }[] }) => b.entries.map((e) => e.id);

describe("적립금 원장 GET /api/seller/reward-ledger", () => {
  it("내 쇼핑몰 원장만 최신순으로 닉네임·금액·사유·주문번호와 함께 준다. 다른 쇼핑몰 원장은 나오지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const { order } = await createPaidOrderItem(a.seller.id, a.member.id);
    const e1 = await entry(a, { createdAt: new Date("2026-10-01T00:00:00Z"), orderId: order.id, amount: 500 });
    const e2 = await entry(a, { createdAt: new Date("2026-10-02T00:00:00Z"), type: "REVOKE", amount: -200, status: "FAILED" });
    await entry(b);
    const r = await list(a.cookie);
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual([e2.id, e1.id]);
    expect(r.body.nextCursor).toBeNull();
    const [last, first] = r.body.entries;
    expect(first).toMatchObject({ member: { id: a.member.id, broadcastNickname: a.member.broadcastNickname }, type: "EARN", amount: 500, status: "PENDING", order: { id: order.id, orderNo: order.orderNo, orderNoLabel: expect.stringMatching(/^\d{8}-\d{4,}$/) } });
    expect(last).toMatchObject({ type: "REVOKE", amount: -200, status: "FAILED", failureReason: "member_withdrawn", order: null });
    // 다른 쇼핑몰(b)에서도 a의 원장은 보이지 않는다
    expect(ids((await list(b.cookie)).body)).not.toContain(e1.id);
  });

  it("상태 필터는 그 상태만 준다. 잘못된 상태·커서·limit은 400", async () => {
    const s = await shop();
    await entry(s, { status: "PENDING" });
    const ok = await entry(s, { status: "SUCCEEDED" });
    await entry(s, { status: "FAILED" });
    expect(ids((await list(s.cookie, "?status=SUCCEEDED")).body)).toEqual([ok.id]);
    for (const qs of ["?status=DONE", "?cursor=bad", "?limit=0", "?limit=x"]) expect((await list(s.cookie, qs)).status, qs).toBe(400);
  });

  it("from·to는 한국 날짜 기준 생성일로 거른다(끝 날짜 포함). 하나만 줘도 되고, 잘못된 날짜·from>to는 400", async () => {
    const s = await shop();
    const a = await entry(s, { createdAt: new Date("2026-09-30T14:59:59Z") }); // 9/30 23:59 KST
    const b = await entry(s, { createdAt: new Date("2026-09-30T15:00:00Z") }); // 10/1 00:00 KST
    const c = await entry(s, { createdAt: new Date("2026-10-01T14:59:59Z") }); // 10/1 23:59 KST
    const d = await entry(s, { createdAt: new Date("2026-10-01T15:00:00Z") }); // 10/2 00:00 KST
    expect(ids((await list(s.cookie, "?from=2026-10-01&to=2026-10-01")).body)).toEqual([c.id, b.id]);
    expect(ids((await list(s.cookie, "?from=2026-10-01")).body)).toEqual([d.id, c.id, b.id]);
    expect(ids((await list(s.cookie, "?to=2026-09-30")).body)).toEqual([a.id]);
    expect((await list(s.cookie, "?from=2026-13-40")).status).toBe(400);
    expect((await list(s.cookie, "?from=10/1")).status).toBe(400);
    expect((await list(s.cookie, "?from=2026-10-02&to=2026-10-01")).status).toBe(400);
  });

  it("(createdAt, id) 커서로 끝까지 넘기면 같은 시각 줄도 빠짐·겹침 없이 모두 나온다", async () => {
    const s = await shop();
    const at = new Date("2026-10-01T00:00:00Z");
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await entry(s, { createdAt: at }));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await list(s.cookie, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.body.entries.length).toBeLessThanOrEqual(2);
      seen.push(...ids(r.body));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(5);
    expect(new Set(seen)).toEqual(new Set(made.map((m) => m.id)));
  });

  it("MEMBER_POINTS 없는 직원은 403, 로그인하지 않으면 401. 조회는 원장·잔액을 바꾸지 않는다", async () => {
    const s = await shop();
    const e = await entry(s);
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    expect((await list(await cookieOf(broadcaster.email))).status).toBe(403);
    const pointsStaff = await createSellerUser(s.seller.id, { permissions: ["MEMBER_POINTS"] });
    expect(ids((await list(await cookieOf(pointsStaff.email))).body)).toEqual([e.id]);
    expect((await ledgerRoute(new Request("http://localhost:3000/api/seller/reward-ledger", { headers: H }))).status).toBe(401);
    expect(await db.rewardLedger.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ status: "PENDING", processedAt: null });
    expect(await db.rewardBalance.count()).toBe(0);
  });

  it("memberId로 회원 한 명의 줄만 주고, 잘못된 값은 400, 다른 쇼핑몰 회원 id는 빈 목록이다", async () => {
    const a = await shop();
    const b = await shop();
    const other = await createBuyer(a.seller.id, a.grade.id);
    const mine = await entry(a);
    await entry({ seller: a.seller, member: other });
    await entry(b);
    expect(ids((await list(a.cookie, `?memberId=${a.member.id}`)).body)).toEqual([mine.id]);
    expect((await list(a.cookie, `?memberId=${b.member.id}`)).body.entries).toEqual([]);
    expect((await list(a.cookie, "?memberId=abc")).status).toBe(400);
  });
});
