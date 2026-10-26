import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "../../app/api/seller/members/[memberId]/route";
import { GET as listRoute } from "../../app/api/seller/members/route";
import { GET as summaryRoute } from "../../app/api/seller/members/summary/route";
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
async function detail(cookie: string, id: string, qs = "") {
  const r = await detailRoute(new Request(`http://localhost:3000/api/seller/members/${id}${qs}`, { headers: { ...H, cookie } }), { params: Promise.resolve({ memberId: id }) });
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
      { id: m.id, broadcastNickname: "방송닉", grade: { id: s.grade.id, displayName: "일반" }, status: "ACTIVE", marketingConsent: false, createdAt: m.createdAt.toISOString(), lastLoginAt: null, number: 1, orderCount: 0, totalPaid: 0, rewardBalance: 0, lastOrderAt: null, restricted: false },
    ]);
    expect((await list(noPii, `?q=${encodeURIComponent("김철")}`)).body.members).toEqual([]);
    expect((await list(noPii, "?q=2222")).body.members).toEqual([]);
    expect(await piiAudits()).toEqual([]);

    expect((await list(pii, `?q=${encodeURIComponent("김철")}`)).body.members[0]).toMatchObject({ id: m.id, name: "김철수", phone: "01011112222" });
    expect(ids((await list(pii, "?q=2222")).body)).toEqual([m.id]);
    // 일치하는 회원이 없어도 개인정보로 찾았으면 기록한다(0건)
    expect((await list(pii, `?q=${encodeURIComponent("없는이름")}`)).body.members).toEqual([]);
    const audits = await piiAudits();
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({ sellerId: s.seller.id, targetType: "MemberList", reason: "member_list_search", after: { memberIds: [m.id], count: 1 } });
    expect(audits[2]).toMatchObject({ reason: "member_list_search", after: { memberIds: [], count: 0 } });
    expect(JSON.stringify(audits)).not.toContain("김철");
    expect(JSON.stringify(audits)).not.toContain("없는이름");
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
    const fromList = (await list(s.cookie)).body.members.find((row: { id: string }) => row.id === m.id);
    expect(fromList).toMatchObject({ orderCount: r.body.member.orderCount, totalPaid: r.body.member.totalPaid, rewardBalance: r.body.member.rewardBalance });
  });

  it("다른 쇼핑몰 회원·없는 id·형식이 틀린 id는 404", async () => {
    const a = await shop();
    const b = await shop();
    const other = await member(b);
    expect((await detail(a.cookie, other.id)).status).toBe(404);
    expect((await detail(a.cookie, crypto.randomUUID())).status).toBe(404);
    expect((await detail(a.cookie, "nope")).status).toBe(404);
  });

  it("잔액 조정 요약은 개인정보 권한이 있어도 세 필드만 주고 열람 감사를 만들지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const m = await member(a, { nickname: "조정 대상", name: "상세 전용" });
    const other = await member(b);
    await db.rewardBalance.create({ data: { sellerId: a.seller.id, buyerMemberId: m.id, balance: 1500 } });
    const summary = await detail(a.cookie, m.id, "?summary=1");
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({ member: { id: m.id, broadcastNickname: "조정 대상", rewardBalance: 1500 } });
    expect(await piiAudits()).toEqual([]);
    expect((await detail(a.cookie, other.id, "?summary=1")).status).toBe(404);
    expect((await detail(a.cookie, "nope", "?summary=1")).status).toBe(404);
    const denied = await cookieOf((await createSellerUser(a.seller.id, { permissions: [] })).email);
    expect((await detail(denied, m.id, "?summary=1")).status).toBe(403);
    expect(await piiAudits()).toEqual([]);
    expect((await detail(a.cookie, m.id)).body.member).toMatchObject({ name: "상세 전용", rewardBalance: 1500 });
    expect(await piiAudits()).toMatchObject([{ action: "customer.pii.view", targetId: m.id }]);
    await db.buyerMember.update({ where: { id: m.id }, data: { deletedAt: new Date(), status: "WITHDRAWN" } });
    expect((await detail(a.cookie, m.id, "?summary=1")).status).toBe(404);
  });
});

