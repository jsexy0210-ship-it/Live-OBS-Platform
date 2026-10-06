import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as adminClose } from "../../app/api/admin/platform-inquiries/[inquiryId]/close/route";
import { GET as adminGetOne } from "../../app/api/admin/platform-inquiries/[inquiryId]/route";
import { POST as adminReply } from "../../app/api/admin/platform-inquiries/[inquiryId]/reply/route";
import { POST as sellerClose } from "../../app/api/seller/platform-inquiries/[inquiryId]/close/route";
import { POST as sellerMessage } from "../../app/api/seller/platform-inquiries/[inquiryId]/messages/route";
import { POST as sellerRate } from "../../app/api/seller/platform-inquiries/[inquiryId]/rating/route";
import { GET as sellerGetOne } from "../../app/api/seller/platform-inquiries/[inquiryId]/route";
import { GET as relatedOptions } from "../../app/api/seller/platform-inquiries/related-options/route";
import { GET as sellerList, POST as sellerCreate } from "../../app/api/seller/platform-inquiries/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { PLATFORM_INQUIRY_MESSAGES, RELATED_OPTIONS } from "../../lib/server/platform-inquiries/service";
import { PASSWORD, createAdmin, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 파트너스 문의 보강(SA-113~115): 상태·분류 필터·건수, 관련 주문·방송, 파트너스 종료, 도움됨 평가, 처리 이력
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const iq = (inquiryId: string) => ({ params: Promise.resolve({ inquiryId }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const NEW = { category: "BILLING", title: "청구 금액 문의", body: "이번 달 청구가 두 번 나왔습니다." };

async function login(sellerId: string, kind: "OWNER" | "STAFF") {
  const u = await createSellerUser(sellerId, kind === "OWNER" ? "OWNER" : { permissions: [] });
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { id: u.id, cookie: `lo_seller=${r.token}` };
}
async function shop() {
  const { seller, grade } = await createSeller();
  return { seller, grade, owner: await login(seller.id, "OWNER"), staff: await login(seller.id, "STAFF") };
}
async function csCookie() {
  const a = await createAdmin("CS");
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const create = async (cookie: string, body: unknown = NEW) => json(await sellerCreate(req("/api/seller/platform-inquiries", cookie, "POST", body)));
const list = async (cookie: string, qs = "") => json(await sellerList(req(`/api/seller/platform-inquiries${qs}`, cookie)));
const detail = async (cookie: string, id: string) => json(await sellerGetOne(req(`/api/seller/platform-inquiries/${id}`, cookie), iq(id)));
const follow = async (cookie: string, id: string, body: unknown) => json(await sellerMessage(req(`/api/seller/platform-inquiries/${id}/messages`, cookie, "POST", body), iq(id)));
const reply = async (cookie: string, id: string, body: unknown) => json(await adminReply(req(`/api/admin/platform-inquiries/${id}/reply`, cookie, "POST", body), iq(id)));
const adminClosing = async (cookie: string, id: string, body: unknown) => json(await adminClose(req(`/api/admin/platform-inquiries/${id}/close`, cookie, "POST", body), iq(id)));
const closeIt = async (cookie: string, id: string, body: unknown = {}) => json(await sellerClose(req(`/api/seller/platform-inquiries/${id}/close`, cookie, "POST", body), iq(id)));
const rate = async (cookie: string, id: string, body: unknown) => json(await sellerRate(req(`/api/seller/platform-inquiries/${id}/rating`, cookie, "POST", body), iq(id)));

async function order(sellerId: string, buyerId: string, orderNo: number, at: string, nickname = "닉") {
  return db.order.create({ data: { sellerId, orderNo, buyerMemberId: buyerId, broadcastNicknameSnapshot: nickname, totalAmount: 1000, status: "PAID", createdAt: new Date(at) } });
}

describe("목록: 상태·분류 필터, 건수, 마지막 답변", () => {
  it("status·category로 거르고, counts는 조건과 무관한 전체 상태별 건수, newReplyCount는 새 답변 문의 수다. 틀린 값은 400", async () => {
    const s = await shop();
    const cs = await csCookie();
    const a = (await create(s.owner.cookie, { ...NEW, title: "A", category: "BILLING" })).body.inquiry.id as string;
    const b = (await create(s.owner.cookie, { ...NEW, title: "B", category: "BUG" })).body.inquiry.id as string;
    const c = (await create(s.owner.cookie, { ...NEW, title: "C", category: "BILLING" })).body.inquiry.id as string;
    // A 답변, C 답변 후 종료(마스터)
    expect((await reply(cs, a, { body: "확인했습니다", expectedVersion: 0 })).status).toBe(200);
    expect((await reply(cs, c, { body: "확인했습니다", expectedVersion: 0 })).status).toBe(200);
    expect((await adminClosing(cs, c, { expectedVersion: 1 })).status).toBe(200);

    let l = await list(s.owner.cookie);
    expect(l.body.counts).toEqual({ all: 3, open: 1, answered: 1, closed: 1 });
    expect(l.body.newReplyCount).toBe(2); // A·C 모두 아직 안 열어 봄
    const byTitle = Object.fromEntries(l.body.items.map((x: { title: string }) => [x.title, x]));
    expect(byTitle.A.lastReplyAt).not.toBeNull();
    expect(byTitle.B.lastReplyAt).toBeNull();

    l = await list(s.owner.cookie, "?status=ANSWERED");
    expect(l.body.items.map((x: { id: string }) => x.id)).toEqual([a]);
    expect(l.body.counts).toEqual({ all: 3, open: 1, answered: 1, closed: 1 }); // 조건과 무관
    expect((await list(s.owner.cookie, "?status=OPEN")).body.items.map((x: { id: string }) => x.id)).toEqual([b]);
    expect((await list(s.owner.cookie, "?status=CLOSED")).body.items.map((x: { id: string }) => x.id)).toEqual([c]);
    expect((await list(s.owner.cookie, "?category=BILLING")).body.items.map((x: { id: string }) => x.id).sort()).toEqual([a, c].sort());
    expect((await list(s.owner.cookie, "?category=BILLING&status=CLOSED")).body.items.map((x: { id: string }) => x.id)).toEqual([c]);
    expect((await list(s.owner.cookie, "?category=BUG&status=CLOSED")).body.items).toEqual([]);

    // 열어 보면 새 답변이 줄어든다
    await detail(s.owner.cookie, a);
    expect((await list(s.owner.cookie)).body.newReplyCount).toBe(1);
    for (const [qs, error] of [["?status=DONE", "invalid_status"], ["?category=NOPE", "invalid_category"], ["?cursor=bad", "invalid_cursor"]] as const) {
      expect(await list(s.owner.cookie, qs)).toEqual({ status: 400, body: { error, message: PLATFORM_INQUIRY_MESSAGES[error] } });
    }
    // 직원은 자기가 쓴 것만 센다, 다른 쇼핑몰은 따로
    expect((await list(s.staff.cookie)).body.counts).toEqual({ all: 0, open: 0, answered: 0, closed: 0 });
    const other = await shop();
    expect((await list(other.owner.cookie)).body).toMatchObject({ items: [], counts: { all: 0 }, newReplyCount: 0 });
  });

  it("필터와 커서를 함께 써도 20건씩 빠짐·겹침 없이 이어진다", async () => {
    const s = await shop();
    for (let i = 0; i < 23; i++) {
      await db.platformInquiry.create({ data: { sellerId: s.seller.id, createdBySellerUserId: s.owner.id, category: "OTHER", title: `문의 ${i}`, status: i % 2 === 0 ? "OPEN" : "ANSWERED", lastMessageAt: new Date(2026, 8, 1, 0, i) } });
    }
    const first = await list(s.owner.cookie, "?status=OPEN");
    expect(first.body.items).toHaveLength(12);
    expect(first.body.nextCursor).toBeNull();
    const all = await list(s.owner.cookie);
    expect(all.body.items).toHaveLength(20);
    const second = await list(s.owner.cookie, `?cursor=${encodeURIComponent(all.body.nextCursor)}`);
    expect(new Set([...all.body.items, ...second.body.items].map((x: { id: string }) => x.id)).size).toBe(23);
    expect(all.body.counts).toEqual({ all: 23, open: 12, answered: 11, closed: 0 });
  });
});

describe("관련 주문·방송", () => {
  it("선택 목록은 이 쇼핑몰의 최근 방송·주문(최신순, 20개)만, 보낼 때 같은 쇼핑몰 것만 받고 상세에 나온다", async () => {
    const s = await shop();
    const o = await shop();
    const buyer = await createBuyer(s.seller.id, s.grade.id);
    const otherBuyer = await createBuyer(o.seller.id, o.grade.id);
    const mine1 = await order(s.seller.id, buyer.id, 1, "2026-10-01T05:10:00Z", "밤하늘");
    const mine2 = await order(s.seller.id, buyer.id, 2, "2026-10-02T05:10:00Z", "별");
    const theirs = await order(o.seller.id, otherBuyer.id, 1, "2026-10-02T05:10:00Z");
    const b1 = await db.broadcastSession.create({ data: { sellerId: s.seller.id, title: "10/1 방송", status: "ENDED", startedAt: new Date("2026-10-01T10:00:00Z") } });
    const b2 = await db.broadcastSession.create({ data: { sellerId: s.seller.id, title: null, status: "ENDED", startedAt: new Date("2026-10-02T10:00:00Z") } });
    const theirB = await db.broadcastSession.create({ data: { sellerId: o.seller.id, title: "남의 방송", status: "ENDED" } });

    const opts = await json(await relatedOptions(req("/api/seller/platform-inquiries/related-options", s.staff.cookie)));
    expect(opts.status).toBe(200);
    expect(opts.body.broadcasts.map((x: { id: string }) => x.id)).toEqual([b2.id, b1.id]);
    expect(opts.body.orders.map((x: { id: string }) => x.id)).toEqual([mine2.id, mine1.id]);
    expect(opts.body.orders[0]).toMatchObject({ orderNoLabel: expect.stringMatching(/^\d{8}-0002$/), nickname: "별" });
    expect(JSON.stringify(opts.body)).not.toContain(theirs.id);
    expect(RELATED_OPTIONS).toBe(20);

    const made = await create(s.staff.cookie, { ...NEW, relatedOrderId: mine1.id, relatedBroadcastId: b1.id });
    expect(made.status).toBe(201);
    expect(made.body.inquiry.related).toEqual({
      order: { id: mine1.id, orderNoLabel: expect.stringMatching(/^\d{8}-0001$/), nickname: "밤하늘", createdAt: mine1.createdAt.toISOString() },
      broadcast: { id: b1.id, title: "10/1 방송", startedAt: b1.startedAt.toISOString() },
    });
    // 없이 보내면 둘 다 null
    expect((await create(s.staff.cookie)).body.inquiry.related).toEqual({ order: null, broadcast: null });
    // 다른 쇼핑몰·없는 id·형식 오류는 400 invalid_related, 문의는 만들어지지 않는다
    const before = await db.platformInquiry.count();
    for (const extra of [{ relatedOrderId: theirs.id }, { relatedBroadcastId: theirB.id }, { relatedOrderId: "00000000-0000-4000-8000-000000000000" }, { relatedBroadcastId: "x" }, { relatedOrderId: 5 }]) {
      expect(await create(s.staff.cookie, { ...NEW, ...extra })).toEqual({ status: 400, body: { error: "invalid_related", message: PLATFORM_INQUIRY_MESSAGES.invalid_related } });
    }
    expect(await db.platformInquiry.count()).toBe(before);
    // 로그인 없이는 선택 목록을 볼 수 없다
    expect((await relatedOptions(req("/api/seller/platform-inquiries/related-options", ""))).status).toBe(401);
  });
});

describe("종료·도움됨 평가·처리 이력", () => {
  it("파트너스가 종료하면 CLOSED(closedBy PARTNER)·추가 문의 막힘·마스터 답변 막힘, 이미 종료는 409, 직원은 남의 문의를 닫을 수 없다", async () => {
    const s = await shop();
    const cs = await csCookie();
    const other = await login(s.seller.id, "STAFF");
    const id = (await create(s.staff.cookie)).body.inquiry.id as string;
    expect((await closeIt(other.cookie, id)).status).toBe(404);
    expect((await closeIt((await shop()).owner.cookie, id)).status).toBe(404);
    expect((await closeIt(s.staff.cookie, id, { helpful: "yes" }))).toEqual({ status: 400, body: { error: "invalid_helpful", message: PLATFORM_INQUIRY_MESSAGES.invalid_helpful } });
    const closed = await closeIt(s.staff.cookie, id);
    expect(closed.status).toBe(200);
    expect(closed.body.inquiry).toMatchObject({ status: "CLOSED", closedBy: "PARTNER", canClose: false, helpful: null });
    expect(closed.body.inquiry.closedAt).not.toBeNull();
    expect(await closeIt(s.staff.cookie, id)).toEqual({ status: 409, body: { error: "inquiry_closed", message: PLATFORM_INQUIRY_MESSAGES.inquiry_closed } });
    expect((await follow(s.staff.cookie, id, { body: "더" })).status).toBe(409);
    expect((await reply(cs, id, { body: "답", expectedVersion: 1 })).status).toBe(409);
    const row = await db.platformInquiry.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "CLOSED", closedBySellerUserId: s.staff.id, closedByAdminId: null, version: 1 });
    expect(await db.auditLog.count({ where: { action: "platform_inquiry.close", targetId: id } })).toBe(1);
    // 대표자는 직원의 문의도 닫을 수 있다
    const id2 = (await create(s.staff.cookie)).body.inquiry.id as string;
    expect((await closeIt(s.owner.cookie, id2)).body.inquiry.status).toBe("CLOSED");
  });

  it("도움됨 평가는 플랫폼 답변이 있은 뒤 한 번만(종료 전후 모두), 종료와 함께도 남길 수 있다. 마스터 상세에도 보인다", async () => {
    const s = await shop();
    const cs = await csCookie();
    const id = (await create(s.owner.cookie)).body.inquiry.id as string;
    expect((await detail(s.owner.cookie, id)).body.inquiry).toMatchObject({ helpful: null, canRate: false, canClose: true });
    expect(await rate(s.owner.cookie, id, { helpful: true })).toEqual({ status: 409, body: { error: "no_reply_yet", message: PLATFORM_INQUIRY_MESSAGES.no_reply_yet } });
    await reply(cs, id, { body: "확인했습니다", expectedVersion: 0 });
    expect((await detail(s.owner.cookie, id)).body.inquiry.canRate).toBe(true);
    for (const body of [{}, { helpful: "yes" }, { helpful: null }, { helpful: 1 }]) {
      expect(await rate(s.owner.cookie, id, body)).toEqual({ status: 400, body: { error: "invalid_helpful", message: PLATFORM_INQUIRY_MESSAGES.invalid_helpful } });
    }
    expect(await rate(s.owner.cookie, id, { helpful: false })).toEqual({ status: 200, body: { helpful: false } });
    expect(await rate(s.owner.cookie, id, { helpful: true })).toEqual({ status: 409, body: { error: "already_rated", message: PLATFORM_INQUIRY_MESSAGES.already_rated } });
    const d = (await detail(s.owner.cookie, id)).body.inquiry;
    expect(d).toMatchObject({ helpful: false, canRate: false });
    expect(d.helpfulAt).not.toBeNull();
    // 마스터 상세에도 평가가 보인다
    const admin = await json(await adminGetOne(req(`/api/admin/platform-inquiries/${id}`, cs), iq(id)));
    expect(admin.body.inquiry ?? admin.body).toMatchObject({ helpful: false });
    // 동시에 두 번 평가해도 하나만
    const id2 = (await create(s.owner.cookie)).body.inquiry.id as string;
    await reply(cs, id2, { body: "답", expectedVersion: 0 });
    const rs = await Promise.all([rate(s.owner.cookie, id2, { helpful: true }), rate(s.owner.cookie, id2, { helpful: false })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    // 종료와 함께 평가
    const id3 = (await create(s.owner.cookie)).body.inquiry.id as string;
    await reply(cs, id3, { body: "답", expectedVersion: 0 });
    expect((await closeIt(s.owner.cookie, id3, { helpful: true })).body.inquiry).toMatchObject({ status: "CLOSED", helpful: true, canRate: false });
    // 답변 없이 종료하면서 보낸 평가는 무시(평가 안 남음)
    const id4 = (await create(s.owner.cookie)).body.inquiry.id as string;
    expect((await closeIt(s.owner.cookie, id4, { helpful: true })).body.inquiry).toMatchObject({ status: "CLOSED", helpful: null });
    // 종료 뒤에도 평가할 수 있다(마스터가 닫은 문의)
    const id5 = (await create(s.owner.cookie)).body.inquiry.id as string;
    await reply(cs, id5, { body: "답", expectedVersion: 0 });
    await adminClosing(cs, id5, { expectedVersion: 1 });
    expect((await rate(s.owner.cookie, id5, { helpful: true })).status).toBe(200);
    // 남의 문의·다른 쇼핑몰·없는 id는 404
    const other = await login(s.seller.id, "STAFF");
    expect((await rate(other.cookie, id, { helpful: true })).status).toBe(404);
    expect((await rate((await shop()).owner.cookie, id, { helpful: true })).status).toBe(404);
    expect((await rate(s.owner.cookie, "not-a-uuid", { helpful: true })).status).toBe(404);
  });

  it("처리 이력은 접수·답변·추가 문의·종료를 최신순으로 주고, 마스터 관리자 이름·id는 없다", async () => {
    const s = await shop();
    const cs = await csCookie();
    const id = (await create(s.owner.cookie)).body.inquiry.id as string;
    await reply(cs, id, { body: "첫 답변", expectedVersion: 0 });
    await follow(s.owner.cookie, id, { body: "추가 문의" });
    await reply(cs, id, { body: "두 번째 답변", expectedVersion: 2 });
    await closeIt(s.owner.cookie, id);
    const d = (await detail(s.owner.cookie, id)).body.inquiry;
    expect(d.history.map((h: { type: string; actor: string }) => [h.type, h.actor])).toEqual([
      ["CLOSED", "PARTNER"],
      ["ANSWERED", "PLATFORM"],
      ["FOLLOWUP", "PARTNER"],
      ["ANSWERED", "PLATFORM"],
      ["RECEIVED", "PARTNER"],
    ]);
    const times = d.history.map((h: { at: string }) => new Date(h.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(JSON.stringify(d)).not.toMatch(/adminId|closedByAdmin|closedBySeller|relatedOrderId|relatedBroadcastId/);
    // 마스터가 닫으면 actor는 PLATFORM
    const id2 = (await create(s.owner.cookie)).body.inquiry.id as string;
    await adminClosing(cs, id2, { expectedVersion: 0 });
    const d2 = (await detail(s.owner.cookie, id2)).body.inquiry;
    expect(d2.closedBy).toBe("PLATFORM");
    expect(d2.history[0]).toMatchObject({ type: "CLOSED", actor: "PLATFORM" });
  });
});
