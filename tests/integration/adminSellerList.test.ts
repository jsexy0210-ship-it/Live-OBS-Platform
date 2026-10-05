import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as exportRoute } from "../../app/api/admin/sellers/export/route";
import { GET as listRoute } from "../../app/api/admin/sellers/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { PASSWORD, createAdmin, createBuyer, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 관리자 파트너스 목록 확장(MA-011): 요약 건수·추가 열·검색·필터·정렬·엑셀(CSV) 내려받기. 모든 마스터 역할 조회, 연락처 미노출.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000" };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function adminCookie(role: Role = "READ_ONLY") {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const list = (cookie: string, qs = "") => listRoute(new Request(`http://localhost:3000/api/admin/sellers${qs}`, { headers: { ...H, cookie } }));
const exp = (cookie: string, qs = "") => exportRoute(new Request(`http://localhost:3000/api/admin/sellers/export${qs}`, { headers: { ...H, cookie } }));
type Item = { id: string; displayStatus: string; seq: number; pg: { status: string }; live: boolean; ordersThisMonth: number; memberCount: number; lastActivityAt: string | null; payoutEnabled: boolean; noteCount: number; representativeName: string | null };
const body = async (r: Response) => (await r.json()) as { sellers: Item[]; total: number; nextCursor: string | null; summary?: Record<string, number> };
const ids = async (r: Response) => (await body(r)).sellers.map((s) => s.id);
const DAY = 86_400_000;

async function shop(over: { shopName?: string; status?: "ACTIVE" | "SUSPENDED" | "CLOSED" | "PENDING"; trial?: number | null; sub?: "ACTIVE" | "PAST_DUE" | "CANCELED" | null; rep?: string; biz?: string; createdAt?: Date } = {}) {
  const plans = await seedPlans();
  const { seller, grade } = await createSeller();
  await db.seller.update({
    where: { id: seller.id },
    data: {
      shopName: over.shopName ?? seller.shopName,
      status: over.status ?? "ACTIVE",
      trialEndsAt: over.trial === undefined ? new Date(Date.now() - DAY) : over.trial === null ? null : new Date(Date.now() + over.trial * DAY),
      planId: plans.INTEGRATED.id,
      createdAt: over.createdAt,
      businessInfo: { representativeName: over.rep ?? "홍길동", businessNumber: over.biz ?? "123-45-67890" },
    },
  });
  if (over.sub) await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plans.INTEGRATED.id, status: over.sub } });
  return { seller, grade, plans };
}
async function paidOrder(sellerId: string, buyerId: string, n: number, paidAt = new Date()) {
  const o = await db.order.create({ data: { sellerId, orderNo: n, buyerMemberId: buyerId, broadcastNicknameSnapshot: "닉", totalAmount: 10000, status: "PAID", paidAt } });
  return o;
}

