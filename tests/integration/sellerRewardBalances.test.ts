import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as balancesRoute } from "../../app/api/seller/reward-balances/route";
import { loginSeller } from "../../lib/server/auth/login";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 회원별 적립금 잔액(GET /api/seller/reward-balances, SA-033). MEMBER_POINTS 권한, 판매자 격리, 닉네임 검색, 커서, 누적 합계, 조회만.
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
  return { seller, grade, cookie: await cookieOf(owner.email) };
}

let n = 0;
async function member(s: { seller: { id: string }; grade: { id: string } }, balance: number, at: Date, nickname?: string) {
  const m = await createBuyer(s.seller.id, s.grade.id);
  if (nickname) await db.buyerMember.update({ where: { id: m.id }, data: { broadcastNickname: nickname } });
  await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: m.id, balance, updatedAt: at } });
  return m;
}
const ledger = (s: { seller: { id: string } }, buyerMemberId: string, type: "EARN" | "RANKING_BONUS" | "USE" | "REVOKE" | "EXPIRE" | "ADJUST", amount: number, status: "SUCCEEDED" | "PENDING" | "FAILED" = "SUCCEEDED") =>
  db.rewardLedger.create({ data: { sellerId: s.seller.id, buyerMemberId, type, amount, status, testMode: true, idempotencyKey: `k${n++}` } });

async function list(cookie: string, qs = "") {
  const r = await balancesRoute(new Request(`http://localhost:3000/api/seller/reward-balances${qs}`, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
}
const ids = (b: { balances: { member: { id: string } }[] }) => b.balances.map((x) => x.member.id);

describe("회원별 잔액 GET /api/seller/reward-balances", () => {
  it("잔액과 성공 원장만 더한 누적 적립·사용·회수·소멸·조정을 준다. 잔액 = 적립 − 사용 − 회수 − 소멸 + 조정", async () => {
    const s = await shop();
    const m = await member(s, 1250, new Date("2026-10-01T00:00:00Z"));
    await ledger(s, m.id, "EARN", 1000);
    await ledger(s, m.id, "RANKING_BONUS", 500);
    await ledger(s, m.id, "USE", -1000);
    await ledger(s, m.id, "USE", 300); // 취소 반환
    await ledger(s, m.id, "REVOKE", -100);
    await ledger(s, m.id, "EXPIRE", -50);
    await ledger(s, m.id, "ADJUST", 600);
    await ledger(s, m.id, "EARN", 9999, "PENDING");
    await ledger(s, m.id, "EARN", 9999, "FAILED");
    const r = await list(s.cookie);
    expect(r.status).toBe(200);
    const [b] = r.body.balances;
    expect(b).toMatchObject({ member: { id: m.id, broadcastNickname: m.broadcastNickname }, balance: 1250, totalEarned: 1500, totalUsed: 700, totalRevoked: 100, totalExpired: 50, totalAdjusted: 600 });
    expect(b.totalEarned - b.totalUsed - b.totalRevoked - b.totalExpired + b.totalAdjusted).toBe(b.balance);
  });

  it("내 쇼핑몰 회원만, 탈퇴 회원은 빼고 준다. 다른 쇼핑몰 회원은 검색으로도 나오지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const mine = await member(a, 10, new Date("2026-10-01T00:00:00Z"));
    const gone = await member(a, 0, new Date("2026-10-02T00:00:00Z"));
    await db.buyerMember.update({ where: { id: gone.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    const other = await member(b, 99, new Date("2026-10-03T00:00:00Z"), "남의회원");
    await ledger(b, other.id, "EARN", 99);
    expect(ids((await list(a.cookie)).body)).toEqual([mine.id]);
    expect((await list(a.cookie, `?q=${encodeURIComponent("남의회원")}`)).body.balances).toEqual([]);
  });

  it("닉네임 부분 일치 검색, (updatedAt, id) 커서로 같은 시각 회원도 빠짐·겹침 없이 넘긴다. 잘못된 값은 400", async () => {
    const s = await shop();
    const at = new Date("2026-10-01T00:00:00Z");
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await member(s, i, at));
    const named = await member(s, 7, new Date("2026-09-01T00:00:00Z"), "카드왕초보");
    expect(ids((await list(s.cookie, `?q=${encodeURIComponent("왕초")}`)).body)).toEqual([named.id]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await list(s.cookie, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.body.balances.length).toBeLessThanOrEqual(2);
      seen.push(...ids(r.body));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(6);
    expect(new Set(seen)).toEqual(new Set([...made, named].map((m) => m.id)));
    for (const qs of ["?cursor=bad", "?limit=0", "?limit=x", `?q=${"가".repeat(51)}`]) expect((await list(s.cookie, qs)).status, qs).toBe(400);
  });

  it("MEMBER_POINTS 없는 직원은 403, 로그인하지 않으면 401. 조회는 잔액을 바꾸지 않는다", async () => {
    const s = await shop();
    const m = await member(s, 500, new Date("2026-10-01T00:00:00Z"));
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    expect((await list(await cookieOf(broadcaster.email))).status).toBe(403);
    const pointsStaff = await createSellerUser(s.seller.id, { permissions: ["MEMBER_POINTS"] });
    expect(ids((await list(await cookieOf(pointsStaff.email))).body)).toEqual([m.id]);
    expect((await balancesRoute(new Request("http://localhost:3000/api/seller/reward-balances", { headers: H }))).status).toBe(401);
    expect((await db.rewardBalance.findFirstOrThrow({ where: { buyerMemberId: m.id } })).balance).toBe(500);
  });
});
