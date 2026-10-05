import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listGet, POST as createPost } from "../../app/api/seller/member-messages/route";
import { POST as previewPost } from "../../app/api/seller/member-messages/preview/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { SCHEDULED_JOBS } from "../../lib/server/jobs/scheduler";
import { cancelMessage, createMessage, getMessage, listMessages, previewMessage, processDueMemberMessages, updateMessage } from "../../lib/server/shop-member-messages/service";
import { inAdWindow, nextAdTime, renderBody } from "../../lib/server/shop-member-messages/rules";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 회원 알림 발송(SA-049, 발송 기록만): 대상 7종·수신 동의 필터·광고성 시간(KST)·하루 2건 한도(동시)·예약·수정·취소·정기 처리·요약·탈퇴·권한·판매자 격리.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const DAY = 86_400_000;
// KST 시각 문자열 → Date
const kst = (s: string) => new Date(`${s}+09:00`);

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const staff = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const product = await db.product.create({ data: { sellerId: seller.id, name: "섀도 울프", price: 10_000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1장", stock: 100 } });
  const member = async (consent = true, gradeId = grade.id) => {
    const m = await createLoginBuyer(seller.id, gradeId);
    return consent ? db.buyerMember.update({ where: { id: m.id }, data: { marketingConsentAt: new Date(), marketingConsentVersion: "v1" } }) : m;
  };
  const paid = (memberId: string, ago: number, productId = product.id, amount = 10_000) =>
    db.order.create({
      data: {
        sellerId: seller.id,
        orderNo: Math.floor(Math.random() * 1e9),
        buyerMemberId: memberId,
        status: "PAID",
        broadcastNicknameSnapshot: "닉",
        totalAmount: amount,
        paidAt: new Date(Date.now() - ago),
        items: { create: { productId, optionId: option.id, productNameSnapshot: "섀도 울프", optionNameSnapshot: "1장", unitPrice: amount, quantity: 1 } },
      },
    });
  return { seller, owner, staff, ctx, grade, product, option, member, paid };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const input = (extra: Record<string, unknown> = {}) => ({ title: "재입고 안내", kind: "INFO", channel: "ALIMTALK_SMS", body: "섀도 울프가 다시 들어왔어요", target: { type: "ALL" }, sendMode: "NOW", ...extra });
const send = (s: Shop, extra: Record<string, unknown> = {}) => createMessage(db, s.ctx, input(extra));
const okMsg = async (p: ReturnType<typeof send>) => {
  const r = await p;
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("순수 규칙: 광고성 시간(KST)·최종 문구", () => {
  it("08:00 ~ 21:00(KST)만 광고성 시간이고, 밖이면 다음 08:00이다", () => {
    expect(inAdWindow(kst("2026-11-02T08:00:00"))).toBe(true);
    expect(inAdWindow(kst("2026-11-02T20:59:59"))).toBe(true);
    expect(inAdWindow(kst("2026-11-02T21:00:00"))).toBe(false);
    expect(inAdWindow(kst("2026-11-02T07:59:59"))).toBe(false);
    expect(nextAdTime(kst("2026-11-02T22:30:00")).toISOString()).toBe(kst("2026-11-03T08:00:00").toISOString());
    expect(nextAdTime(kst("2026-11-02T03:00:00")).toISOString()).toBe(kst("2026-11-02T08:00:00").toISOString());
    expect(nextAdTime(kst("2026-11-02T12:00:00")).toISOString()).toBe(kst("2026-11-02T12:00:00").toISOString());
  });
  it("광고성 문구에는 (광고)·쇼핑몰 이름·무료 수신거부가 붙고, 정보성은 쇼핑몰 이름만 붙는다", () => {
    expect(renderBody("AD", "카드숍", "안내")).toBe("(광고) [카드숍] 안내\n무료 수신거부 [수신거부 번호]");
    expect(renderBody("INFO", "카드숍", "안내")).toBe("[카드숍] 안내");
  });
});

describe("대상·수신 동의", () => {
  it("광고성은 동의 회원만, 정보성은 정상 회원 전체이고, 탈퇴·휴면 회원은 제외한다", async () => {
    const s = await shop();
    await s.member(true);
    await s.member(true);
    await s.member(false);
    const dormant = await s.member(true);
    await db.buyerMember.update({ where: { id: dormant.id }, data: { status: "DORMANT" } });
    const ad = await previewMessage(db, s.ctx, input({ kind: "AD" }));
    expect(ad).toMatchObject({ ok: true, matched: 3, consented: 2, noConsent: 1, finalCount: 2 });
    const info = await previewMessage(db, s.ctx, input({ kind: "INFO" }));
    expect(info).toMatchObject({ ok: true, matched: 3, consented: 3, noConsent: 0, finalCount: 3 });
    // 광고성으로 보내면 동의 회원 2명만 기록된다
    const r = await okMsg(send(s, { kind: "AD", sendMode: "SCHEDULE", scheduledAt: new Date(Date.now() + DAY - (Date.now() % DAY) + 4 * 3600_000).toISOString() }));
    expect(r.message.estimatedCount).toBe(2);
  });

  it("대상 7종: 등급·찜·최근 30일 구매·90일 미구매·특정 상품 구매·직접 선택", async () => {
    const s = await shop();
    const vip = await db.memberGrade.create({ data: { sellerId: s.seller.id, displayName: "VIP", sortOrder: 5, minAmount: 1000 } });
    const a = await s.member(true, vip.id);
    const b = await s.member(true);
    const c = await s.member(true);
    const other = await db.product.create({ data: { sellerId: s.seller.id, name: "다른 상품", price: 5_000, status: "ON_SALE" } });
    await db.wishItem.create({ data: { sellerId: s.seller.id, buyerMemberId: b.id, productId: s.product.id } });
    await s.paid(a.id, 5 * DAY); // 최근 30일·특정 상품(섀도 울프)
    await s.paid(c.id, 60 * DAY, other.id); // 90일 안 구매, 30일은 아님
    const count = async (target: Record<string, unknown>) => ((await previewMessage(db, s.ctx, input({ target }))) as { matched: number }).matched;
    expect(await count({ type: "ALL" })).toBe(3);
    expect(await count({ type: "GRADE", gradeIds: [vip.id] })).toBe(1);
    expect(await count({ type: "WISHED", productId: s.product.id })).toBe(1);
    expect(await count({ type: "BOUGHT_30D" })).toBe(1);
    expect(await count({ type: "NOT_BOUGHT_90D" })).toBe(1); // b만 90일 안에 구매가 없다
    expect(await count({ type: "PRODUCT_BOUGHT", productId: s.product.id })).toBe(1);
    expect(await count({ type: "PRODUCT_BOUGHT", productId: other.id })).toBe(1);
    expect(await count({ type: "PICKED", memberIds: [a.id, b.id] })).toBe(2);
    // 입력 반례
    const bad = async (target: unknown) => ((await createMessage(db, s.ctx, input({ target }))) as { reason?: string }).reason;
    expect(await bad({ type: "GRADE", gradeIds: [] })).toBe("invalid_target");
    expect(await bad({ type: "GRADE", gradeIds: ["x"] })).toBe("invalid_target");
    expect(await bad({ type: "WISHED" })).toBe("invalid_target");
    expect(await bad({ type: "NOPE" })).toBe("invalid_target");
    expect(await bad({ type: "PICKED", memberIds: [a.id, a.id] })).toBe("invalid_target");
    // 다른 쇼핑몰의 등급·상품은 대상으로 쓸 수 없다
    const other2 = await shop();
    expect(await bad({ type: "GRADE", gradeIds: [other2.grade.id] })).toBe("invalid_target");
    expect(await bad({ type: "WISHED", productId: other2.product.id })).toBe("invalid_target");
    // 직접 선택한 회원이 다른 쇼핑몰 회원이면 대상 수에 들어가지 않는다
    const foreign = await other2.member(true);
    expect(await count({ type: "PICKED", memberIds: [foreign.id] })).toBe(0);
  });
});

describe("보내는 시각·광고성 시간·예약", () => {
  it("정보성 「지금」은 바로 기록하고, 받는 사람이 없으면 거절한다", async () => {
    const s = await shop();
    expect(await send(s)).toEqual({ ok: false, reason: "no_recipients" });
    expect(await db.memberMessage.count()).toBe(0);
    await s.member(false);
    const r = await okMsg(send(s));
    expect(r.message).toMatchObject({ status: "RECORDED", recipientCount: 1, kind: "INFO" });
    expect(await db.memberMessageRecipient.count({ where: { messageId: r.message.id } })).toBe(1);
    expect(r.message.renderedBody).toContain(`[${s.seller.shopName}] 섀도 울프가 다시 들어왔어요`);
  });

  it("예약은 미래 30일 안만 되고, 광고성 예약이 21시 밖이면 거절하며 다음 08:00을 알려 준다", async () => {
    const s = await shop();
    await s.member(true);
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    expect(await send(s, { sendMode: "SCHEDULE", scheduledAt: at(-DAY) })).toMatchObject({ ok: false, reason: "schedule_out_of_range" });
    expect(await send(s, { sendMode: "SCHEDULE", scheduledAt: at(31 * DAY) })).toMatchObject({ ok: false, reason: "schedule_out_of_range" });
    expect(await send(s, { sendMode: "SCHEDULE", scheduledAt: "nope" })).toMatchObject({ ok: false, reason: "invalid_schedule" });
    expect(await send(s, { sendMode: "SCHEDULE" })).toMatchObject({ ok: false, reason: "invalid_schedule" });
    // 내일 22:30(KST) 광고성
    const night = new Date(kst("2026-01-01T22:30:00").getTime());
    while (night.getTime() < Date.now() + 2 * DAY) night.setTime(night.getTime() + DAY);
    const r = await send(s, { kind: "AD", sendMode: "SCHEDULE", scheduledAt: night.toISOString() });
    expect(r).toMatchObject({ ok: false, reason: "ad_time_window" });
    expect(new Date((r as unknown as { suggestedAt: Date }).suggestedAt).toISOString()).toBe(nextAdTime(night).toISOString());
    // 정보성은 같은 시각도 된다
    expect(await send(s, { kind: "INFO", sendMode: "SCHEDULE", scheduledAt: night.toISOString() })).toMatchObject({ ok: true, message: { status: "SCHEDULED" } });
  });

  it("예약은 수정·취소할 수 있고, 시각이 되면 정기 작업이 대상을 다시 계산해 기록으로 바꾼다", async () => {
    const s = await shop();
    const a = await s.member(true);
    const r = await okMsg(send(s, { sendMode: "SCHEDULE", scheduledAt: new Date(Date.now() + 2 * DAY).toISOString() }));
    const id = r.message.id;
    expect(await db.memberMessageRecipient.count({ where: { messageId: id } })).toBe(0); // 예약은 받는 사람 행이 없다
    // 수정: 제목·문구·채널·시각
    const edited = await updateMessage(db, s.ctx, id, { title: "수정한 제목", channel: "MAIL", body: "고친 문구", sendMode: "SCHEDULE", scheduledAt: new Date(Date.now() + 3 * DAY).toISOString() });
    expect(edited).toMatchObject({ ok: true, message: { title: "수정한 제목", channel: "MAIL", body: "고친 문구", kind: "INFO" } });
    expect(await updateMessage(db, s.ctx, id, { title: "", channel: "MAIL", body: "x", scheduledAt: new Date(Date.now() + 3 * DAY).toISOString() })).toMatchObject({ ok: false, reason: "invalid_title" });
    // 시각이 되기 전에는 처리하지 않는다. 그사이 새로 가입·동의한 회원도 대상에 들어간다
    expect(await processDueMemberMessages(db, new Date())).toBe(0);
    const late = await s.member(true);
    const due = new Date(Date.now() + 4 * DAY);
    expect(await processDueMemberMessages(db, due)).toBe(1);
    const done = await db.memberMessage.findUniqueOrThrow({ where: { id } });
    expect(done).toMatchObject({ status: "RECORDED", recipientCount: 2 });
    expect((await db.memberMessageRecipient.findMany({ where: { messageId: id } })).map((x) => x.buyerMemberId).sort()).toEqual([a.id, late.id].sort());
    // 두 번 돌려도 한 번만 처리하고, 기록된 발송은 수정·취소할 수 없다
    expect(await processDueMemberMessages(db, due)).toBe(0);
    expect(await cancelMessage(db, s.ctx, id)).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await updateMessage(db, s.ctx, id, { title: "x", channel: "MAIL", body: "x", sendMode: "SCHEDULE", scheduledAt: new Date(Date.now() + 5 * DAY).toISOString() })).toEqual({ ok: false, reason: "invalid_transition" });
    // 취소한 예약은 시각이 되어도 기록되지 않는다
    const r2 = await okMsg(send(s, { sendMode: "SCHEDULE", scheduledAt: new Date(Date.now() + 2 * DAY).toISOString() }));
    expect(await cancelMessage(db, s.ctx, r2.message.id)).toEqual({ ok: true });
    expect(await cancelMessage(db, s.ctx, r2.message.id)).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await processDueMemberMessages(db, new Date(Date.now() + 9 * DAY))).toBe(0);
    expect((await db.memberMessage.findUniqueOrThrow({ where: { id: r2.message.id } })).status).toBe("CANCELLED");
  });

  it("정기 작업 목록에 예약 처리 작업이 있다", () => {
    expect(SCHEDULED_JOBS.map((j) => j.name)).toContain("member_message.record_due");
  });
});

describe("같은 회원 하루 2건 한도", () => {
  it("세 번째 발송부터는 그 회원을 빼고(미리보기·기록 모두), 다른 회원은 보낸다. 모두 빠지면 아무것도 기록하지 않는다", async () => {
    const s = await shop();
    const a = await s.member(false);
    const b = await s.member(false);
    await okMsg(send(s, { target: { type: "PICKED", memberIds: [a.id] } }));
    await okMsg(send(s, { target: { type: "PICKED", memberIds: [a.id] } }));
    const pv = await previewMessage(db, s.ctx, input({ target: { type: "PICKED", memberIds: [a.id, b.id] } }));
    expect(pv).toMatchObject({ ok: true, matched: 2, dailyCapped: 1, finalCount: 1 });
    const third = await okMsg(send(s, { target: { type: "PICKED", memberIds: [a.id, b.id] } }));
    expect(third.message).toMatchObject({ recipientCount: 1, skippedDailyCap: 1 });
    expect((await db.memberMessageRecipient.findMany({ where: { messageId: third.message.id } })).map((x) => x.buyerMemberId)).toEqual([b.id]);
    expect(await send(s, { target: { type: "PICKED", memberIds: [a.id] } })).toEqual({ ok: false, reason: "no_recipients" });
    expect(await db.memberMessage.count()).toBe(3);
  });

  it("동시에 여러 건을 보내도 한 회원은 하루 2건을 넘지 않는다", async () => {
    const s = await shop();
    const a = await s.member(false);
    const results = await Promise.all(Array.from({ length: 5 }, () => send(s, { target: { type: "PICKED", memberIds: [a.id] } })));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await db.memberMessageRecipient.count({ where: { buyerMemberId: a.id } })).toBe(2);
  });
});

describe("요약·상세·목록", () => {
  it("동의 회원·이번 달 기록(채널별)·기록 뒤 24시간 주문·최근 30일 수신 철회를 센다", async () => {
    const s = await shop();
    const a = await s.member(true);
    const b = await s.member(true);
    await s.member(false);
    await db.buyerMember.update({ where: { id: b.id }, data: { marketingConsentAt: null, marketingWithdrawnAt: new Date() } });
    await okMsg(send(s, { channel: "ALIMTALK", target: { type: "PICKED", memberIds: [a.id] } }));
    const m = await okMsg(send(s, { channel: "MAIL", target: { type: "PICKED", memberIds: [a.id, b.id] } }));
    // 기록 뒤 24시간 안의 결제 주문 1건(a, 20,000원 중 5,000원 부분 환불), 기록 전 주문은 세지 않는다
    await db.order.create({ data: { sellerId: s.seller.id, orderNo: 1, buyerMemberId: a.id, status: "PAID", broadcastNicknameSnapshot: "닉", totalAmount: 20_000, refundAmount: 5_000, paidAt: new Date(Date.now() + 3600_000) } });
    await db.order.create({ data: { sellerId: s.seller.id, orderNo: 2, buyerMemberId: a.id, status: "PAID", broadcastNicknameSnapshot: "닉", totalAmount: 9_000, paidAt: new Date(Date.now() - 5 * DAY) } });
    const list = await listMessages(db, s.ctx);
    expect(list.summary).toMatchObject({ consented: 1, activeMembers: 3, monthAlimtalk: 1, monthMail: 2, monthRecorded: 3, orders24h: 1, orders24hAmount: 15_000, withdrawn30: 1 });
    const detail = await getMessage(db, s.ctx, m.message.id);
    expect(detail).toMatchObject({ status: "RECORDED", orders24h: { count: 1, amount: 15_000 }, reaction: null });
    expect(list.messages).toHaveLength(2);
    expect(await getMessage(db, s.ctx, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("탈퇴·로그 추적·권한·격리·라우트", () => {
  it("탈퇴하면 받는 사람 기록을 지우고 발송 건은 남으며, 로그 추적에는 회원 id가 없다", async () => {
    const s = await shop();
    const a = await s.member(true);
    const r = await okMsg(send(s, { target: { type: "PICKED", memberIds: [a.id] } }));
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: a.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect(await db.memberMessageRecipient.count({ where: { messageId: r.message.id } })).toBe(0);
    expect(await db.memberMessage.count({ where: { id: r.message.id } })).toBe(1);
    const logs = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: "member_message.create" } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0].after)).not.toContain(a.id);
    expect(logs[0].after).toMatchObject({ target: "PICKED", renderedBody: expect.stringContaining("[") });
  });

  it("권한 없는 직원은 보지도 보내지도 못하고, 다른 쇼핑몰 발송은 보이지 않으며 바꿀 수 없다", async () => {
    const s = await shop();
    await s.member(false);
    const r = await okMsg(send(s));
    const sctx: TenantContext = { ...s.ctx, actorId: s.staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] };
    await expect(listMessages(db, sctx)).rejects.toThrow();
    await expect(createMessage(db, sctx, input())).rejects.toThrow();
    await expect(previewMessage(db, sctx, input())).rejects.toThrow();
    await expect(cancelMessage(db, sctx, r.message.id)).rejects.toThrow();
    const ro: TenantContext = { ...s.ctx, readOnly: true };
    await expect(createMessage(db, ro, input())).rejects.toThrow();
    const other = await shop();
    expect(await getMessage(db, other.ctx, r.message.id)).toBeNull();
    expect(await cancelMessage(db, other.ctx, r.message.id)).toEqual({ ok: false, reason: "not_found" });
    expect((await listMessages(db, other.ctx)).messages).toHaveLength(0);
  });

  it("라우트: 대표자는 미리보기·보내기·조회하고, 로그인하지 않으면 401, 잘못된 입력은 400", async () => {
    const s = await shop();
    await s.member(false);
    const owner = await db.sellerUser.findFirstOrThrow({ where: { sellerId: s.seller.id, id: s.owner.id } });
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
    const req = (path: string, method: string, body?: unknown, cookie = `lo_seller=${login.token}`) =>
      new Request(`http://localhost:3000${path}`, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await createPost(req("/api/seller/member-messages", "POST", input(), ""))).status).toBe(401);
    expect((await createPost(req("/api/seller/member-messages", "POST", input({ title: "" })))).status).toBe(400);
    const pv = await previewPost(req("/api/seller/member-messages/preview", "POST", input()));
    expect(pv.status).toBe(200);
    expect(await pv.json()).toMatchObject({ matched: 1, finalCount: 1 });
    expect(await db.memberMessage.count()).toBe(0); // 미리보기는 저장하지 않는다
    const created = await createPost(req("/api/seller/member-messages", "POST", input()));
    expect(created.status).toBe(201);
    const list = await listGet(req("/api/seller/member-messages", "GET"));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { messages: unknown[] }).messages).toHaveLength(1);
    // 광고성 직접 예약이 시간 밖이면 400과 함께 바꿀 시각을 준다
    const night = new Date(kst("2026-01-01T22:30:00"));
    while (night.getTime() < Date.now() + 2 * DAY) night.setTime(night.getTime() + DAY);
    const rejected = await createPost(req("/api/seller/member-messages", "POST", input({ kind: "AD", sendMode: "SCHEDULE", scheduledAt: night.toISOString() })));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "ad_time_window", suggestedAt: nextAdTime(night).toISOString() });
  });
});
