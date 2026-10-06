// PostgreSQL migration/불변 제약 시험. Prisma service/API 통합 검증과 구분한다.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { executeEventSnapshot, executionSnapshotOf } from "../../lib/server/events/execution";
const client = new Client({ connectionString: assertTestDatabaseUrl(process.env.DATABASE_URL) });
let sellerId: string, eventId: string, entrants: string[], settings: Record<string, unknown>;
beforeAll(() => client.connect()); afterAll(() => client.end());
beforeEach(async () => { await client.query("BEGIN"); sellerId = randomUUID(); eventId = randomUUID(); entrants = [randomUUID(), randomUUID()].sort(); settings = { allowDuplicateWinners: false }; });
afterEach(() => client.query("ROLLBACK").then(() => undefined));
async function event(kind = "RANDOM_DRAW", duplicates = false) {
  const broadcast = randomUUID(), link = randomUUID();
  settings = { allowDuplicateWinners: duplicates, ...(kind === "ROULETTE_ITEM" ? { items: [{ id: randomUUID(), label: "첫 항목" }, { id: randomUUID(), label: "둘째 항목" }] } : {}), ...(kind === "LADDER" ? { outcomeSlots: [{ id: randomUUID(), label: "결과 1" }, { id: randomUUID(), label: "결과 2" }] } : {}) };
  await client.query('INSERT INTO "Seller" (id,slug,"shopName") VALUES ($1,$2,$2)', [sellerId, sellerId]);
  await client.query('INSERT INTO "BroadcastSession" (id,"sellerId") VALUES ($1,$2)', [broadcast, sellerId]);
  await client.query('INSERT INTO "YoutubeLiveLink" (id,"sellerId","broadcastSessionId","videoId",title,status,"liveChatId","updatedAt") VALUES ($1,$2,$3,\'video\',\'시험\',\'LIVE\',\'chat\',CURRENT_TIMESTAMP)', [link, sellerId, broadcast]);
  await client.query('INSERT INTO "AudienceEvent" (id,"sellerId","broadcastSessionId","liveLinkId","liveChatId",kind,title,keyword,rules,"winnerCount","testMode","requestKey","requestHash","noticeAcknowledgedAt","openedAt","closesAt") VALUES ($1,$2,$3,$4,\'chat\',$5,\'시험\',$6,$7,1,true,$8,\'hash\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval \'1 hour\')', [eventId,sellerId,broadcast,link,kind,kind === "ROULETTE_ITEM" ? null : "참가",JSON.stringify(settings),randomUUID()]);
  if (kind === "ROULETTE_ITEM") entrants = [];
  for (let index = 0; index < entrants.length; index++) await client.query('INSERT INTO "AudienceEventEntrant" (id,"sellerId","eventId","authorChannelId","messageId","displayName","publishedAt") VALUES ($1,$2,$3,$4,$5,\'동일 이름\',CURRENT_TIMESTAMP)',[entrants[index],sellerId,eventId,"UC"+String(index).repeat(22),String(index)]);
  await client.query('UPDATE "AudienceEvent" SET status=\'FROZEN\' WHERE id=$1',[eventId]);
  return kind;
}
async function round(kind: string, options: { source?: string; reason?: string | null; prior?: string[]; duplicates?: boolean; requestKey?: string } = {}) {
  const id = randomUUID();
  const rules = { version: 2, kind, keyword: kind === "ROULETTE_ITEM" ? null : "참가", winnerCount: 1, testMode: true, rewardsEnabled: false, settings: {...settings, ...(options.duplicates === undefined ? {} : { allowDuplicateWinners: options.duplicates })}, previousWinnerIds: options.prior ?? [] };
  await client.query('INSERT INTO "AudienceEventRound" (id,"sellerId","eventId","roundNumber","requestKey","requestHash","sourceRoundId",reason,"actorType","actorId","rulesSnapshot","entrantIds") VALUES ($1,$2,$3,$4,$5,\'hash\',$6,$7,\'SELLER_USER\',\'operator\',$8,$9)',[id,sellerId,eventId,options.source ? 2 : 1,options.requestKey ?? randomUUID(),options.source ?? null,options.reason ?? null,JSON.stringify(rules),JSON.stringify(entrants)]);
  return { id, rules };
}
async function result(value: Awaited<ReturnType<typeof round>>) {
  const execution = executeEventSnapshot(executionSnapshotOf(value.rules, entrants));
  const ids = ["LADDER","ROULETTE_ITEM"].includes(value.rules.kind) ? [] : execution.draw!.selectedIds;
  const row = await client.query('INSERT INTO "AudienceEventResult" ("sellerId","roundId","algorithmVersion","winnerEntrantIds","testMode",execution) VALUES ($1,$2,\'test-helper-v1\',$3,true,$4) RETURNING *',[sellerId,value.id,JSON.stringify(ids),JSON.stringify(execution)]);
  return row.rows[0];
}
async function publish(roundId: string, requestKey = randomUUID(), participantId?: string) {
  return client.query('INSERT INTO "AudienceEventPublication" ("sellerId","roundId","requestKey",scope,"participantId","actorType") VALUES ($1,$2,$3,$4,$5,\'SELLER_USER\') RETURNING *',[sellerId,roundId,requestKey,participantId ? "PARTICIPANT" : "ALL",participantId ?? null]);
}
describe("다회차 실행/공개 migration 실제 PostgreSQL", () => {
  it.each(["RANDOM_DRAW","ROULETTE_PARTICIPANT","ROULETTE_ITEM","LADDER"])("%s frozen 실행을 저장한다", async kind => {
    await event(kind); const frozen = await round(kind); const saved = await result(frozen);
    expect(saved.execution.kind).toBe(kind); expect(saved.testMode).toBe(true);
    expect(saved.winnerEntrantIds).toHaveLength(["LADDER","ROULETTE_ITEM"].includes(kind) ? 0 : 1);
  });
  it("새 회차는 원회차와 사유를 보존하고 이전 당첨자를 제외한다", async () => {
    const kind=await event(), first=await round(kind), saved=await result(first);
    await client.query('UPDATE "AudienceEvent" SET status=\'COMPLETED\' WHERE id=$1',[eventId]);
    const second=await round(kind,{source:first.id,reason:"다음 회차",prior:saved.winnerEntrantIds}); const next=await result(second);
    expect(next.winnerEntrantIds).not.toEqual(saved.winnerEntrantIds);
    expect((await client.query('SELECT count(*)::int AS n FROM "AudienceEventResult" WHERE "sellerId"=$1',[sellerId])).rows[0].n).toBe(2);
  });
  it("새 회차에서 이전 선택 명단을 생략하면 거부한다", async () => {
    const kind=await event(), first=await round(kind);await result(first);
    await expect(round(kind,{source:first.id,reason:"다음"})).rejects.toMatchObject({code:"23514"});
  });
  it("새 회차의 사유 누락은 거부한다", async () => {
    const kind=await event(),first=await round(kind),saved=await result(first);
    await expect(round(kind,{source:first.id,prior:saved.winnerEntrantIds})).rejects.toMatchObject({code:"23514"});
  });
  it("완료하지 않은 회차의 재추첨은 거부한다", async () => {
    const kind=await event(),first=await round(kind);
    await expect(round(kind,{source:first.id,reason:"다음"})).rejects.toMatchObject({code:"23514"});
  });
  it("회차 requestKey 중복은 unique 제약으로 막는다", async () => {
    const kind=await event(),key=randomUUID(),first=await round(kind,{requestKey:key}),saved=await result(first);
    await expect(round(kind,{source:first.id,reason:"다음",prior:saved.winnerEntrantIds,requestKey:key})).rejects.toMatchObject({code:"23505"});
  });
  it("재표시는 같은 확정 결과를 보존하며 공개기록만 추가한다", async () => {
    const kind=await event(),first=await round(kind),saved=await result(first);
    await publish(first.id);await publish(first.id);
    expect((await client.query('SELECT * FROM "AudienceEventResult" WHERE "roundId"=$1',[first.id])).rows).toEqual([saved]);
    expect((await client.query('SELECT count(*)::int AS n FROM "AudienceEventPublication" WHERE "roundId"=$1',[first.id])).rows[0].n).toBe(2);
  });
  it("미확정 결과의 공개는 거부한다", async () => {
    const kind=await event(),first=await round(kind);await expect(publish(first.id)).rejects.toMatchObject({code:"23514"});
  });
  it("사다리 개별/전체 공개 상태를 별도 불변 기록으로 저장한다", async () => {
    const kind=await event("LADDER"),first=await round(kind);await result(first);
    expect((await publish(first.id,randomUUID(),entrants[0])).rows[0].scope).toBe("PARTICIPANT");
    expect((await publish(first.id)).rows[0].scope).toBe("ALL");
    await expect(client.query('DELETE FROM "AudienceEventPublication" WHERE "roundId"=$1',[first.id])).rejects.toMatchObject({code:"23514"});
  });
  it("공개 requestKey 중복은 unique 제약으로 막는다", async () => {
    const kind=await event(),first=await round(kind);await result(first);const key=randomUUID();await publish(first.id,key);
    await expect(publish(first.id,key)).rejects.toMatchObject({code:"23505"});
  });
  it("다른 회차 참가자의 사다리 공개는 거부한다", async () => {
    const kind=await event("LADDER"),first=await round(kind);await result(first);
    await expect(publish(first.id,randomUUID(),randomUUID())).rejects.toMatchObject({code:"23514"});
  });
});
