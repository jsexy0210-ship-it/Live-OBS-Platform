import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { acceptYoutubeEventEntries, cancelAudienceEvent, createAudienceEvent, createNextAudienceRound, drawAudienceEvent, freezeAudienceEvent, previewAudienceEvent, publishAudienceResult, readAudienceEvent } from "../../lib/server/events/service";
import type { ChatMessage, YoutubeClient } from "../../lib/server/youtube/client";
import { collectChats } from "../../lib/server/youtube/chat";
import { loginSeller } from "../../lib/server/auth/login";
import { POST as createRoute } from "../../app/api/seller/events/route";
import { POST as actionRoute } from "../../app/api/seller/events/[eventId]/[action]/route";
import { createSeller, createSellerUser, db, PASSWORD, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());
const author = (n: number) => "UC" + String(n).padStart(22, "0");
async function setup() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx = { sellerId: seller.id, actorType: "SELLER_USER" as const, actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const broadcast = await db.broadcastSession.create({ data: { sellerId: seller.id } });
  const link = await db.youtubeLiveLink.create({ data: { sellerId: seller.id, broadcastSessionId: broadcast.id, videoId: "video", title: "방송", status: "LIVE", chatEnabled: true, liveChatId: "chat-" + seller.id } });
  const input = { kind: "RANDOM_DRAW", broadcastSessionId: broadcast.id, title: "방송 추첨", keyword: "참가", winnerCount: 1, testMode: true, requestKey: randomUUID(), sellerNoticeAcknowledged: true, closesAt: new Date(Date.now() + 3_600_000).toISOString() };
  return { seller, ctx, owner, broadcast, link, input };
}
function message(id: string, n: number, fullText = "참가", publishedAt = new Date()): ChatMessage {
  return { messageId: id, authorChannelId: author(n), authorName: "같은 이름", fullText, text: Array.from(fullText).slice(0, 200).join(""), publishedAt };
}
async function cookie(email: string) {
  const result = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!result.ok) throw new Error(result.reason);
  return `lo_seller=${result.token}`;
}
const request = (body: unknown, token: string, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/seller/events", { method: "POST", headers: { host: "localhost:3000", origin, cookie: token, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("방송 이벤트 공통 서버", () => {
  it("같은 요청키 동시 생성은 이벤트/고지/로그가 한 번이며 다른 설정은 충돌한다", async () => {
    const s = await setup();
    const events = await Promise.all([createAudienceEvent(db, s.ctx, s.input), createAudienceEvent(db, s.ctx, s.input)]);
    expect(events[0].id).toBe(events[1].id);
    expect(await db.audienceEvent.count()).toBe(1);
    expect(await db.auditLog.count({ where: { action: "audience_event.open" } })).toBe(1);
    await expect(createAudienceEvent(db, s.ctx, { ...s.input, keyword: "다름" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("trim 전체 일치만 참가하며 채널/메시지로 중복 제거하고 이름이 같아도 각각 참가한다", async () => {
    const s = await setup(); const event = await createAudienceEvent(db, s.ctx, s.input);
    const at = event.openedAt;
    // DB의 openedAt 뒤 시각이어야 한다. 생성/폴링 사이 실제 시각으로 판정한다.
    const rows = [message("m1", 1, "  참가 \n", at), message("m2", 1, "참가", at), message("m1", 3, "참가", at), message("m3", 2, "참가", at), message("m4", 4, "참가해요", at), message("m5", 5, "다른 참가", at), message("m6", 6, "參加", at), message("old", 7, "참가", new Date(event.openedAt.getTime() - 1))];
    const results = await Promise.all([acceptYoutubeEventEntries(db, s.link, rows), acceptYoutubeEventEntries(db, s.link, rows)]);
    expect(results.reduce((sum, r) => sum + r.accepted, 0)).toBe(2);
    const entrants = await db.audienceEventEntrant.findMany();
    expect(entrants.map(e => e.authorChannelId).sort()).toEqual([author(1), author(2)]);
    expect(entrants.map(e => e.displayName)).toEqual(["같은 이름", "같은 이름"]);
  });
  it("안정 ID 없음은 명시 사유/집계로 남고 같은 페이지 재시도도 한 번만 센다", async () => {
    const s = await setup(); const event = await createAudienceEvent(db, s.ctx, s.input);
    const row = { ...message("unidentified", 1), authorChannelId: "" };
    const reports = await Promise.all([acceptYoutubeEventEntries(db, s.link, [row]), acceptYoutubeEventEntries(db, s.link, [row])]);
    expect(reports.reduce((sum, r) => sum + r.rejectedIdentity, 0)).toBe(1);
    expect(await db.audienceEventEntrant.count()).toBe(0);
    expect(await db.audienceEvent.findUnique({ where: { id: event.id } })).toMatchObject({ rejectedIdentityCount: 1, lastEntryRejection: "missing_stable_author_identity" });
  });
  it("현재 판매자의 활성 채팅/방송만 받으며 다른 판매자 조회·freeze·draw는 404다", async () => {
    const a = await setup(), b = await setup(); const event = await createAudienceEvent(db, a.ctx, a.input);
    expect(await acceptYoutubeEventEntries(db, { ...a.link, sellerId: b.seller.id }, [message("wrong", 1)])).toEqual({ accepted: 0, rejectedIdentity: 0 });
    expect(await acceptYoutubeEventEntries(db, { ...a.link, liveChatId: "other-chat" }, [message("other", 1)])).toEqual({ accepted: 0, rejectedIdentity: 0 });
    await db.broadcastSession.update({ where: { id: a.broadcast.id }, data: { status: "ENDED", endedAt: new Date() } });
    expect((await acceptYoutubeEventEntries(db, a.link, [message("ended", 1)])).accepted).toBe(0);
    for (const call of [readAudienceEvent, freezeAudienceEvent, drawAudienceEvent]) await expect(call(db, b.ctx, event.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("동결/동시 추첨/재시도는 같은 회차·결과이며 실제 보상·주문·배송 원장을 만들지 않는다", async () => {
    const s = await setup(); const event = await createAudienceEvent(db, s.ctx, { ...s.input, winnerCount: 2 });
    await acceptYoutubeEventEntries(db, s.link, [message("one", 1), message("two", 2), message("three", 3)]);
    const rounds = await Promise.all([freezeAudienceEvent(db, s.ctx, event.id), freezeAudienceEvent(db, s.ctx, event.id)]);
    expect(rounds[0].id).toBe(rounds[1].id);
    expect(rounds[0].rulesSnapshot).toMatchObject({ keyword: "참가", winnerCount: 2, testMode: true, rewardsEnabled: false });
    expect((await acceptYoutubeEventEntries(db, s.link, [message("late", 4)])).accepted).toBe(0);
    const results = await Promise.all([drawAudienceEvent(db, s.ctx, event.id), drawAudienceEvent(db, s.ctx, event.id)]);
    expect(results[0].id).toBe(results[1].id);
    const ids = results[0].winnerEntrantIds as string[];
    expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(rounds[0].entrantIds).toContain(id);
    expect(results[0].testMode).toBe(true);
    expect(await db.order.count()).toBe(0);
    expect(await db.rewardLedger.count()).toBe(0);
    expect(await db.coupon.count()).toBe(0);
    expect(await db.shipment.count()).toBe(0);
    expect(await db.auditLog.count({ where: { action: "audience_event.draw" } })).toBe(1);
  });
  it("DB가 동결 회차/결과의 수정·삭제, 설정 바꾸기와 마감 뒤 참가를 막는다", async () => {
    const s = await setup(); const event = await createAudienceEvent(db, s.ctx, s.input);
    await acceptYoutubeEventEntries(db, s.link, [message("one", 1)]);
    const round = await freezeAudienceEvent(db, s.ctx, event.id); const result = await drawAudienceEvent(db, s.ctx, event.id);
    await expect(db.audienceEventRound.update({ where: { id: round.id }, data: { entrantIds: [] } })).rejects.toThrow();
    await expect(db.audienceEventResult.delete({ where: { id: result.id } })).rejects.toThrow();
    await expect(db.audienceEvent.update({ where: { id: event.id }, data: { keyword: "바꾸기" } })).rejects.toThrow();
    await expect(db.audienceEventEntrant.create({ data: { sellerId: s.seller.id, eventId: event.id, authorChannelId: author(2), messageId: "late", displayName: "늦음", publishedAt: new Date() } })).rejects.toThrow();
  });
  it("채팅 원문은 메모리에서 비교하고 DB에는 앞 200자만 남긴다", async () => {
    const s = await setup(); await createAudienceEvent(db, s.ctx, s.input);
    const raw = "참가" + " ".repeat(210) + "추가";
    const client: YoutubeClient = { channel: async () => null, latestUploads: async () => [], videos: async () => [], chatMessages: async () => ({ messages: [message("long", 1, raw), message("exact", 2)], ended: false, nextPageToken: "next", pollingIntervalMillis: 20_000 }) };
    expect((await collectChats(db, client)).saved).toBe(2);
    const stored = await db.youtubeChatMessage.findFirstOrThrow({ where: { messageId: "long" } });
    expect(Array.from(stored.text)).toHaveLength(200);
    expect(stored).not.toHaveProperty("fullText");
    expect((await db.audienceEventEntrant.findMany()).map(e => e.messageId)).toEqual(["exact"]);
  });
  it("고지 확인·기한·알 수 없는 종류를 서버에서 막고 부족한 참가자 추첨은 결과를 만들지 않는다", async () => {
    const s = await setup();
    await expect(createAudienceEvent(db, s.ctx, { ...s.input, sellerNoticeAcknowledged: false })).rejects.toMatchObject({ code: "seller_notice_required" });
    await expect(createAudienceEvent(db, s.ctx, { ...s.input, closesAt: new Date(0).toISOString() })).rejects.toMatchObject({ code: "invalid_deadline" });
    await expect(createAudienceEvent(db, s.ctx, { ...s.input, kind: "UNKNOWN" })).rejects.toMatchObject({ code: "unsupported_event_kind" });
    const event = await createAudienceEvent(db, s.ctx, s.input);
    await freezeAudienceEvent(db, s.ctx, event.id);
    await expect(drawAudienceEvent(db, s.ctx, event.id)).rejects.toMatchObject({ code: "not_enough_candidates" });
    expect(await db.audienceEventResult.count()).toBe(0);
  });
  it("API가 CSRF·권한·플랜·본문 한도를 적용하며 시험 draw는 보상 입력을 받지 않는다", async () => {
    const s = await setup(); const token = await cookie(s.owner.email);
    expect((await createRoute(request(s.input, token, "https://other.example"))).status).toBe(403);
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    expect((await createRoute(request(s.input, await cookie(staff.email)))).status).toBe(403);
    expect((await createRoute(request({ ...s.input, title: "x".repeat(9_000) }, token))).status).toBe(413);
    expect((await createRoute(request({ ...s.input, reward: 1 }, token))).status).toBe(400);
    const response = await createRoute(request(s.input, token)); expect(response.status).toBe(201);
    const { event } = await response.json();
    await acceptYoutubeEventEntries(db, s.link, [message("valid", 1)]);
    const routeParams = (action: string) => ({ params: Promise.resolve({ eventId: event.id, action }) });
    expect((await actionRoute(request({}, token), routeParams("freeze"))).status).toBe(200);
    expect((await actionRoute(request({}, token), routeParams("draw"))).status).toBe(200);
    const unavailablePlan = await db.subscriptionPlan.create({ data: { code: "NO_EVENT_FEATURE", name: "기능 없음", listPrice: 0, salePrice: 0, trialDays: 0 } });
    await db.seller.update({ where: { id: s.seller.id }, data: { planId: unavailablePlan.id } });
    expect((await createRoute(request({ ...s.input, requestKey: randomUUID() }, token))).status).toBe(403);
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: null } });
    expect((await createRoute(request({ ...s.input, requestKey: randomUUID() }, token))).status).toBe(402);
  });
  it("취소는 멱등이며 권한 없는 직원/읽기 전용 컨텍스트는 변경하지 못한다", async () => {
    const s = await setup(); const event = await createAudienceEvent(db, s.ctx, s.input);
    await expect(freezeAudienceEvent(db, { ...s.ctx, readOnly: true }, event.id)).rejects.toMatchObject({ status: 403 });
    await expect(createAudienceEvent(db, { ...s.ctx, isOwner: false }, s.input)).rejects.toMatchObject({ status: 403 });
    expect((await cancelAudienceEvent(db, s.ctx, event.id)).status).toBe("CANCELED");
    expect((await cancelAudienceEvent(db, s.ctx, event.id)).status).toBe("CANCELED");
    expect(await db.auditLog.count({ where: { action: "audience_event.cancel" } })).toBe(1);
  });
  it("동시 freeze와 poll은 참가목록/회차의 경계를 원자적으로 정한다", async () => {
    const s = await setup(); const event = await createAudienceEvent(db, s.ctx, s.input);
    const [poll, round] = await Promise.all([acceptYoutubeEventEntries(db, s.link, [message("boundary", 1)]), freezeAudienceEvent(db, s.ctx, event.id)]);
    expect((round.entrantIds as string[]).length).toBe(poll.accepted);
    expect(await db.audienceEventEntrant.count()).toBe(poll.accepted);
    expect((await acceptYoutubeEventEntries(db, s.link, [message("after", 2)])).accepted).toBe(0);
  });
  it("변경 요청 한도와 이용 정지는 서버/수집에서 모두 적용한다", async () => {
    const s = await setup(); const event = await createAudienceEvent(db, s.ctx, s.input);
    await db.auditLog.createMany({ data: Array.from({ length: 30 }, () => ({ actorType: "SELLER_USER" as const, actorId: s.owner.id, sellerId: s.seller.id, action: "audience_event.open" })) });
    await expect(freezeAudienceEvent(db, s.ctx, event.id)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await acceptYoutubeEventEntries(db, s.link, [message("suspended", 1)])).accepted).toBe(0);
    expect(await db.audienceEvent.findUnique({ where: { id: event.id } })).toMatchObject({ lastEntryRejection: "seller_unavailable" });
  });
  it.each(["RANDOM_DRAW", "ROULETTE_PARTICIPANT", "ROULETTE_ITEM", "LADDER"])("%s service는 frozen 설정을 실행하고 지급하지 않는다", async kind => {
    const s = await setup();
    const input = { ...s.input, kind, ...(kind === "ROULETTE_ITEM" ? { keyword: undefined, items: ["첫 항목", "둘째 항목"] } : {}), ...(kind === "LADDER" ? { outcomeSlots: ["결과 1", "결과 2"] } : {}) };
    const event = await createAudienceEvent(db, s.ctx, input);
    if (kind !== "ROULETTE_ITEM") await acceptYoutubeEventEntries(db, s.link, [message("a", 1), message("b", 2)]);
    const round = await freezeAudienceEvent(db, s.ctx, event.id);
    const result = await drawAudienceEvent(db, s.ctx, event.id, round.id);
    expect(result.execution).toMatchObject({ version: 2, kind });
    expect(await db.rewardLedger.count()).toBe(0);expect(await db.coupon.count()).toBe(0);expect(await db.shipment.count()).toBe(0);
  });
  it("다음회차 동시재시도/중복허용/이전결과 보존과 legacy draw 재시도를 구분한다", async () => {
    const s=await setup(),event=await createAudienceEvent(db,s.ctx,s.input);
    await acceptYoutubeEventEntries(db,s.link,[message("a",1),message("b",2)]);
    const first=await freezeAudienceEvent(db,s.ctx,event.id), result1=await drawAudienceEvent(db,s.ctx,event.id);
    const input={sourceRoundId:first.id,reason:"다음 회차",requestKey:randomUUID()};
    const next=await Promise.all([createNextAudienceRound(db,s.ctx,event.id,input),createNextAudienceRound(db,s.ctx,event.id,input)]);
    expect(next[0].id).toBe(next[1].id); expect(next[0]).toMatchObject({roundNumber:2,sourceRoundId:first.id,reason:input.reason,actorId:s.owner.id});
    await expect(createNextAudienceRound(db,s.ctx,event.id,{...input,reason:"다른 이유"})).rejects.toMatchObject({code:"idempotency_conflict"});
    const result2=await drawAudienceEvent(db,s.ctx,event.id,next[0].id);
    expect(result2.winnerEntrantIds).not.toEqual(result1.winnerEntrantIds);
    expect((await drawAudienceEvent(db,s.ctx,event.id)).id).toBe(result1.id);
    await expect(createNextAudienceRound(db,s.ctx,event.id,{sourceRoundId:next[0].id,reason:"다음",requestKey:randomUUID()})).rejects.toMatchObject({code:"not_enough_candidates"});
    const third=await createNextAudienceRound(db,s.ctx,event.id,{sourceRoundId:next[0].id,reason:"중복 허용",requestKey:randomUUID(),allowDuplicateWinners:true});
    await drawAudienceEvent(db,s.ctx,event.id,third.id);
    expect(await db.audienceEventResult.findUnique({where:{id:result1.id}})).toEqual(result1);
    expect(await db.audienceEventRound.count()).toBe(3);
  });
  it("사다리 미리보기/개별공개/전체재표시는 저장 결과만 읽고 다른 판매자는 접근하지 못한다", async () => {
    const s=await setup(),other=await setup();
    const event=await createAudienceEvent(db,s.ctx,{...s.input,kind:"LADDER",outcomeSlots:["결과 1","결과 2"]});
    await acceptYoutubeEventEntries(db,s.link,[message("a",1),message("b",2)]);
    expect((await previewAudienceEvent(db,s.ctx,event.id)).frozen).toBe(false);
    expect(await db.audienceEventResult.count()).toBe(0);
    const round=await freezeAudienceEvent(db,s.ctx,event.id), result=await drawAudienceEvent(db,s.ctx,event.id,round.id);
    const participantId=(round.entrantIds as string[])[0], input={roundId:round.id,requestKey:randomUUID(),participantId};
    const published=await Promise.all([publishAudienceResult(db,s.ctx,event.id,input),publishAudienceResult(db,s.ctx,event.id,input)]);
    expect(published[0].publication.id).toBe(published[1].publication.id);
    await expect(publishAudienceResult(db,s.ctx,event.id,{...input,participantId:randomUUID()})).rejects.toMatchObject({code:"idempotency_conflict"});
    const all=await publishAudienceResult(db,s.ctx,event.id,{roundId:round.id,requestKey:randomUUID()});expect(all.publication.scope).toBe("ALL");
    expect(all.result).toEqual(result);expect(await db.audienceEventResult.count()).toBe(1);
    expect((await readAudienceEvent(db,s.ctx,event.id)).publications).toHaveLength(2);
    await expect(publishAudienceResult(db,other.ctx,event.id,input)).rejects.toMatchObject({code:"not_found"});
    expect(await db.rewardLedger.count()).toBe(0);
  });
  it("execute/next-round/redisplay API는 회차 식별과 요청키를 요구하며 지정당첨 입력을 거부한다", async () => {
    const s=await setup(),token=await cookie(s.owner.email),event=await createAudienceEvent(db,s.ctx,s.input);
    await acceptYoutubeEventEntries(db,s.link,[message("a",1),message("b",2)]);
    const first=await freezeAudienceEvent(db,s.ctx,event.id),params=(action:string)=>({params:Promise.resolve({eventId:event.id,action})});
    expect((await actionRoute(request({},token),params("execute"))).status).toBe(400);
    expect((await actionRoute(request({roundId:first.id,winners:["chosen"]},token),params("execute"))).status).toBe(400);
    expect((await actionRoute(request({roundId:first.id},token),params("execute"))).status).toBe(200);
    expect((await actionRoute(request({roundId:first.id,requestKey:randomUUID()},token),params("redisplay"))).status).toBe(200);
    const nextResponse=await actionRoute(request({sourceRoundId:first.id,reason:"다음",requestKey:randomUUID()},token),params("next-round"));expect(nextResponse.status).toBe(200);
    const {value:next}=await nextResponse.json();expect((await actionRoute(request({roundId:next.id},token),params("execute"))).status).toBe(200);
  });

});
