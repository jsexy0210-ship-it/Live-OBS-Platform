import { createHash, randomInt } from "node:crypto";
import type { AudienceEvent, Prisma, PrismaClient } from "@prisma/client";
import { EventError } from "./errors";
import { writeAudit } from "../audit/log";
import { sellerAccessFor } from "../billing/subscription";
import { sellerHasFeature } from "../billing/features";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import type { ChatMessage } from "../youtube/client";

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const EVENT_ENTRANT_LIMIT = 5_000;
export const EVENT_BROADCAST_LIMIT = 20;
export const EVENT_MUTATION_LIMIT = 30;
export const EVENT_NOTICE = "이벤트를 시작하기 전에 방송에서 참가 키워드, 참가 조건, 마감 시각과 추첨 규칙을 안내해 주십시오. 안내 확인은 진행자의 고지 확인이며 참가자의 개인정보 동의가 아닙니다. 유튜브 채널별로 한 번 참가하며 구독 여부는 확인하지 않습니다. 시험 모드에서는 실제 경품·쿠폰·적립금·배송을 만들지 않습니다.";

const reject = (status: EventError["status"], code: string): never => { throw new EventError(status, code); };
const uuid = (id: unknown): string => typeof id === "string" && UUID.test(id) ? id : reject(400, "invalid_request");
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > max) return reject(400, "invalid_request");
  return value.trim();
};
async function lockSeller(tx: Tx, sellerId: string): Promise<Date> {
  await tx.$queryRaw`SELECT id FROM "Seller" WHERE id = ${sellerId}::uuid FOR UPDATE`;
  const [clock] = await tx.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  return clock.at;
}
async function mutationLimit(tx: Tx, sellerId: string, at: Date) {
  const count = await tx.auditLog.count({ where: { sellerId, action: { startsWith: "audience_event." }, createdAt: { gte: new Date(at.getTime() - 60_000) }, actorType: "SELLER_USER" } });
  if (count >= EVENT_MUTATION_LIMIT) reject(429, "rate_limited");
}
function audit(ctx: TenantContext, eventId: string, action: string, after?: unknown) {
  return { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: `audience_event.${action}`, targetType: "AudienceEvent", targetId: eventId, after };
}
async function eventOf(tx: Tx, sellerId: string, eventId: string) {
  return (await tx.audienceEvent.findFirst({ where: { sellerId, id: eventId } })) ?? reject(404, "not_found");
}

export type CreateEventInput = { broadcastSessionId?: unknown; title?: unknown; keyword?: unknown; winnerCount?: unknown; testMode?: unknown; closesAt?: unknown; requestKey?: unknown; sellerNoticeAcknowledged?: unknown; kind?: unknown };

