import { createHash } from "node:crypto";
import type { AudienceEvent, AudienceEventKind, Prisma, PrismaClient } from "@prisma/client";
import { EventError } from "./errors";
import { writeAudit } from "../audit/log";
import { sellerAccessFor } from "../billing/subscription";
import { sellerHasFeature } from "../billing/features";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import type { ChatMessage } from "../youtube/client";
import { allocateExecutionSettings, executeEventSnapshot, executionSnapshotOf, normalizeExecutionSettings, previewEventExecution } from "./execution";

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const EVENT_ENTRANT_LIMIT = 5_000;
export const EVENT_BROADCAST_LIMIT = 20;
export const EVENT_MUTATION_LIMIT = 30;
export const EVENT_NOTICE = "이벤트를 시작하기 전에 방송에서 진행 방식, 마감 시각과 실행 규칙을 안내해 주십시오. 참가형 이벤트는 참가 키워드와 참가 조건도 안내해야 합니다. 안내 확인은 진행자의 고지 확인이며 참가자의 개인정보 동의가 아닙니다. 유튜브 채널별로 한 번 참가하며 구독 여부는 확인하지 않습니다. 시험 모드에서는 실제 경품·쿠폰·적립금·배송을 만들지 않습니다.";

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

export type CreateEventInput = { broadcastSessionId?: unknown; title?: unknown; keyword?: unknown; winnerCount?: unknown; testMode?: unknown; closesAt?: unknown; requestKey?: unknown; sellerNoticeAcknowledged?: unknown; kind?: unknown; items?: unknown; outcomeSlots?: unknown; allowDuplicateWinners?: unknown };

