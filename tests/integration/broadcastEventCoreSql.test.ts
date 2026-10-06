// SQL 제약을 실제 PostgreSQL에서 확인한다. Prisma 서비스/API 통합 시험을 대신하지 않는다.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

const client = new Client({ connectionString: assertTestDatabaseUrl(process.env.DATABASE_URL) });
let sellerId: string, broadcastId: string, linkId: string, eventId: string, entrantId: string, roundId: string;
beforeAll(() => client.connect());
afterAll(() => client.end());
beforeEach(async () => {
  await client.query("BEGIN");
  sellerId = randomUUID(); broadcastId = randomUUID(); linkId = randomUUID(); eventId = randomUUID(); entrantId = randomUUID(); roundId = randomUUID();
  await client.query('INSERT INTO "Seller" (id, slug, "shopName") VALUES ($1::uuid, $1::text, $2)', [sellerId, "이벤트 시험"]);
  await client.query('INSERT INTO "BroadcastSession" (id, "sellerId") VALUES ($1, $2)', [broadcastId, sellerId]);
  await client.query('INSERT INTO "YoutubeLiveLink" (id, "sellerId", "broadcastSessionId", "videoId", title, status, "liveChatId", "chatEnabled", "updatedAt") VALUES ($1, $2, $3, $4, $4, $5, $6, true, CURRENT_TIMESTAMP)', [linkId, sellerId, broadcastId, "video", "LIVE", "chat"]);
  await client.query('INSERT INTO "AudienceEvent" (id, "sellerId", "broadcastSessionId", "liveLinkId", "liveChatId", kind, title, keyword, "winnerCount", "testMode", "requestKey", "requestHash", "noticeAcknowledgedAt", "openedAt", "closesAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, true, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval \'1 hour\')', [eventId, sellerId, broadcastId, linkId, "chat", "RANDOM_DRAW", "추첨", "참가", randomUUID(), "test-hash"]);
  await client.query('INSERT INTO "AudienceEventEntrant" (id, "sellerId", "eventId", "authorChannelId", "messageId", "displayName", "publishedAt") VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)', [entrantId, sellerId, eventId, "UC" + "1".repeat(22), "message", "시청자"]);
});
afterEach(() => client.query("ROLLBACK").then(() => undefined));
async function freeze() {
  await client.query('UPDATE "AudienceEvent" SET status = $1, "frozenAt" = CURRENT_TIMESTAMP WHERE id = $2', ["FROZEN", eventId]);
  await client.query('INSERT INTO "AudienceEventRound" (id, "sellerId", "eventId", "rulesSnapshot", "entrantIds") VALUES ($1, $2, $3, $4, $5)', [roundId, sellerId, eventId, JSON.stringify({ kind: "RANDOM_DRAW", keyword: "참가", winnerCount: 1, testMode: true }), JSON.stringify([entrantId])]);
}
async function result(winners = [entrantId], testMode = true) {
  return client.query('INSERT INTO "AudienceEventResult" ("sellerId", "roundId", "algorithmVersion", "winnerEntrantIds", "testMode") VALUES ($1, $2, $3, $4, $5)', [sellerId, roundId, "draw-crypto-without-replacement-v1", JSON.stringify(winners), testMode]);
}
describe("방송 이벤트 migration PostgreSQL 제약", () => {
  it("표시 이름을 식별자로 쓰지 않고 같은 channel ID 재참가를 DB가 막는다", async () => {
    await expect(client.query('INSERT INTO "AudienceEventEntrant" ("sellerId", "eventId", "authorChannelId", "messageId", "displayName", "publishedAt") VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)', [sellerId, eventId, "UC" + "1".repeat(22), "other-message", "바뀐 이름"])).rejects.toMatchObject({ code: "23505" });
  });
  it("동결 뒤 직접 DB 참가 입력도 차단한다", async () => {
    await freeze();
    await expect(client.query('INSERT INTO "AudienceEventEntrant" ("sellerId", "eventId", "authorChannelId", "messageId", "displayName", "publishedAt") VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)', [sellerId, eventId, "UC" + "2".repeat(22), "late", "늦음"])).rejects.toMatchObject({ code: "23514" });
  });
  it.each(["UPDATE", "DELETE"])("동결 회차 %s는 차단한다", async operation => {
    await freeze();
    await expect(client.query(operation === "UPDATE" ? 'UPDATE "AudienceEventRound" SET "entrantIds" = \'[]\'' : 'DELETE FROM "AudienceEventRound" WHERE id = $1', operation === "UPDATE" ? [] : [roundId])).rejects.toMatchObject({ code: "23514" });
  });
  it("결과를 만든 뒤 수정하지 못한다", async () => {
    await freeze(); await result();
    await expect(client.query('UPDATE "AudienceEventResult" SET "winnerEntrantIds" = \'[]\' WHERE "roundId" = $1', [roundId])).rejects.toMatchObject({ code: "23514" });
  });
  it.each(["outsider", "duplicate", "mode"])("%s 결과는 DB가 거부한다", async invalid => {
    await freeze();
    await expect(result(invalid === "outsider" ? [randomUUID()] : invalid === "duplicate" ? [entrantId, entrantId] : [entrantId], invalid !== "mode")).rejects.toMatchObject({ code: "23514" });
  });
  it("판매자가 다른 참조는 composite FK로 거부한다", async () => {
    const another = randomUUID();
    await client.query('INSERT INTO "Seller" (id, slug, "shopName") VALUES ($1::uuid, $1::text, $2)', [another, "다른 파트너스"]);
    await expect(client.query('INSERT INTO "AudienceEvent" ("sellerId", "broadcastSessionId", "liveLinkId", "liveChatId", kind, title, keyword, "winnerCount", "testMode", "requestKey", "requestHash", "noticeAcknowledgedAt", "openedAt", "closesAt") VALUES ($1, $2, $3, $4, $5, $6, $7, 1, true, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval \'1 hour\')', [another, broadcastId, linkId, "chat", "RANDOM_DRAW", "격리", "참가", randomUUID(), "test"])).rejects.toMatchObject({ code: "23503" });
  });
});