describe("회원 목록 조건·정렬·요약 (SA-041)", () => {
  let seq = 0;
  const DAY = 24 * 3600_000;
  const order = (sellerId: string, buyerMemberId: string, createdAt: Date, totalAmount = 10000, paid = true) =>
    db.order.create({ data: { sellerId, buyerMemberId, orderNo: 9000 + ++seq, broadcastNicknameSnapshot: "x", totalAmount, createdAt, paidAt: paid ? createdAt : null, status: paid ? "PAID" : "PENDING_PAYMENT" } });
  const summary = async (cookie: string) => {
    const r = await summaryRoute(new Request("http://localhost:3000/api/seller/members/summary", { headers: { ...H, cookie } }));
    return { status: r.status, body: await r.json() };
  };

  it("행에 번호·최근 주문·구매 제한 표시를 주고, 상태·등급 여러 개·가입일·최근 주문·기타 조건으로 거른다", async () => {
    const a = await shop();
    const gold = await db.memberGrade.create({ data: { sellerId: a.seller.id, displayName: "골드", sortOrder: 2, systemKey: "GOLD" } });
    const vip = await db.memberGrade.create({ data: { sellerId: a.seller.id, displayName: "VIP", sortOrder: 3, systemKey: "VIP" } });
    const now = Date.now();
    const m1 = await member(a, { createdAt: new Date("2026-01-10T00:00:00Z"), nickname: "가" });
    const m2 = await member(a, { createdAt: new Date("2026-02-10T00:00:00Z"), nickname: "나" });
    const m3 = await member(a, { createdAt: new Date("2026-03-10T00:00:00Z"), nickname: "다" });
    await db.buyerMember.update({ where: { id: m2.id }, data: { gradeId: gold.id, marketingConsentAt: new Date() } });
    await db.buyerMember.update({ where: { id: m3.id }, data: { gradeId: vip.id, status: "DORMANT" } });
    await order(a.seller.id, m1.id, new Date(now - 10 * DAY));
    await order(a.seller.id, m2.id, new Date(now - 60 * DAY));
    await db.buyerPurchaseRestriction.create({ data: { sellerId: a.seller.id, buyerMemberId: m1.id, reason: "MANUAL", startsAt: new Date(now - DAY), endsAt: new Date(now + DAY) } });
    await db.buyerPurchaseRestriction.create({ data: { sellerId: a.seller.id, buyerMemberId: m2.id, reason: "MANUAL", startsAt: new Date(now - 9 * DAY), endsAt: new Date(now - 8 * DAY) } });
    await db.rewardBalance.create({ data: { sellerId: a.seller.id, buyerMemberId: m2.id, balance: 500 } });
    await db.memberMemo.create({ data: { sellerId: a.seller.id, buyerMemberId: m3.id, body: "메모" } });

    const all = (await list(a.cookie)).body.members;
    expect(all.map((m: { number: number }) => m.number)).toEqual([3, 2, 1]);
    const byId = Object.fromEntries(all.map((m: { id: string }) => [m.id, m]));
    expect(byId[m1.id]).toMatchObject({ restricted: true, orderCount: 1 });
    expect(byId[m1.id].lastOrderAt).toBeTruthy();
    expect(byId[m2.id].restricted).toBe(false); // 끝난 제한
    expect(byId[m3.id].lastOrderAt).toBeNull();

    const f = async (qs: string) => ids((await list(a.cookie, `?${qs}`)).body);
    expect(await f("status=RESTRICTED")).toEqual([m1.id]);
    expect(await f("status=NORMAL")).toEqual([m2.id]); // 활동 중이고 제한 없음(m3은 휴면)
    expect(await f("status=DORMANT")).toEqual([m3.id]);
    expect(await f(`gradeIds=${gold.id},${vip.id}`)).toEqual([m3.id, m2.id]);
    expect(await f("joinedFrom=2026-02-01&joinedTo=2026-02-10")).toEqual([m2.id]); // 끝 날짜 포함
    expect(await f("lastOrder=30d")).toEqual([m1.id]);
    expect(await f("lastOrder=90d")).toEqual([m2.id, m1.id]);
    expect(await f("lastOrder=over90d")).toEqual([m3.id]); // 주문한 적 없음 포함
    expect(await f("marketing=true")).toEqual([m2.id]);
    expect(await f("hasBalance=true")).toEqual([m2.id]);
    expect(await f("hasMemo=true")).toEqual([m3.id]);
    for (const bad of ["status=WITHDRAWN", "gradeIds=nope", "joinedFrom=2026-13-01", "joinedFrom=2026-03-01&joinedTo=2026-02-01", "lastOrder=1d", "marketing=1", "sort=name", "qType=email", "cursor=abc&sort=spent"]) {
      expect((await list(a.cookie, `?${bad}`)).status, bad).toBe(400);
    }
  });

  it("최근 주문·누적 구매·적립금 순으로 정렬하고 위치 커서로 이어 읽는다. 다른 쇼핑몰 집계는 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const now = Date.now();
    const m1 = await member(a, { createdAt: new Date("2026-01-01T00:00:00Z") });
    const m2 = await member(a, { createdAt: new Date("2026-01-02T00:00:00Z") });
    const m3 = await member(a, { createdAt: new Date("2026-01-03T00:00:00Z") });
    await order(a.seller.id, m1.id, new Date(now - 5 * DAY), 3000);
    await order(a.seller.id, m2.id, new Date(now - 9 * DAY), 90000);
    await order(a.seller.id, m3.id, new Date(now - 1 * DAY), 500, false); // 미결제: 최근 주문엔 들어가고 누적 구매엔 안 들어감
    await db.rewardBalance.createMany({ data: [{ sellerId: a.seller.id, buyerMemberId: m1.id, balance: 700 }, { sellerId: a.seller.id, buyerMemberId: m3.id, balance: 100 }] });
    const other = await member(b);
    await order(b.seller.id, other.id, new Date(now), 99999999);
    expect(ids((await list(a.cookie, "?sort=lastOrder")).body)).toEqual([m3.id, m1.id, m2.id]);
    expect(ids((await list(a.cookie, "?sort=spent")).body)).toEqual([m2.id, m1.id, m3.id]);
    expect(ids((await list(a.cookie, "?sort=reward")).body)).toEqual([m1.id, m3.id, m2.id]);
    const p1 = (await list(a.cookie, "?sort=spent&limit=2")).body;
    expect(ids(p1)).toEqual([m2.id, m1.id]);
    expect(p1.nextCursor).toBe("2");
    const p2 = (await list(a.cookie, `?sort=spent&limit=2&cursor=${p1.nextCursor}`)).body;
    expect(ids(p2)).toEqual([m3.id]);
    expect(p2.nextCursor).toBeNull();
  });

  it("검색어 종류: 닉네임은 누구나, 이름·휴대폰 뒷자리는 개인정보 권한이 있을 때만(없으면 400)", async () => {
    const a = await shop();
    const m = await member(a, { nickname: "별빛", name: "홍길동", phone: "01011112345" });
    await member(a, { nickname: "홍길동" });
    expect(ids((await list(a.cookie, `?q=${encodeURIComponent("홍길동")}&qType=name`)).body)).toEqual([m.id]);
    expect(ids((await list(a.cookie, "?q=2345&qType=phoneLast4")).body)).toEqual([m.id]);
    expect((await list(a.cookie, "?q=23&qType=phoneLast4")).status).toBe(400);
    expect(ids((await list(a.cookie, `?q=${encodeURIComponent("별")}&qType=nickname`)).body)).toEqual([m.id]);
    const staff = await cookieOf((await createSellerUser(a.seller.id, { permissions: ["MEMBER_POINTS"] })).email);
    expect((await list(staff, `?q=${encodeURIComponent("홍길동")}&qType=name`)).status).toBe(400);
    expect((await list(staff, `?q=${encodeURIComponent("별")}&qType=nickname`)).status).toBe(200);
  });

  it("요약 6칸: 전체·이번 달 신규·이번 달 결제 회원·골드/VIP·구매 제한·혜택 동의. 탈퇴·다른 쇼핑몰은 제외하고 권한이 없으면 403", async () => {
    const a = await shop();
    const b = await shop();
    const gold = await db.memberGrade.create({ data: { sellerId: a.seller.id, displayName: "골드", sortOrder: 2, systemKey: "GOLD" } });
    const vip = await db.memberGrade.create({ data: { sellerId: a.seller.id, displayName: "VIP", sortOrder: 3, systemKey: "VIP" } });
    const now = new Date();
    const old = new Date(now.getTime() - 90 * DAY);
    const m1 = await member(a, { createdAt: old });
    const m2 = await member(a, {});
    const m3 = await member(a, {});
    const gone = await member(a, {});
    await db.buyerMember.update({ where: { id: m1.id }, data: { gradeId: gold.id, marketingConsentAt: now } });
    await db.buyerMember.update({ where: { id: m2.id }, data: { gradeId: vip.id } });
    await db.buyerMember.update({ where: { id: gone.id }, data: { status: "WITHDRAWN", deletedAt: now, gradeId: vip.id } });
    await order(a.seller.id, m1.id, now);
    await order(a.seller.id, m1.id, now); // 같은 회원의 두 번째 결제는 한 명으로 센다
    await order(a.seller.id, m3.id, old);
    await db.buyerPurchaseRestriction.create({ data: { sellerId: a.seller.id, buyerMemberId: m3.id, reason: "MANUAL", startsAt: old, endsAt: new Date(now.getTime() + DAY) } });
    const outsider = await member(b, {});
    await order(b.seller.id, outsider.id, now);
    const r = await summary(a.cookie);
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ total: 3, newThisMonth: 2, purchasedThisMonth: 1, gold: 1, vip: 1, restricted: 1, marketingConsent: 1 });
    const denied = await cookieOf((await createSellerUser(a.seller.id, { permissions: [] })).email);
    expect((await summary(denied)).status).toBe(403);
  });
});