// 설정은 시작 뒤 수정하지 않는다. 키워드와 규칙은 동결 회차에도 보존하며, 채팅 원문은 보존하지 않는다.
export async function createAudienceEvent(db: PrismaClient, ctx: TenantContext, input: CreateEventInput) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const allowed = new Set(["broadcastSessionId", "title", "keyword", "winnerCount", "testMode", "closesAt", "requestKey", "sellerNoticeAcknowledged", "kind", "items", "outcomeSlots", "allowDuplicateWinners"]);
  if (Object.keys(input).some(key => !allowed.has(key))) reject(400, "invalid_request");
  const broadcastSessionId = uuid(input.broadcastSessionId);
  const requestKey = uuid(input.requestKey);
  const title = text(input.title, 100);
  if (!["ROULETTE_ITEM", "ROULETTE_PARTICIPANT", "LADDER", "RANDOM_DRAW"].includes(input.kind as string)) reject(400, "unsupported_event_kind");
  const kind = input.kind as AudienceEventKind;
  if (kind === "ROULETTE_ITEM" && input.keyword !== undefined) reject(400, "invalid_event_rules");
  const keyword = kind === "ROULETTE_ITEM" ? null : text(input.keyword, 100);
  const winnerCount = kind === "LADDER" ? input.winnerCount ?? 1 : input.winnerCount;
  if (!Number.isInteger(winnerCount) || (winnerCount as number) < 1 || (winnerCount as number) > 100 || (kind === "LADDER" && winnerCount !== 1) || typeof input.testMode !== "boolean") reject(400, "invalid_request");
  const settingsConfig = normalizeExecutionSettings(kind, input);
  if (input.sellerNoticeAcknowledged !== true) reject(400, "seller_notice_required");
  if (typeof input.closesAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(input.closesAt)) reject(400, "invalid_request");
  const closesAt = new Date(input.closesAt as string);
  if (!Number.isFinite(closesAt.getTime())) reject(400, "invalid_request");
  const config = { broadcastSessionId, title, keyword, winnerCount: winnerCount as number, testMode: input.testMode as boolean, closesAt: closesAt.toISOString(), kind };
  const requestHash = createHash("sha256").update(JSON.stringify({ ...config, settings: settingsConfig })).digest("hex");
  return db.$transaction(async (tx) => {
    const at = await lockSeller(tx, ctx.sellerId);
    const previous = await tx.audienceEvent.findUnique({ where: { sellerId_requestKey: { sellerId: ctx.sellerId, requestKey } } });
    if (previous) return previous.requestHash === requestHash ? previous : reject(409, "idempotency_conflict");
    if (closesAt <= at || closesAt.getTime() > at.getTime() + 86_400_000) reject(400, "invalid_deadline");
    await mutationLimit(tx, ctx.sellerId, at);
    const live = await tx.youtubeLiveLink.findFirst({ where: { sellerId: ctx.sellerId, broadcastSessionId, status: "LIVE", ...(kind === "ROULETTE_ITEM" ? {} : { chatEnabled: true, liveChatId: { not: null } }), broadcast: { status: "LIVE" } } });
    if (!live) reject(409, kind === "ROULETTE_ITEM" ? "active_youtube_live_required" : "active_youtube_chat_required");
    if (await tx.audienceEvent.count({ where: { sellerId: ctx.sellerId, broadcastSessionId } }) >= EVENT_BROADCAST_LIMIT) reject(429, "event_limit");
    if (await tx.audienceEvent.count({ where: { sellerId: ctx.sellerId, status: "OPEN" } })) reject(409, "event_already_open");
    const settings = allocateExecutionSettings(settingsConfig);
    if (kind === "ROULETTE_ITEM") previewEventExecution({ kind, winnerCount: winnerCount as number, settings, entrantIds: [] });
    const event = await tx.audienceEvent.create({ data: { ...config, rules: settings, closesAt, sellerId: ctx.sellerId, liveLinkId: live!.id, liveChatId: live!.liveChatId, requestKey, requestHash, noticeAcknowledgedAt: at, openedAt: at } });
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
    if (!event || event.kind === "ROULETTE_ITEM") return { accepted: 0, rejectedIdentity: 0 };
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
  const settings = event.rules && typeof event.rules === "object" && !Array.isArray(event.rules) && "allowDuplicateWinners" in event.rules ? event.rules : { allowDuplicateWinners: false };
  return { version: 2, kind: event.kind, keyword: event.keyword, settings, previousWinnerIds: [], match: "whole_trimmed_exact", identity: "youtube_author_channel_id", winnerCount: event.winnerCount, testMode: event.testMode, closesAt: event.closesAt.toISOString(), entrantLimit: EVENT_ENTRANT_LIMIT, rewardsEnabled: false };
}
export async function freezeAudienceEvent(db: PrismaClient, ctx: TenantContext, id: unknown) {
  requireSellerPermission(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  return db.$transaction(async (tx) => {
    const at = await lockSeller(tx, ctx.sellerId);
    const event = await eventOf(tx, ctx.sellerId, eventId);
    const existing = await tx.audienceEventRound.findFirst({ where: { sellerId: ctx.sellerId, eventId, roundNumber: 1 } });
    if (existing) return existing;
    if (event.status !== "OPEN") reject(409, "invalid_event_state");
    await mutationLimit(tx, ctx.sellerId, at);
    const entrants = await tx.audienceEventEntrant.findMany({ where: { sellerId: ctx.sellerId, eventId }, orderBy: [{ publishedAt: "asc" }, { id: "asc" }], select: { id: true }, take: EVENT_ENTRANT_LIMIT });
    const rulesSnapshot = rulesOf(event), entrantIds = entrants.map(e => e.id);
    if (event.kind === "LADDER") previewEventExecution(executionSnapshotOf(rulesSnapshot, entrantIds));
    await tx.audienceEvent.update({ where: { id: eventId }, data: { status: "FROZEN", frozenAt: at } });
    const round = await tx.audienceEventRound.create({ data: { sellerId: ctx.sellerId, eventId, roundNumber: 1, requestKey: event.requestKey, requestHash: event.requestHash, actorType: ctx.actorType, actorId: ctx.actorId, frozenAt: at, rulesSnapshot, entrantIds } });
    await writeAudit(tx, audit(ctx, eventId, "freeze", { roundId: round.id, entrants: entrants.length }));
    return round;
  });
}

// 서버에서만 결정한다. 결과 입력/교체 API와 지급 연결은 없다. 시험·실행 모두 경품 원장을 만들지 않는다.
export async function drawAudienceEvent(db: PrismaClient, ctx: TenantContext, id: unknown, selectedRoundId?: unknown) {
  requireSellerPermission(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  return db.$transaction(async (tx) => {
    const at = await lockSeller(tx, ctx.sellerId);
    const event = await eventOf(tx, ctx.sellerId, eventId);
    // 기존 draw API의 재시도는 항상 첫 회차다. execute API는 명시 roundId를 전달한다.
    const round = await tx.audienceEventRound.findFirst({ where: { sellerId: ctx.sellerId, eventId, ...(selectedRoundId === undefined ? { roundNumber: 1 } : { id: uuid(selectedRoundId) }) }, include: { result: true } });
    if (round?.result) return round.result;
    if (!["FROZEN", "COMPLETED"].includes(event.status) || !round) reject(409, "invalid_event_state");
    await mutationLimit(tx, ctx.sellerId, at);
    const snapshot = executionSnapshotOf(round!.rulesSnapshot, round!.entrantIds);
    const execution = executeEventSnapshot(snapshot);
    const rules = round!.rulesSnapshot as { winnerCount: number; testMode: boolean };
    const winnerEntrantIds = snapshot.kind === "ROULETTE_ITEM" || snapshot.kind === "LADDER" ? [] : execution.draw!.selectedIds;
    const result = await tx.audienceEventResult.create({ data: { sellerId: ctx.sellerId, roundId: round!.id, algorithmVersion: snapshot.kind === "LADDER" ? "ladder-uniform-permutation-v1" : "equal-chance-draw-v1", winnerEntrantIds, execution: JSON.parse(JSON.stringify(execution)) as Prisma.InputJsonValue, testMode: rules.testMode } });
    if (event.status === "FROZEN") await tx.audienceEvent.update({ where: { id: eventId }, data: { status: "COMPLETED", completedAt: at } });
    await writeAudit(tx, audit(ctx, eventId, "draw", { resultId: result.id, winners: rules.winnerCount, testMode: rules.testMode, rewardsEnabled: false }));
    return result;
  });
}
export type NextRoundInput = { sourceRoundId?: unknown; requestKey?: unknown; reason?: unknown; allowDuplicateWinners?: unknown };
// 재추첨은 이전 회차를 변경하지 않는다. 사유·실행자를 가진 새로운 불변 회차를 만든다.
export async function createNextAudienceRound(db: PrismaClient, ctx: TenantContext, id: unknown, input: NextRoundInput) {
  requireSellerPermission(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  if (Object.keys(input).some(key => !["sourceRoundId", "requestKey", "reason", "allowDuplicateWinners"].includes(key))) reject(400, "invalid_request");
  const sourceRoundId = uuid(input.sourceRoundId), requestKey = uuid(input.requestKey), reason = text(input.reason, 500);
  if (input.allowDuplicateWinners !== undefined && typeof input.allowDuplicateWinners !== "boolean") reject(400, "invalid_request");
  const requestHash = createHash("sha256").update(JSON.stringify({ sourceRoundId, reason, allowDuplicateWinners: input.allowDuplicateWinners ?? null })).digest("hex");
  return db.$transaction(async tx => {
    const at = await lockSeller(tx, ctx.sellerId);
    const event = await eventOf(tx, ctx.sellerId, eventId);
    const previous = await tx.audienceEventRound.findUnique({ where: { sellerId_eventId_requestKey: { sellerId: ctx.sellerId, eventId, requestKey } } });
    if (previous) return previous.requestHash === requestHash ? previous : reject(409, "idempotency_conflict");
    const source = await tx.audienceEventRound.findFirst({ where: { sellerId: ctx.sellerId, eventId, id: sourceRoundId }, include: { result: true } });
    if (!source) reject(404, "not_found");
    const latest = await tx.audienceEventRound.findFirst({ where: { sellerId: ctx.sellerId, eventId }, orderBy: { roundNumber: "desc" }, select: { id: true } });
    if (event.status !== "COMPLETED" || !source!.result || latest?.id !== sourceRoundId) reject(409, "completed_latest_round_required");
    if (source!.roundNumber >= 100) reject(429, "round_resource_guard");
    await mutationLimit(tx, ctx.sellerId, at);
    const snapshot = executionSnapshotOf(source!.rulesSnapshot, source!.entrantIds);
    const allowDuplicateWinners = input.allowDuplicateWinners ?? snapshot.settings.allowDuplicateWinners;
    if (snapshot.kind === "LADDER" && allowDuplicateWinners) reject(400, "invalid_event_rules");
    const results = await tx.audienceEventRound.findMany({ where: { sellerId: ctx.sellerId, eventId }, include: { result: true }, take: 100 });
    const previousWinnerIds = [...new Set(results.flatMap(round => {
      if (!round.result || snapshot.kind === "LADDER") return [];
      if (snapshot.kind !== "ROULETTE_ITEM") return round.result.winnerEntrantIds as string[];
      const value = round.result.execution as { draw?: { selectedIds?: string[] } };
      return value.draw?.selectedIds ?? [];
    }))];
    const settings = { ...snapshot.settings, allowDuplicateWinners: allowDuplicateWinners as boolean };
    const rulesSnapshot = { ...(source!.rulesSnapshot as Record<string, Prisma.InputJsonValue>), version: 2, settings: JSON.parse(JSON.stringify(settings)) as Prisma.InputJsonValue, previousWinnerIds };
    // 부족한 후보/슬롯은 새 회차를 만들기 전에 명시적으로 거부한다.
    previewEventExecution(executionSnapshotOf(rulesSnapshot, source!.entrantIds));
    const round = await tx.audienceEventRound.create({ data: { sellerId: ctx.sellerId, eventId, roundNumber: source!.roundNumber + 1, requestKey, requestHash, sourceRoundId, reason, actorType: ctx.actorType, actorId: ctx.actorId, frozenAt: at, rulesSnapshot, entrantIds: source!.entrantIds as Prisma.InputJsonValue } });
    await writeAudit(tx, audit(ctx, eventId, "next_round", { roundId: round.id, sourceRoundId, reason, rewardsEnabled: false }));
    return round;
  });
}

export type PublicationInput = { roundId?: unknown; requestKey?: unknown; scope?: unknown; participantId?: unknown };
// 개별/전체 공개는 명시적인 scope를 받아 공개기록을 추가한다. 재표시는 별도 함수다.
export async function publishAudienceResult(db: PrismaClient, ctx: TenantContext, id: unknown, input: PublicationInput) {
  requireSellerPermission(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  if (Object.keys(input).some(key => !["roundId", "requestKey", "scope", "participantId"].includes(key))) reject(400, "invalid_request");
  const roundId = uuid(input.roundId), requestKey = uuid(input.requestKey);
  const participantId = input.participantId === undefined ? null : uuid(input.participantId);
  if (input.scope !== "ALL" && input.scope !== "PARTICIPANT") reject(400, "publication_scope_required");
  const scope = input.scope as "ALL" | "PARTICIPANT";
  if ((scope === "ALL" && participantId !== null) || (scope === "PARTICIPANT" && participantId === null)) reject(400, "invalid_publication_target");
  return db.$transaction(async tx => {
    const at = await lockSeller(tx, ctx.sellerId);
    await eventOf(tx, ctx.sellerId, eventId);
    const round = await tx.audienceEventRound.findFirst({ where: { sellerId: ctx.sellerId, eventId, id: roundId }, include: { result: true } });
    if (!round) reject(404, "not_found");
    if (!round!.result) reject(409, "confirmed_result_required");
    const previous = await tx.audienceEventPublication.findUnique({ where: { sellerId_requestKey: { sellerId: ctx.sellerId, requestKey } } });
    if (previous) {
      if (previous.roundId !== roundId || previous.scope !== scope || previous.participantId !== participantId) reject(409, "idempotency_conflict");
      return { publication: previous, result: round!.result, rewardsEnabled: false };
    }
    if (participantId) {
      const snapshot = executionSnapshotOf(round!.rulesSnapshot, round!.entrantIds);
      if (snapshot.kind !== "LADDER" || !snapshot.entrantIds.includes(participantId)) reject(400, "invalid_publication_target");
    }
    await mutationLimit(tx, ctx.sellerId, at);
    if (await tx.audienceEventPublication.count({ where: { sellerId: ctx.sellerId, roundId } }) >= 5_000) reject(429, "publication_resource_guard");
    const publication = await tx.audienceEventPublication.create({ data: { sellerId: ctx.sellerId, roundId, requestKey, scope, participantId, actorType: ctx.actorType, actorId: ctx.actorId } });
    await writeAudit(tx, audit(ctx, eventId, "publish", { roundId, scope, participantId, rewardsEnabled: false }));
    return { publication, result: round!.result, rewardsEnabled: false };
  });
}

export type RedisplayInput = { roundId?: unknown; requestKey?: unknown };
// 재표시는 현재 공개 진행을 복원한다. 공개 범위를 확대하거나 회차/결과를 새로 만들지 않는다.
export async function redisplayAudienceResult(db: PrismaClient, ctx: TenantContext, id: unknown, input: RedisplayInput) {
  requireSellerPermission(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  if (Object.keys(input).some(key => !["roundId", "requestKey"].includes(key))) reject(400, "invalid_request");
  const roundId = uuid(input.roundId), requestKey = uuid(input.requestKey);
  return db.$transaction(async tx => {
    const at = await lockSeller(tx, ctx.sellerId);
    await eventOf(tx, ctx.sellerId, eventId);
    const round = await tx.audienceEventRound.findFirst({ where: { sellerId: ctx.sellerId, eventId, id: roundId }, include: { result: true } });
    if (!round) reject(404, "not_found");
    if (!round!.result) reject(409, "confirmed_result_required");
    const previous = await tx.auditLog.findFirst({ where: { sellerId: ctx.sellerId, action: "audience_event.redisplay", after: { path: ["requestKey"], equals: requestKey } } });
    if (previous && (previous.targetId !== eventId || (previous.after as { roundId?: string } | null)?.roundId !== roundId)) reject(409, "idempotency_conflict");
    if (!previous) {
      await mutationLimit(tx, ctx.sellerId, at);
      await writeAudit(tx, audit(ctx, eventId, "redisplay", { roundId, requestKey, rewardsEnabled: false }));
    }
    const publications = await tx.audienceEventPublication.findMany({ where: { sellerId: ctx.sellerId, roundId }, orderBy: { createdAt: "asc" }, take: 5_000 });
    const publicationState = { all: publications.some(row => row.scope === "ALL"), participantIds: [...new Set(publications.flatMap(row => row.scope === "PARTICIPANT" && row.participantId ? [row.participantId] : []))] };
    return { result: round!.result, publicationState, rewardsEnabled: false };
  });
}

export async function previewAudienceEvent(db: PrismaClient, ctx: TenantContext, id: unknown, selectedRoundId?: string | null) {
  requireSellerRead(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  return db.$transaction(async tx => {
    // Collector/freeze와 같은 Seller 잠금으로 명단과 규칙을 한 시점에서 읽는다.
    await lockSeller(tx, ctx.sellerId);
    const event = await eventOf(tx, ctx.sellerId, eventId);
    const round = await tx.audienceEventRound.findFirst({ where: { sellerId: ctx.sellerId, eventId, ...(selectedRoundId ? { id: uuid(selectedRoundId) } : {}) }, orderBy: { roundNumber: "desc" } });
    if (selectedRoundId && !round) reject(404, "not_found");
    const entrants = await tx.audienceEventEntrant.findMany({ where: { sellerId: ctx.sellerId, eventId }, orderBy: [{ publishedAt: "asc" }, { id: "asc" }], take: EVENT_ENTRANT_LIMIT, select: { id: true, displayName: true } });
    const rules = round?.rulesSnapshot ?? rulesOf(event), ids = round?.entrantIds ?? entrants.map(entry => entry.id);
    const preview = previewEventExecution(executionSnapshotOf(rules, ids));
    return { eventId, roundId: round?.id ?? null, frozen: !!round, ...preview, targets: entrants.filter(entry => preview.candidateIds.includes(entry.id)), rewardsEnabled: false };
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
export async function readAudienceEvent(db: PrismaClient, ctx: TenantContext, id: unknown, cursor?: string | null, selectedRoundId?: string | null) {
  requireSellerRead(ctx, "BROADCAST_RUN"); const eventId = uuid(id);
  if (cursor) uuid(cursor);
  const event = await db.audienceEvent.findFirst({ where: { sellerId: ctx.sellerId, id: eventId }, include: { _count: { select: { entrants: true } } } });
  if (!event) reject(404, "not_found");
  const round = await db.audienceEventRound.findFirst({ where: { sellerId: ctx.sellerId, eventId, ...(selectedRoundId ? { id: uuid(selectedRoundId) } : {}) }, orderBy: { roundNumber: "desc" }, include: { result: true } });
  if (selectedRoundId && !round) reject(404, "not_found");
  const history = await db.audienceEventRound.findMany({ where: { sellerId: ctx.sellerId, eventId }, orderBy: { roundNumber: "desc" }, take: 100, select: { id: true, roundNumber: true, sourceRoundId: true, reason: true, actorType: true, actorId: true, frozenAt: true, result: { select: { id: true, createdAt: true, testMode: true } } } });
  const publications = round ? await db.audienceEventPublication.findMany({ where: { sellerId: ctx.sellerId, roundId: round.id }, orderBy: { createdAt: "asc" }, take: 5001 }) : [];
  const entrants = await db.audienceEventEntrant.findMany({ where: { sellerId: ctx.sellerId, eventId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: 101, select: { id: true, displayName: true, publishedAt: true } });
  return { event: { ...event, rounds: round ? [round] : [] }, history, publications, entrants: entrants.slice(0, 100), nextCursor: entrants.length > 100 ? entrants[99].id : null, notice: EVENT_NOTICE, rewardsEnabled: false };
}