describe("파트너스 목록 요약·추가 열", () => {
  it("표시 상태·번호·방송·이번 달 주문·회원 수·적립금 지급·메모 수·최근 활동을 계산하고, 요약 건수가 맞다", async () => {
    const { cookie } = await adminCookie("READ_ONLY");
    const normal = await shop({ sub: "ACTIVE", shopName: "정상몰" });
    const trial = await shop({ trial: 5, shopName: "체험몰" });
    const overdue = await shop({ sub: "PAST_DUE", shopName: "연체몰" });
    const locked = await shop({ shopName: "잠김몰" });
    const suspended = await shop({ status: "SUSPENDED", shopName: "정지몰" });
    const closed = await shop({ status: "CLOSED", shopName: "탈퇴몰" });
    await shop({ status: "PENDING", shopName: "신청중몰" });

    const buyer = await createBuyer(normal.seller.id, normal.grade.id);
    await createBuyer(normal.seller.id, normal.grade.id);
    await paidOrder(normal.seller.id, buyer.id, 1);
    await paidOrder(normal.seller.id, buyer.id, 2);
    await paidOrder(normal.seller.id, buyer.id, 3, new Date(Date.now() - 45 * DAY)); // 이번 달 아님
    await db.broadcastSession.create({ data: { sellerId: normal.seller.id, status: "LIVE" } });
    await db.rewardPolicy.create({ data: { sellerId: normal.seller.id, livePayoutEnabled: true } });
    await db.sellerAdminNote.create({ data: { sellerId: normal.seller.id, body: "확인 필요", authorId: (await adminCookie("CS")).id, authorName: "CS" } });
    const owner = await createSellerUser(normal.seller.id, "OWNER");
    await db.sellerUser.update({ where: { id: owner.id }, data: { lastLoginAt: new Date() } });

    const r = await body(await list(cookie, "?summary=1&limit=100"));
    expect(r.summary).toEqual({ total: 6, normal: 1, trial: 1, overdue: 1, locked: 1, suspended: 1, closed: 1, pgError: 0, pgNone: 4, payoutEnabled: 1, live: 1, pendingApplications: 1 });
    expect(r.total).toBe(7);
    const by = new Map(r.sellers.map((s) => [s.id, s]));
    expect(by.get(normal.seller.id)).toMatchObject({ displayStatus: "NORMAL", live: true, ordersThisMonth: 2, memberCount: 2, payoutEnabled: true, noteCount: 1, pg: { status: "NONE" } });
    expect(by.get(normal.seller.id)!.lastActivityAt).toBeTruthy();
    expect(by.get(trial.seller.id)).toMatchObject({ displayStatus: "TRIAL", live: false, ordersThisMonth: 0, memberCount: 0, payoutEnabled: false, noteCount: 0, lastActivityAt: null });
    expect(by.get(overdue.seller.id)!.displayStatus).toBe("OVERDUE");
    expect(by.get(locked.seller.id)!.displayStatus).toBe("LOCKED");
    expect(by.get(suspended.seller.id)!.displayStatus).toBe("SUSPENDED");
    expect(by.get(closed.seller.id)!.displayStatus).toBe("CLOSED");
    // 번호는 가입 순서(오래된 것이 1)
    expect([...r.sellers].sort((a, b) => a.seq - b.seq).map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 요약은 summary=1일 때만
    expect((await body(await list(cookie, "?limit=1"))).summary).toBeUndefined();
  });

  it("결제 연결 상태: 최근 실패가 성공보다 새로우면 ERROR, 성공이 있으면 OK, 기록이 없으면 NONE. 요약 pgError에 잡힌다", async () => {
    const { cookie } = await adminCookie();
    const ok = await shop({ sub: "ACTIVE" });
    const err = await shop({ sub: "ACTIVE" });
    const none = await shop({ sub: "ACTIVE" });
    const oldFail = await shop({ sub: "ACTIVE" });
    for (const [s, status, approved] of [[ok, "PAID", new Date(Date.now() - DAY)], [err, "FAILED", null]] as const) {
      const b = await createBuyer(s.seller.id, s.grade.id);
      const o = await paidOrder(s.seller.id, b.id, 1);
      await db.payment.create({ data: { sellerId: s.seller.id, orderId: o.id, provider: "fake", method: "CARD", amount: 10000, status, approvedAt: approved, failureCode: status === "FAILED" ? "nicepay_3095" : null } });
    }
    // 24시간 지난 실패만 있으면 오류가 아니다(결제 기록이 없는 것과 같이 미연결)
    {
      const b = await createBuyer(oldFail.seller.id, oldFail.grade.id);
      const o = await paidOrder(oldFail.seller.id, b.id, 1);
      const p = await db.payment.create({ data: { sellerId: oldFail.seller.id, orderId: o.id, provider: "fake", method: "CARD", amount: 10000, status: "FAILED", failureCode: "nicepay_3095" } });
      await db.$executeRaw`UPDATE "Payment" SET "updatedAt" = now() - interval '3 days' WHERE "id" = ${p.id}::uuid`;
    }
    const r = await body(await list(cookie, "?summary=1"));
    expect(new Map(r.sellers.map((s) => [s.id, s.pg.status]))).toEqual(new Map([[ok.seller.id, "OK"], [err.seller.id, "ERROR"], [none.seller.id, "NONE"], [oldFail.seller.id, "NONE"]]));
    expect(r.summary).toMatchObject({ pgError: 1, pgNone: 2 });
    expect(await ids(await list(cookie, "?pg=ERROR"))).toEqual([err.seller.id]);
    expect(await ids(await list(cookie, "?pg=OK"))).toEqual([ok.seller.id]);
  });
});

describe("검색·필터·정렬", () => {
  it("검색 칸(전체·쇼핑몰 이름·대표자·이메일·주소·사업자번호)과 필터를 건다. 쇼핑몰 격리: 다른 쇼핑몰 값은 섞이지 않는다", async () => {
    const { cookie } = await adminCookie();
    const a = await shop({ shopName: "별빛 카드숍", rep: "김철수", biz: "111-22-33333", sub: "ACTIVE" });
    const b = await shop({ shopName: "달빛 마켓", rep: "이영희", biz: "444-55-66666", trial: 3 });
    await createSellerUser(a.seller.id, "OWNER", "owner-a@example.com");
    await createSellerUser(b.seller.id, "OWNER", "owner-b@example.com");
    const q = (s: string, f = "") => `?q=${encodeURIComponent(s)}${f ? `&field=${f}` : ""}`;
    expect(await ids(await list(cookie, q("별빛")))).toEqual([a.seller.id]);
    expect(await ids(await list(cookie, q("철수", "rep")))).toEqual([a.seller.id]);
    expect(await ids(await list(cookie, q("철수", "shop")))).toEqual([]);
    expect(await ids(await list(cookie, q("owner-b@", "email")))).toEqual([b.seller.id]);
    expect(await ids(await list(cookie, q("4445566666", "biz")))).toEqual([b.seller.id]);
    expect(await ids(await list(cookie, q("444-55", "biz")))).toEqual([b.seller.id]);
    expect(await ids(await list(cookie, q(a.seller.slug, "slug")))).toEqual([a.seller.id]);
    expect(await ids(await list(cookie, q("owner-a@")))).toEqual([a.seller.id]);
    expect(await ids(await list(cookie, "?state=TRIAL"))).toEqual([b.seller.id]);
    expect(await ids(await list(cookie, "?state=NORMAL"))).toEqual([a.seller.id]);
    expect(await ids(await list(cookie, "?state=NORMAL&q=달빛"))).toEqual([]);
  });

  it("방송 중·실지급·확인 메모·가입일·최근 활동 필터, 정렬(최근 활동·주문 많은순·연체 먼저·가입일)", async () => {
    const { cookie, id: adminId } = await adminCookie();
    const old = await shop({ sub: "ACTIVE", createdAt: new Date("2026-01-10T00:00:00Z"), shopName: "오래된몰" });
    const busy = await shop({ sub: "ACTIVE", createdAt: new Date("2026-03-10T00:00:00Z"), shopName: "바쁜몰" });
    const late = await shop({ sub: "PAST_DUE", createdAt: new Date("2026-05-10T00:00:00Z"), shopName: "연체몰" });
    const buyer = await createBuyer(busy.seller.id, busy.grade.id);
    for (let i = 1; i <= 3; i++) await paidOrder(busy.seller.id, buyer.id, i);
    const ob = await createBuyer(old.seller.id, old.grade.id);
    await paidOrder(old.seller.id, ob.id, 1, new Date(Date.now() - 100 * DAY)); // 이번 달 주문은 없지만 오래된 활동
    await db.order.updateMany({ where: { sellerId: old.seller.id }, data: { createdAt: new Date(Date.now() - 100 * DAY) } });
    await db.broadcastSession.create({ data: { sellerId: busy.seller.id, status: "LIVE" } });
    await db.rewardPolicy.create({ data: { sellerId: late.seller.id, livePayoutEnabled: true } });
    await db.sellerAdminNote.create({ data: { sellerId: old.seller.id, body: "메모", authorId: adminId, authorName: "관리자" } });

    expect(await ids(await list(cookie, "?live=1"))).toEqual([busy.seller.id]);
    expect(await ids(await list(cookie, "?payout=1"))).toEqual([late.seller.id]);
    expect(await ids(await list(cookie, "?note=1"))).toEqual([old.seller.id]);
    expect(await ids(await list(cookie, "?joinedFrom=2026-03-01&joinedTo=2026-03-31"))).toEqual([busy.seller.id]);
    expect(await ids(await list(cookie, "?active=7d"))).toEqual([busy.seller.id]);
    expect((await ids(await list(cookie, "?active=inactive30"))).sort()).toEqual([late.seller.id, old.seller.id].sort());
    expect(await ids(await list(cookie, "?sort=orders"))).toEqual([busy.seller.id, late.seller.id, old.seller.id]);
    expect((await ids(await list(cookie, "?sort=overdue")))[0]).toBe(late.seller.id);
    expect((await ids(await list(cookie, "?sort=activity")))[0]).toBe(busy.seller.id);
    expect(await ids(await list(cookie, "?sort=joined"))).toEqual([late.seller.id, busy.seller.id, old.seller.id]);
    // 오프셋 쪽 이동에도 전체 수가 같다
    const p1 = await body(await list(cookie, "?sort=joined&limit=2"));
    expect(p1.total).toBe(3);
    const p2 = await body(await list(cookie, `?sort=joined&limit=2&cursor=${p1.nextCursor}`));
    expect([...p1.sellers, ...p2.sellers].map((s) => s.id)).toEqual([late.seller.id, busy.seller.id, old.seller.id]);
    expect(p2.nextCursor).toBeNull();
    for (const qs of ["?sort=x", "?state=x", "?pg=x", "?active=x", "?field=x", "?live=2", "?joinedFrom=2026-13-01", "?joinedFrom=2026-04-02&joinedTo=2026-04-01", "?summary=x"]) expect((await list(cookie, qs)).status).toBe(400);
  });
});

describe("권한·연락처 미노출", () => {
  it("모든 마스터 역할이 보고, 로그인 없음·파트너스 세션은 401. 응답 어디에도 대표자 이메일·전화가 없다", async () => {
    const a = await shop({ sub: "ACTIVE" });
    const owner = await createSellerUser(a.seller.id, "OWNER", "secret-owner@example.com");
    await db.sellerUser.update({ where: { id: owner.id }, data: { phone: "01012345678" } });
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      const { cookie } = await adminCookie(role);
      const r = await list(cookie, "?summary=1");
      expect(r.status).toBe(200);
      expect(JSON.stringify(await r.json())).not.toMatch(/secret-owner@example\.com|01012345678/);
      expect((await exp(cookie)).status).toBe(200);
    }
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    for (const c of ["", `lo_seller=${login.token}`]) {
      expect((await list(c)).status).toBe(401);
      expect((await exp(c)).status).toBe(401);
    }
  });
});

