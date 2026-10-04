import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "../../app/api/seller/members/[memberId]/route";
import { GET as listRoute } from "../../app/api/seller/members/route";
import { loginSeller } from "../../lib/server/auth/login";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 파트너스 회원 목록·상세(GET /api/seller/members, /api/seller/members/{id}). MEMBER_POINTS 권한, 테넌트 격리,
// 탈퇴 회원 제외, 이름·휴대폰은 개인정보 권한이 있을 때만(넣었으면 열람 기록).
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

// 가입 시각을 정한 회원(목록 정렬·커서 확인용)
async function member(s: { seller: { id: string }; grade: { id: string } }, data: { createdAt?: Date; nickname?: string; name?: string; phone?: string } = {}) {
  const m = await createBuyer(s.seller.id, s.grade.id, data.phone);
  return db.buyerMember.update({
    where: { id: m.id },
    data: { ...(data.createdAt ? { createdAt: data.createdAt } : {}), ...(data.nickname ? { broadcastNickname: data.nickname } : {}), ...(data.name ? { name: data.name } : {}) },
  });
}

async function list(cookie: string, qs = "") {
  const r = await listRoute(new Request(`http://localhost:3000/api/seller/members${qs}`, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
}
async function detail(cookie: string, id: string) {
  const r = await detailRoute(new Request(`http://localhost:3000/api/seller/members/${id}`, { headers: { ...H, cookie } }), { params: Promise.resolve({ memberId: id }) });
  return { status: r.status, body: await r.json() };
}
const ids = (b: { members: { id: string }[] }) => b.members.map((m) => m.id);
const piiAudits = () => db.auditLog.findMany({ where: { action: "customer.pii.view" }, orderBy: { createdAt: "asc" } });

describe("회원 목록 GET /api/seller/members", () => {
  it("내 쇼핑몰 회원만 가입 시각 내림차순으로 주고, 탈퇴 회원은 빠진다. 다른 쇼핑몰 회원은 검색으로도 나오지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const m1 = await member(a, { createdAt: new Date("2026-10-01T00:00:00Z") });
    const m2 = await member(a, { createdAt: new Date("2026-10-02T00:00:00Z") });
    const gone = await member(a, { createdAt: new Date("2026-10-03T00:00:00Z") });
    await db.buyerMember.update({ where: { id: gone.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    await member(b, { nickname: "남의회원" });
    const r = await list(a.cookie);
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual([m2.id, m1.id]);
    expect(r.body.nextCursor).toBeNull();
    expect((await list(a.cookie, `?q=${encodeURIComponent("남의회원")}`)).body.members).toEqual([]);
    // 탈퇴 회원은 상세도 없는 회원이다
    expect((await detail(a.cookie, gone.id)).status).toBe(404);
  });

  it("(createdAt, id) 커서로 끝까지 넘기면 같은 가입 시각 회원도 빠짐·겹침 없이 모두 나온다. 잘못된 커서·limit·상태·등급은 400", async () => {
    const s = await shop();
    const at = new Date("2026-10-01T00:00:00Z");
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await member(s, { createdAt: at }));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const r = await list(s.cookie, qs);
      expect(r.body.members.length).toBeLessThanOrEqual(2);
      seen.push(...ids(r.body));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(5);
    expect(new Set(seen)).toEqual(new Set(made.map((m) => m.id)));
    for (const qs of ["?cursor=bad", "?limit=0", "?limit=x", "?status=WITHDRAWN", "?gradeId=nope", `?q=${"가".repeat(51)}`]) {
      expect((await list(s.cookie, qs)).status, qs).toBe(400);
    }
  });

  it("등급·상태로 거른다", async () => {
    const s = await shop();
    const vip = await db.memberGrade.create({ data: { sellerId: s.seller.id, displayName: "VIP", sortOrder: 1 } });
    const basic = await member(s);
    const v = await member(s);
    await db.buyerMember.update({ where: { id: v.id }, data: { gradeId: vip.id } });
    const dormant = await member(s);
    await db.buyerMember.update({ where: { id: dormant.id }, data: { status: "DORMANT" } });
    expect(ids((await list(s.cookie, `?gradeId=${vip.id}`)).body)).toEqual([v.id]);
    expect(ids((await list(s.cookie, "?status=DORMANT")).body)).toEqual([dormant.id]);
    expect(new Set(ids((await list(s.cookie, "?status=ACTIVE")).body))).toEqual(new Set([basic.id, v.id]));
  });

  it("닉네임은 누구나, 이름·휴대폰 끝 4자리는 개인정보 권한이 있을 때만 찾고 응답에 넣는다. 넣었으면 열람 기록(회원 id만, 검색어 없음)", async () => {
    const s = await shop();
    const m = await member(s, { nickname: "방송닉", name: "김철수", phone: "01011112222" });
    const pii = await cookieOf((await createSellerUser(s.seller.id, { permissions: ["MEMBER_POINTS", "CUSTOMER_PII_VIEW"] })).email);
    const noPii = await cookieOf((await createSellerUser(s.seller.id, { permissions: ["MEMBER_POINTS"] })).email);

    const plain = await list(noPii, `?q=${encodeURIComponent("방송")}`);
    expect(plain.body.members).toEqual([
      { id: m.id, broadcastNickname: "방송닉", grade: { id: s.grade.id, displayName: "일반" }, status: "ACTIVE", marketingConsent: false, createdAt: m.createdAt.toISOString(), lastLoginAt: null },
    ]);
    expect((await list(noPii, `?q=${encodeURIComponent("김철")}`)).body.members).toEqual([]);
    expect((await list(noPii, "?q=2222")).body.members).toEqual([]);
    expect(await piiAudits()).toEqual([]);

    expect((await list(pii, `?q=${encodeURIComponent("김철")}`)).body.members[0]).toMatchObject({ id: m.id, name: "김철수", phone: "01011112222" });
    expect(ids((await list(pii, "?q=2222")).body)).toEqual([m.id]);
    const audits = await piiAudits();
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ sellerId: s.seller.id, targetType: "MemberList", reason: "member_list_search", after: { memberIds: [m.id], count: 1 } });
    expect(JSON.stringify(audits)).not.toContain("김철");
  });

  it("MEMBER_POINTS 없는 직원은 목록·상세 모두 403", async () => {
    const s = await shop();
    const m = await member(s);
    const staff = await cookieOf((await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING", "CUSTOMER_PII_VIEW"] })).email);
    expect((await list(staff)).status).toBe(403);
    expect((await detail(staff, m.id)).status).toBe(403);
  });
});

describe("회원 상세 GET /api/seller/members/{id}", () => {
  it("주문 수·누적 결제(결제된 주문 − 환불액)·적립금 잔액·등급을 주고, 개인정보를 넣었으면 열람 기록을 남긴다", async () => {
    const s = await shop();
    const m = await member(s, { name: "이영희" });
    let n = 0;
    const order = (data: { status: "PENDING_PAYMENT" | "PAID" | "REFUNDED"; total: number; paid?: boolean; refund?: number; legalHold?: boolean }) =>
      db.order.create({
        data: {
          sellerId: s.seller.id,
          orderNo: ++n,
          buyerMemberId: m.id,
          broadcastNicknameSnapshot: m.broadcastNickname,
          status: data.status,
          totalAmount: data.total,
          paidAt: data.paid ? new Date() : null,
          refundAmount: data.refund ?? null,
          legalHoldAt: data.legalHold ? new Date() : null,
        },
      });
    await order({ status: "PAID", total: 30000, paid: true });
    await order({ status: "REFUNDED", total: 10000, paid: true, refund: 7000 });
    await order({ status: "PENDING_PAYMENT", total: 5000 });
    // 법정 보관으로 분리한 주문은 세지 않는다
    await order({ status: "PAID", total: 99999, paid: true, legalHold: true });
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: m.id, balance: 1500 } });

    const r = await detail(s.cookie, m.id);
    expect(r.status).toBe(200);
    expect(r.body.member).toMatchObject({ id: m.id, name: "이영희", grade: { id: s.grade.id, displayName: "일반" }, orderCount: 3, totalPaid: 33000, rewardBalance: 1500 });
    expect(await piiAudits()).toMatchObject([{ targetType: "BuyerMember", targetId: m.id }]);
  });

  it("다른 쇼핑몰 회원·없는 id·형식이 틀린 id는 404", async () => {
    const a = await shop();
    const b = await shop();
    const other = await member(b);
    expect((await detail(a.cookie, other.id)).status).toBe(404);
    expect((await detail(a.cookie, crypto.randomUUID())).status).toBe(404);
    expect((await detail(a.cookie, "nope")).status).toBe(404);
  });
});