// 설정은 시작 뒤 수정하지 않는다. 키워드와 규칙은 동결 회차에도 보존하며, 채팅 원문은 보존하지 않는다.
export async function createAudienceEvent(db: PrismaClient, ctx: TenantContext, input: CreateEventInput) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const allowed = new Set(["broadcastSessionId", "title", "keyword", "winnerCount", "testMode", "closesAt", "requestKey", "sellerNoticeAcknowledged", "kind"]);
  if (Object.keys(input).some(key => !allowed.has(key))) reject(400, "invalid_request");
  const broadcastSessionId = uuid(input.broadcastSessionId);
  const requestKey = uuid(input.requestKey);
  const title = text(input.title, 100);
  const keyword = text(input.keyword, 100);
  if (["ROULETTE_ITEM", "ROULETTE_PARTICIPANT", "LADDER"].includes(input.kind as string)) reject(409, "not_ready");
  if (input.kind !== "RANDOM_DRAW") reject(400, "unsupported_event_kind");
  if (!Number.isInteger(input.winnerCount) || (input.winnerCount as number) < 1 || (input.winnerCount as number) > 100 || typeof input.testMode !== "boolean") reject(400, "invalid_request");
  if (input.sellerNoticeAcknowledged !== true) reject(400, "seller_notice_required");
  if (typeof input.closesAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(input.closesAt)) reject(400, "invalid_request");
  const closesAt = new Date(input.closesAt as string);
  if (!Number.isFinite(closesAt.getTime())) reject(400, "invalid_request");
  const config = { broadcastSessionId, title, keyword, winnerCount: input.winnerCount as number, testMode: input.testMode as boolean, closesAt: closesAt.toISOString(), kind: "RANDOM_DRAW" as const };
  const requestHash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  return db.$transaction(async (tx) => {
    const at = await lockSeller(tx, ctx.sellerId);
    const previous = await tx.audienceEvent.findUnique({ where: { sellerId_requestKey: { sellerId: ctx.sellerId, requestKey } } });
    if (previous) return previous.requestHash === requestHash ? previous : reject(409, "idempotency_conflict");
    if (closesAt <= at || closesAt.getTime() > at.getTime() + 86_400_000) reject(400, "invalid_deadline");
    await mutationLimit(tx, ctx.sellerId, at);
    const live = await tx.youtubeLiveLink.findFirst({ where: { sellerId: ctx.sellerId, broadcastSessionId, status: "LIVE", chatEnabled: true, liveChatId: { not: null }, broadcast: { status: "LIVE" } } });
    if (!live?.liveChatId) reject(409, "active_youtube_chat_required");
    if (await tx.audienceEvent.count({ where: { sellerId: ctx.sellerId, broadcastSessionId } }) >= EVENT_BROADCAST_LIMIT) reject(429, "event_limit");
    if (await tx.audienceEvent.count({ where: { sellerId: ctx.sellerId, status: "OPEN" } })) reject(409, "event_already_open");
    const event = await tx.audienceEvent.create({ data: { ...config, closesAt, sellerId: ctx.sellerId, liveLinkId: live!.id, liveChatId: live!.liveChatId!, requestKey, requestHash, noticeAcknowledgedAt: at, openedAt: at } });
    await writeAudit(tx, audit(ctx, event.id, "open", { kind: event.kind, testMode: event.testMode, closesAt }));
    return event;
  });
}