describe("엑셀(CSV) 내려받기 GET /api/admin/sellers/export", () => {
  it("같은 조건으로 내려받고(BOM·열 이름·상태 한글), 연락처·수식 문자는 없고, 내려받은 사실이 로그 추적에 남는다", async () => {
    const { cookie, id } = await adminCookie("CS");
    const a = await shop({ sub: "ACTIVE", shopName: "=SUM(A1)" });
    const b = await shop({ sub: "PAST_DUE", shopName: "연체몰" });
    await createSellerUser(a.seller.id, "OWNER", "csv-owner@example.com");
    const r = await exp(cookie, "?state=OVERDUE");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toMatch(/attachment; filename="partners-\d{8}\.csv"/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM(엑셀이 한글을 바로 읽도록)
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.startsWith("﻿번호,쇼핑몰 이름,쇼핑몰 주소,상태,구독,결제 연결,방송 중,이번 달 주문,회원 수,가입일,최근 활동")).toBe(true);
    expect(text).toContain("연체몰");
    expect(text).toContain("연체");
    expect(text).not.toContain("SUM(A1)");
    const all = await (await exp(cookie)).text();
    expect(all).toContain("'=SUM(A1)");
    expect(all).not.toMatch(/csv-owner@example\.com|@/);
    expect(b.seller.id).toBeTruthy();
    const logs = await db.auditLog.findMany({ where: { action: "admin.sellers.export", actorId: id } });
    expect(logs).toHaveLength(2);
    expect(logs[0].after).toMatchObject({ rows: expect.any(Number), filters: expect.any(Object) });
    expect((await exp(cookie, "?sort=x")).status).toBe(400);
  });
});
