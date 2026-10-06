import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { generateToken, hashToken } from "../auth/token";
import { resolveBuyerSession } from "../auth/session";
import { unauthenticated } from "../authz/errors";
import { writeAudit } from "../audit/log";
import { sellerHasFeature } from "../billing/features";
import { sellerAccessFor } from "../billing/subscription";
import { lockSellerOrders } from "../orders/overdue";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { WITHDRAWN_DISPLAY_NAME } from "../buyers/memberData";
import { EventError } from "./errors";
import { parseDirectEntries, parseEntryDisplayName, parseEntryRequestKey, parsePastedEntries } from "./entryInput";
import { EVENT_ENTRANT_LIMIT, eventOf, lockSeller, mutationLimit, requireEventMutation } from "./service";

type Tx = Prisma.TransactionClient;
export const EVENT_ENTRY_RULES_VERSION = "audience-entry-v1";
export const EVENT_GUEST_COOKIE = "lo_event_guest";
const fail = (status: EventError["status"], code: string): never => { throw new EventError(status, code); };
export const eventParticipantApiPath = (eventId: string) => `/api/public/events/${eventId}`;
const validGuestToken = (value: string | undefined): value is string => !!value && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
async function available(tx: Tx, sellerId: string, at: Date) {
  const seller = await tx.seller.findUnique({ where: { id: sellerId }, select: { status: true } });
  return seller?.status === "ACTIVE" && (await sellerAccessFor(tx, sellerId, at)) !== "expired" && await sellerHasFeature(tx, sellerId, "OVERLAY", at);
}
async function openEvent(tx: Tx, sellerId: string, eventId: string, method: "DIRECT_INPUT" | "PASTE" | "MOBILE", at: Date) {
  const event = await eventOf(tx, sellerId, eventId);
  if (!event.entryMethods.includes(method) || event.kind === "ROULETTE_ITEM") fail(409, "entry_method_not_enabled");
  const live = await tx.broadcastSession.findFirst({ where: { sellerId, id: event.broadcastSessionId, status: "LIVE" }, select: { id: true } });
  if (event.status !== "OPEN" || event.closesAt <= at || !live) fail(409, "entry_closed");
  if (!(await available(tx, sellerId, at))) fail(409, "event_unavailable");
  return event;
}
async function batchValue(tx: Tx, batch: { id: string; inputCount: number; acceptedCount: number }) {
  const entrants = await tx.audienceEventEntrant.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" }, select: { id: true, displayName: true, source: true, rowNumber: true } });
  return { batchId: batch.id, acceptedCount: batch.acceptedCount, alreadyRegisteredCount: batch.inputCount - batch.acceptedCount, entrants, rewardsEnabled: false };
}
// 표시 이름으로 합치지 않는다. 회원은 기존 ID, 이름만 있는 줄은 서버 발급 entrant UUID와 batch row가 식별자다.
export async function registerManualEventEntries(db: PrismaClient, ctx: TenantContext, id: unknown, method: "DIRECT_INPUT" | "PASTE", input: unknown) {
  requireEventMutation(ctx); const eventId = parseEntryRequestKey(id);
  const batch = method === "DIRECT_INPUT" ? parseDirectEntries(input) : parsePastedEntries(input);
  return db.$transaction(async tx => {
    // 탈퇴와 같은 기존 잠금 순서: seller-order advisory → Seller row → member row.
    await lockSellerOrders(tx, ctx.sellerId);
    const at = await lockSeller(tx, ctx.sellerId);
    await eventOf(tx, ctx.sellerId, eventId);
    const previous = await tx.audienceEventEntryBatch.findUnique({ where: { sellerId_eventId_requestKey: { sellerId: ctx.sellerId, eventId, requestKey: batch.requestKey } } });
    if (previous) {
      if (!previous.requestHash) fail(409, "entry_batch_anonymized");
      if (previous.requestHash !== batch.requestHash) fail(409, "idempotency_conflict");
      return batchValue(tx, previous);
    }
    await openEvent(tx, ctx.sellerId, eventId, method, at);
    await mutationLimit(tx, ctx.sellerId, at);
    const existing = await tx.audienceEventEntrant.findMany({ where: { sellerId: ctx.sellerId, eventId }, select: { buyerMemberId: true }, take: EVENT_ENTRANT_LIMIT });
    const members = new Set(existing.flatMap(row => row.buyerMemberId ? [row.buyerMemberId] : []));
    const data: Prisma.AudienceEventEntrantCreateManyInput[] = [];
    for (const [index, entry] of batch.entries.entries()) {
      let displayName = entry.displayName;
      if (entry.buyerMemberId) {
        const [member] = await tx.$queryRaw<{ id: string; broadcastNickname: string }[]>`SELECT id, "broadcastNickname" FROM "BuyerMember" WHERE "sellerId"=${ctx.sellerId}::uuid AND id=${entry.buyerMemberId}::uuid AND status='ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
        if (!member) fail(404, "member_not_found");
        if (members.has(entry.buyerMemberId)) continue;
        members.add(entry.buyerMemberId); displayName ??= member.broadcastNickname;
      }
      data.push({ sellerId: ctx.sellerId, eventId, source: method, buyerMemberId: entry.buyerMemberId, rowNumber: index + 1, displayName: parseEntryDisplayName(displayName), publishedAt: at, acceptedAt: at });
    }
    if (existing.length + data.length > EVENT_ENTRANT_LIMIT) fail(429, "entrant_resource_guard");
    const receipt = await tx.audienceEventEntryBatch.create({ data: { sellerId: ctx.sellerId, eventId, method, requestKey: batch.requestKey, requestHash: batch.requestHash, inputCount: batch.entries.length, acceptedCount: data.length, createdAt: at } });
    if (data.length) await tx.audienceEventEntrant.createMany({ data: data.map(row => ({ ...row, batchId: receipt.id })) });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "audience_event.manual_batch", targetType: "AudienceEvent", targetId: eventId, after: { method, accepted: data.length, alreadyRegistered: batch.entries.length - data.length, rewardsEnabled: false } });
    return batchValue(tx, receipt);
  });
}
export async function readEventParticipationLink(db: PrismaClient, ctx: TenantContext, id: unknown) {
  requireSellerRead(ctx, "BROADCAST_RUN"); const eventId = parseEntryRequestKey(id);
  const event = await db.audienceEvent.findFirst({ where: { sellerId: ctx.sellerId, id: eventId } });
  if (!event) fail(404, "not_found");
  if (!event!.entryMethods.includes("MOBILE")) fail(409, "entry_method_not_enabled");
  // QR 인코딩 대상 서버 계약. 참가 페이지 UI는 DRAFT라 경로를 임의 구현/완료 표시하지 않는다.
  return { eventId, apiPath: eventParticipantApiPath(eventId), participantPageReady: false, rewardsEnabled: false };
}
async function publicEvent(db: PrismaClient, id: unknown) {
  const eventId = parseEntryRequestKey(id), event = await db.audienceEvent.findUnique({ where: { id: eventId } });
  if (!event || !event.entryMethods.includes("MOBILE") || event.kind === "ROULETTE_ITEM") fail(404, "not_found");
  const [clock] = await db.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  await db.audienceEventGuestSession.updateMany({ where: { sellerId: event!.sellerId, eventId: event!.id, expiresAt: { lte: clock.at }, tokenHash: { not: null } }, data: { tokenHash: null } });
  return event!;
}
export async function readPublicEventParticipation(db: PrismaClient, id: unknown) {
  const event = await publicEvent(db, id);
  const [clock] = await db.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  const live = await db.broadcastSession.findFirst({ where: { id: event.broadcastSessionId, sellerId: event.sellerId, status: "LIVE" }, select: { id: true } });
  const settings = event.rules as { allowDuplicateWinners?: boolean };
  return { eventId: event.id, title: event.title, kind: event.kind, status: event.status, closesAt: event.closesAt, testMode: event.testMode, entryOpen: event.status === "OPEN" && event.closesAt > clock.at && !!live && await available(db, event.sellerId, clock.at), entryRulesVersion: EVENT_ENTRY_RULES_VERSION, rules: { winnerCount: event.winnerCount, allowDuplicateWinners: settings.allowDuplicateWinners ?? false, probability: "EQUAL", rewardsEnabled: false }, notice: "참가 조건과 마감 시각을 확인해 주세요. 닉네임과 참가 식별정보로 이 이벤트에 참가해요. 회원은 로그인한 회원 ID로, 게스트는 이 이벤트의 브라우저 세션으로 구분해요. 시험 모드에서는 실제 경품을 지급하지 않아요.", rewardsEnabled: false };
}
// 먼저 세션 쿠키를 받은 뒤 참가 요청을 보낸다. 참가 응답이 유실돼도 동일 cookie identity로 재시도한다.
export async function issueEventGuestSession(db: PrismaClient, id: unknown, existingToken?: string) {
  const event = await publicEvent(db, id);
  return db.$transaction(async tx => {
    const at = await lockSeller(tx, event.sellerId), current = await openEvent(tx, event.sellerId, event.id, "MOBILE", at);
    if (validGuestToken(existingToken)) {
      const previous = await tx.audienceEventGuestSession.findUnique({ where: { tokenHash: hashToken(existingToken) } });
      if (previous?.sellerId === event.sellerId && previous.eventId === event.id && previous.expiresAt > at) return { token: existingToken, expiresAt: previous.expiresAt };
    }
    if (await tx.audienceEventGuestSession.count({ where: { sellerId: event.sellerId, eventId: event.id, createdAt: { gte: new Date(at.getTime() - 60_000) } } }) >= 300) fail(429, "rate_limited");
    if (await tx.audienceEventGuestSession.count({ where: { sellerId: event.sellerId, eventId: event.id } }) >= 10_000) fail(429, "guest_session_resource_guard");
    const token = generateToken(), expiresAt = new Date(current.closesAt.getTime() + 86_400_000);
    await tx.audienceEventGuestSession.create({ data: { sellerId: event.sellerId, eventId: event.id, tokenHash: hashToken(token), expiresAt, createdAt: at } });
    return { token, expiresAt };
  });
}
export async function joinMobileEvent(db: PrismaClient, id: unknown, input: Record<string, unknown>, credentials: { buyerToken?: string; guestToken?: string }) {
  if (Object.keys(input).some(key => !["requestKey", "displayName", "entryRulesVersion", "rulesAcknowledged"].includes(key))) fail(400, "invalid_entry_input");
  const requestKey = parseEntryRequestKey(input.requestKey);
  // 참가 규칙 안내 확인이며 개인정보 동의로 기록하거나 해석하지 않는다.
  if (input.entryRulesVersion !== EVENT_ENTRY_RULES_VERSION || input.rulesAcknowledged !== true) fail(400, "entry_rules_required");
  if (!credentials.buyerToken && !validGuestToken(credentials.guestToken)) throw unauthenticated();
  const event = await publicEvent(db, id);
  const buyer = credentials.buyerToken ? await resolveBuyerSession(db, credentials.buyerToken, event.sellerId) : null;
  if (credentials.buyerToken && !buyer) throw unauthenticated();
  const guestToken = credentials.guestToken;
  if (!buyer && !validGuestToken(guestToken)) throw unauthenticated();
  return db.$transaction(async tx => {
    await lockSellerOrders(tx, event.sellerId);
    const at = await lockSeller(tx, event.sellerId);
    let buyerMemberId: string | undefined, guestSessionId: string | undefined, displayName: string;
    if (buyer) {
      const [member] = await tx.$queryRaw<{ id: string; broadcastNickname: string }[]>`SELECT id,"broadcastNickname" FROM "BuyerMember" WHERE "sellerId"=${event.sellerId}::uuid AND id=${buyer.member.id}::uuid AND status='ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
      if (!member) throw unauthenticated(); buyerMemberId = member.id; displayName = parseEntryDisplayName(member.broadcastNickname);
    } else {
      const session = await tx.audienceEventGuestSession.findUnique({ where: { tokenHash: hashToken(guestToken!) } });
      if (!session || session.sellerId !== event.sellerId || session.eventId !== event.id || session.expiresAt <= at) throw unauthenticated();
      guestSessionId = session.id; displayName = parseEntryDisplayName(input.displayName);
    }
    const attemptScope = buyerMemberId ? { actorType: "BUYER" as const, actorId: buyerMemberId, targetType: "AudienceEvent", targetId: event.id } : { actorType: "SYSTEM" as const, targetType: "AudienceEventGuestSession", targetId: guestSessionId! };
    if (await tx.auditLog.count({ where: { sellerId: event.sellerId, ...attemptScope, action: "audience_event.mobile_attempt", createdAt: { gte: new Date(at.getTime() - 60_000) } } }) >= 20) fail(429, "rate_limited");
    await writeAudit(tx, { ...attemptScope, sellerId: event.sellerId, action: "audience_event.mobile_attempt" });
    const requestHash = createHash("sha256").update(JSON.stringify({ displayName, entryRulesVersion: EVENT_ENTRY_RULES_VERSION })).digest("hex");
    const keyed = await tx.audienceEventEntrant.findUnique({ where: { sellerId_eventId_requestKey: { sellerId: event.sellerId, eventId: event.id, requestKey } } });
    if (keyed) {
      if (keyed.buyerMemberId !== (buyerMemberId ?? null) || keyed.guestSessionId !== (guestSessionId ?? null) || keyed.requestHash !== requestHash) fail(409, "idempotency_conflict");
      return { entrant: { id: keyed.id, displayName: keyed.displayName, source: keyed.source }, alreadyRegistered: true, rewardsEnabled: false };
    }
    const previous = await tx.audienceEventEntrant.findFirst({ where: { sellerId: event.sellerId, eventId: event.id, ...(buyerMemberId ? { buyerMemberId } : { guestSessionId }) } });
    if (previous) return { entrant: { id: previous.id, displayName: previous.displayName, source: previous.source }, alreadyRegistered: true, rewardsEnabled: false };
    await openEvent(tx, event.sellerId, event.id, "MOBILE", at);
    if (await tx.audienceEventEntrant.count({ where: { sellerId: event.sellerId, eventId: event.id } }) >= EVENT_ENTRANT_LIMIT) fail(429, "entrant_resource_guard");
    const entrant = await tx.audienceEventEntrant.create({ data: { sellerId: event.sellerId, eventId: event.id, source: "MOBILE", buyerMemberId, guestSessionId, requestKey, requestHash, displayName, entryRulesVersion: EVENT_ENTRY_RULES_VERSION, rulesAcknowledgedAt: at, publishedAt: at, acceptedAt: at } });
    await writeAudit(tx, { actorType: buyerMemberId ? "BUYER" : "SYSTEM", actorId: buyerMemberId, sellerId: event.sellerId, action: "audience_event.mobile_join", targetType: "AudienceEvent", targetId: event.id, after: { source: "MOBILE", rewardsEnabled: false } });
    return { entrant: { id: entrant.id, displayName: entrant.displayName, source: entrant.source }, alreadyRegistered: false, rewardsEnabled: false };
  });
}
// 같은 탈퇴 트랜잭션 안에서 호출한다. 명단/회차/결과 UUID는 보존하며 개인 표시 정보만 비식별한다.
export async function anonymizeMemberEventEntries(tx: Tx, scope: { sellerId: string; buyerMemberId: string }, at: Date) {
  await lockSeller(tx, scope.sellerId);
  const erased = await tx.$queryRaw<{ batchId: string | null }[]>`UPDATE "AudienceEventEntrant" SET "buyerMemberId"=NULL,"displayName"=${WITHDRAWN_DISPLAY_NAME},"anonymizedAt"=${at},"requestKey"=NULL,"requestHash"=NULL WHERE "sellerId"=${scope.sellerId}::uuid AND "buyerMemberId"=${scope.buyerMemberId}::uuid RETURNING "batchId"`;
  const batchIds = [...new Set(erased.flatMap(row => row.batchId ? [row.batchId] : []))];
  if (batchIds.length) await tx.audienceEventEntryBatch.updateMany({ where: { sellerId: scope.sellerId, id: { in: batchIds } }, data: { requestHash: null } });
  return { anonymizedEventEntries: erased.length };
}