// 내부 수집 hook만 참가자를 추가한다. 기존 collector가 받은 원문만 판정한다.
// Stable identity missing is counted and audited explicitly. A nickname never becomes an identity.
export async function acceptYoutubeEventEntries(db: PrismaClient, source: { sellerId: string; id: string; liveChatId: string | null }, messages: readonly ChatMessage[]) {
  if (messages.length > 2_000) reject(400, "chat_batch_limit");
  return db.$transaction(async (tx) => {
    const at = await lockSeller(tx, source.sellerId);
    await tx.$queryRaw`SELECT id FROM "YoutubeLiveLink" WHERE id = ${source.id}::uuid AND "sellerId" = ${source.sellerId}::uuid FOR UPDATE`;
    const link = await tx.youtubeLiveLink.findFirst({ where: { id: source.id, sellerId: source.sellerId, status: "LIVE", liveChatId: source.liveChatId, chatEnabled: true, broadcast: { status: "LIVE" } } });
    if (!source.liveChatId || !link?.broadcastSessionId) return { accepted: 0, rejectedIdentity: 0 };
    const event = await tx.audienceEvent.findFirst({ where: { sellerId: source.sellerId, liveLinkId: source.id, liveChatId: source.liveChatId, broadcastSessionId: link.broadcastSessionId, status: "OPEN", closesAt: { gt: at } } });
    if (!event) return { accepted: 0, rejectedIdentity: 0 };
    const seller = await tx.seller.findUnique({ where: { id: source.sellerId }, select: { status: true } });
    const blocked = seller?.status !== "ACTIVE" ? "seller_unavailable" : (await sellerAccessFor(tx, source.sellerId, at)) === "expired" ? "subscription_required" : !(await sellerHasFeature(tx, source.sellerId, "OVERLAY", at)) ? "plan_feature_required" : null;
    if (blocked) {
      if (event.lastEntryRejection !== blocked) {
        await tx.audienceEvent.update({ where: { id: event.id }, data: { lastEntryRejection: blocked } });
        await writeAudit(tx, { actorType: "SYSTEM", sellerId: source.sellerId, action: "audience_event.chat_blocked", targetType: "AudienceEvent", targetId: event.id, after: { reason: blocked } });
      }
      return { accepted: 0, rejectedIdentity: 0 };
    }
    const existing = await tx.audienceEventEntrant.findMany({ where: { sellerId: event.sellerId, eventId: event.id }, select: { authorChannelId: true, messageId: true }, take: EVENT_ENTRANT_LIMIT });
    const authors = new Set(existing.map(e => e.authorChannelId)), ids = new Set(existing.map(e => e.messageId));
    const entries: Prisma.AudienceEventEntrantCreateManyInput[] = [];
    const rejected = new Map<string, Prisma.AudienceEventEntryRejectionCreateManyInput>();
    let full = false;
    for (const message of [...messages].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || a.messageId.localeCompare(b.messageId))) {
      if (!Number.isFinite(message.publishedAt.getTime()) || message.publishedAt < event.openedAt || message.publishedAt >= event.closesAt || message.publishedAt > at || typeof message.fullText !== "string" || message.fullText.trim() !== event.keyword || !message.messageId || message.messageId.length > 512) continue;
      if (!CHANNEL_ID.test(message.authorChannelId)) {
        if (event.rejectedIdentityCount + rejected.size < EVENT_ENTRANT_LIMIT) rejected.set(message.messageId, { sellerId: event.sellerId, eventId: event.id, messageId: message.messageId, reason: "missing_stable_author_identity" });
        continue;
      }
      if (authors.has(message.authorChannelId) || ids.has(message.messageId) || !message.authorName.trim()) continue;
      if (existing.length + entries.length >= EVENT_ENTRANT_LIMIT) { full = true; continue; }
      entries.push({ sellerId: event.sellerId, eventId: event.id, authorChannelId: message.authorChannelId, messageId: message.messageId, displayName: Array.from(message.authorName).slice(0, 100).join(""), publishedAt: message.publishedAt, acceptedAt: at });
      authors.add(message.authorChannelId); ids.add(message.messageId);
    }
    const accepted = entries.length ? (await tx.audienceEventEntrant.createMany({ data: entries, skipDuplicates: true })).count : 0;
    const rejectedIdentity = rejected.size ? (await tx.audienceEventEntryRejection.createMany({ data: [...rejected.values()], skipDuplicates: true })).count : 0;
    // Missing identity is a page-level diagnostic, not a reward/participant ledger. Retries cannot create entrants.
    if (rejectedIdentity || full) await tx.audienceEvent.update({ where: { id: event.id }, data: { rejectedIdentityCount: { increment: rejectedIdentity }, lastEntryRejection: full ? "entrant_limit_reached" : "missing_stable_author_identity" } });
    if (accepted || rejectedIdentity) await writeAudit(tx, { actorType: "SYSTEM", sellerId: event.sellerId, action: "audience_event.chat_batch", targetType: "AudienceEvent", targetId: event.id, after: { accepted, rejectedIdentity, reason: rejectedIdentity ? "missing_stable_author_identity" : null } });
    return { accepted, rejectedIdentity };
  });
}

function rulesOf(event: AudienceEvent): Prisma.InputJsonValue {
  return { version: 1, kind: event.kind, keyword: event.keyword, match: "whole_trimmed_exact", identity: "youtube_author_channel_id", winnerCount: event.winnerCount, testMode: event.testMode, closesAt: event.closesAt.toISOString(), entrantLimit: EVENT_ENTRANT_LIMIT, rewardsEnabled: false };
}
export async function freezeAudienceEvent(db: PrismaClient, ctx: TenantContext, id: unknown) {
  requireSellerPermission(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  return db.$transaction(async (tx) => {
    const at = await lockSeller(tx, ctx.sellerId);
    const event = await eventOf(tx, ctx.sellerId, eventId);
    const existing = await tx.audienceEventRound.findUnique({ where: { sellerId_eventId: { sellerId: ctx.sellerId, eventId } } });
    if (existing) return existing;
    if (event.status !== "OPEN") reject(409, "invalid_event_state");
    await mutationLimit(tx, ctx.sellerId, at);
    const entrants = await tx.audienceEventEntrant.findMany({ where: { sellerId: ctx.sellerId, eventId }, orderBy: [{ publishedAt: "asc" }, { id: "asc" }], select: { id: true }, take: EVENT_ENTRANT_LIMIT });
    await tx.audienceEvent.update({ where: { id: eventId }, data: { status: "FROZEN", frozenAt: at } });
    const round = await tx.audienceEventRound.create({ data: { sellerId: ctx.sellerId, eventId, frozenAt: at, rulesSnapshot: rulesOf(event), entrantIds: entrants.map(e => e.id) } });
    await writeAudit(tx, audit(ctx, eventId, "freeze", { roundId: round.id, entrants: entrants.length }));
    return round;
  });
}

// 서버에서만 결정한다. 결과 입력/교체 API와 지급 연결은 없다. 시험·실행 모두 경품 원장을 만들지 않는다.
export async function drawAudienceEvent(db: PrismaClient, ctx: TenantContext, id: unknown) {
  requireSellerPermission(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  return db.$transaction(async (tx) => {
    const at = await lockSeller(tx, ctx.sellerId);
    const event = await eventOf(tx, ctx.sellerId, eventId);
    const round = await tx.audienceEventRound.findUnique({ where: { sellerId_eventId: { sellerId: ctx.sellerId, eventId } }, include: { result: true } });
    if (event.kind !== "RANDOM_DRAW") reject(409, "not_ready");
    if (round?.result) return round.result;
    if (event.status !== "FROZEN" || !round) reject(409, "invalid_event_state");
    await mutationLimit(tx, ctx.sellerId, at);
    const entrants = round!.entrantIds as string[];
    const rules = round!.rulesSnapshot as { winnerCount: number; testMode: boolean };
    if (entrants.length < rules.winnerCount) reject(409, "not_enough_entrants");
    const pool = [...entrants];
    for (let i = 0; i < rules.winnerCount; i++) { const j = randomInt(i, pool.length); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const result = await tx.audienceEventResult.create({ data: { sellerId: ctx.sellerId, roundId: round!.id, algorithmVersion: "draw-crypto-without-replacement-v1", winnerEntrantIds: pool.slice(0, rules.winnerCount), testMode: rules.testMode } });
    await tx.audienceEvent.update({ where: { id: eventId }, data: { status: "COMPLETED", completedAt: at } });
    await writeAudit(tx, audit(ctx, eventId, "draw", { resultId: result.id, winners: rules.winnerCount, testMode: rules.testMode, rewardsEnabled: false }));
    return result;
  });
}
export async function cancelAudienceEvent(db: PrismaClient, ctx: TenantContext, id: unknown) {
  requireSellerPermission(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  return db.$transaction(async tx => {
    const at = await lockSeller(tx, ctx.sellerId); const event = await eventOf(tx, ctx.sellerId, eventId);
    if (event.status === "CANCELED") return event;
    if (event.status !== "OPEN") reject(409, "invalid_event_state");
    await mutationLimit(tx, ctx.sellerId, at);
    const canceled = await tx.audienceEvent.update({ where: { id: eventId }, data: { status: "CANCELED" } });
    await writeAudit(tx, audit(ctx, eventId, "cancel")); return canceled;
  });
}
export async function readAudienceEvents(db: PrismaClient, ctx: TenantContext, broadcastId: unknown) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  return db.audienceEvent.findMany({ where: { sellerId: ctx.sellerId, broadcastSessionId: uuid(broadcastId) }, orderBy: { openedAt: "desc" }, take: EVENT_BROADCAST_LIMIT, include: { _count: { select: { entrants: true } } } });
}
export async function readAudienceEvent(db: PrismaClient, ctx: TenantContext, id: unknown, cursor?: string | null) {
  requireSellerRead(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  if (cursor) uuid(cursor);
  const event = await db.audienceEvent.findFirst({ where: { sellerId: ctx.sellerId, id: eventId }, include: { rounds: { include: { result: true } }, _count: { select: { entrants: true } } } });
  if (!event) reject(404, "not_found");
  const entrants = await db.audienceEventEntrant.findMany({ where: { sellerId: ctx.sellerId, eventId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: 101, select: { id: true, displayName: true, publishedAt: true } });
  return { event, entrants: entrants.slice(0, 100), nextCursor: entrants.length > 100 ? entrants[99].id : null, notice: EVENT_NOTICE, rewardsEnabled: false };
}
