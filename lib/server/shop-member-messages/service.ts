import { Prisma, type ActorType, type MemberMessage, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import {
  DAILY_CAP,
  RECIPIENT_MAX,
  adTextOk,
  SCHEDULE_MAX_DAYS,
  inAdWindow,
  isLongMessage,
  isUuid,
  kstDayStart,
  kstMonthStart,
  nextAdTime,
  parseMessage,
  renderBody,
  targetParams,
  type MessageRejection,
  type NewMessageInput,
  type TargetSpec,
} from "./rules";

// 회원 대상 발송(SA-049, 2026-10-05). 실제 발송 채널과 충전 잔액 차감은 대표님 결정 전이라 만들지 않고, 보낼 대상·문구·시각을 「기록」(RECORDED)만 남긴다.
// - 광고성(AD)은 혜택·소식 수신 동의 회원만, 정보성(INFO)은 정상 회원 전체. 광고성 문구에는 (광고)·쇼핑몰 이름·무료 수신거부를 자동으로 붙인다.
// - 광고성은 08:00~21:00(KST)에만: 「지금」이 그 밖이면 다음 08:00 예약으로 바꾸고, 직접 정한 예약 시각이 그 밖이면 거절한다.
// - 같은 회원은 하루(KST)에 기록된 발송을 2건까지만 받는다(넘는 회원은 이번 발송에서 뺀다). 기록·예약 확정은 쇼핑몰 단위 advisory lock 아래서 해 동시 발송도 한도를 넘지 않는다.
// - 예약은 시각이 되면(정기 작업 processDueMemberMessages) 대상을 다시 계산해 받는 사람 행을 만들고 기록으로 바꾼다. 수정·취소는 예약일 때만.
// - 받는 사람 연락처는 저장하지 않는다. 모든 변경은 로그 추적(member_message.*)에 남기고 회원 id는 남기지 않는다. 권한 MEMBER_POINTS.
type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

export type MessageFailure = MessageRejection | "not_found" | "invalid_transition" | "ad_time_window" | "schedule_out_of_range" | "no_recipients" | "too_many_recipients" | "opt_out_missing";
export const MESSAGE_MESSAGES: Record<string, string> = {
  invalid_title: "제목을 40자 이내로 입력해 주십시오",
  invalid_body: "문구를 500자 이내로 입력해 주십시오",
  invalid_kind: "광고성 또는 정보성을 골라 주십시오",
  invalid_channel: "채널을 골라 주십시오",
  invalid_target: "대상을 확인해 주십시오",
  invalid_schedule: "예약 시각을 확인해 주십시오",
  invalid_send_mode: "보내는 시각을 골라 주십시오",
  schedule_out_of_range: "예약은 지금부터 30일 안의 미래 시각만 정할 수 있습니다",
  ad_time_window: "광고성 알림은 08:00 ~ 21:00에만 보낼 수 있습니다. 다음 08:00으로 바꾸거나 정보성으로 보내 주십시오",
  no_recipients: "보낼 수 있는 회원이 없습니다. 대상과 수신 동의 여부를 확인해 주십시오",
  opt_out_missing: "광고성 문구에 (광고) 표기와 무료 수신거부 문구가 없어 기록할 수 없습니다",
  too_many_recipients: "한 번에 보낼 수 있는 회원은 10,000명까지입니다",
  not_found: "발송을 찾을 수 없습니다",
  invalid_transition: "이미 처리된 발송입니다. 화면을 새로 고쳐 주십시오",
};

const fail = (reason: MessageFailure, extra: Record<string, unknown> = {}) => ({ ok: false as const, reason, ...extra });
const audit = (tx: Db, ctx: TenantContext, action: string, id: string, before: unknown, after: unknown) =>
  writeAudit(tx, { actorType: ctx.actorType as ActorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "MemberMessage", targetId: id, before, after });

async function clockNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return rows[0].now;
}
// 쇼핑몰 단위 직렬화(하루 2건 한도 계산과 기록을 한 줄로 세운다)
const lockSeller = (tx: Tx, sellerId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`member_message:${sellerId}`}, 0))`;

// ───────────── 대상 계산 ─────────────

function targetWhere(sellerId: string, t: TargetSpec, now: Date): Prisma.BuyerMemberWhereInput {
  const base: Prisma.BuyerMemberWhereInput = { sellerId, status: "ACTIVE", deletedAt: null };
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  switch (t.type) {
    case "ALL":
      return base;
    case "GRADE":
      return { ...base, gradeId: { in: t.gradeIds } };
    case "WISHED":
      return { ...base, wishItems: { some: { productId: t.productId } } };
    case "BOUGHT_30D":
      return { ...base, orders: { some: { status: "PAID", paidAt: { gte: days(30) } } } };
    case "NOT_BOUGHT_90D":
      return { ...base, orders: { none: { status: "PAID", paidAt: { gte: days(90) } } } };
    case "PRODUCT_BOUGHT":
      return { ...base, orders: { some: { status: "PAID", items: { some: { productId: t.productId } } } } };
    case "PICKED":
      return { ...base, id: { in: t.memberIds } };
  }
}

// 이 대상의 정상 회원 수(matched)와, 광고성이면 수신 동의 회원만 남긴 받는 사람 목록(ids). 정보성은 matched와 같다.
async function resolveRecipients(db: Db, sellerId: string, kind: "AD" | "INFO", t: TargetSpec, now: Date) {
  const where = targetWhere(sellerId, t, now);
  const matched = await db.buyerMember.count({ where });
  if (matched > RECIPIENT_MAX) return { tooMany: true as const, matched, ids: [] as string[] };
  const rows = await db.buyerMember.findMany({ where: kind === "AD" ? { ...where, marketingConsentAt: { not: null } } : where, select: { id: true }, orderBy: { id: "asc" } });
  return { tooMany: false as const, matched, ids: rows.map((r) => r.id) };
}

// 같은 날(KST) 이미 DAILY_CAP건을 받은 회원을 뺀다. 기준 날짜는 보내는 시각(effectiveAt)의 KST 하루.
async function applyDailyCap(db: Db, sellerId: string, ids: string[], effectiveAt: Date) {
  if (ids.length === 0) return { ids, capped: 0 };
  const dayStart = kstDayStart(effectiveAt);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const groups = await db.memberMessageRecipient.groupBy({
    by: ["buyerMemberId"],
    where: { sellerId, buyerMemberId: { in: ids }, message: { status: "RECORDED", recordedAt: { gte: dayStart, lt: dayEnd } } },
    _count: { _all: true },
  });
  const full = new Set(groups.filter((g) => g._count._all >= DAILY_CAP).map((g) => g.buyerMemberId));
  return { ids: ids.filter((id) => !full.has(id)), capped: full.size };
}

async function shopNameOf(db: Db, sellerId: string) {
  return (await db.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { shopName: true } })).shopName;
}

// 보내는 시각 결정: 지금이면 정보성은 바로, 광고성은 시간 안이면 바로·밖이면 다음 08:00 예약. 예약이면 미래 30일 안이어야 하고 광고성은 시간 안이어야 한다.
function decideTime(v: NewMessageInput, now: Date): { ok: true; at: Date; immediate: boolean; rescheduled: boolean } | { ok: false; reason: "invalid_schedule" | "schedule_out_of_range" | "ad_time_window"; suggestedAt?: Date } {
  if (v.sendMode === "NOW") {
    if (v.kind === "INFO" || inAdWindow(now)) return { ok: true, at: now, immediate: true, rescheduled: false };
    return { ok: true, at: nextAdTime(now), immediate: false, rescheduled: true };
  }
  const at = v.scheduledAt!;
  if (at.getTime() <= now.getTime() + 60_000 || at.getTime() > now.getTime() + SCHEDULE_MAX_DAYS * 86_400_000) return { ok: false, reason: "schedule_out_of_range" };
  if (v.kind === "AD" && !inAdWindow(at)) return { ok: false, reason: "ad_time_window", suggestedAt: nextAdTime(at) };
  return { ok: true, at, immediate: false, rescheduled: false };
}

// ───────────── 미리보기 ─────────────

export async function previewMessage(db: PrismaClient, ctx: TenantContext, raw: Record<string, unknown>) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const parsed = parseMessage({ title: "미리보기", sendMode: "NOW", ...raw });
  if (!parsed.ok) return fail(parsed.reason);
  const v = parsed.v;
  const now = await clockNow(db);
  const time = decideTime(v, now);
  if (!time.ok) return fail(time.reason, time.suggestedAt ? { suggestedAt: time.suggestedAt } : {});
  const r = await resolveRecipients(db, ctx.sellerId, v.kind, v.target, now);
  if (r.tooMany) return fail("too_many_recipients");
  const cap = await applyDailyCap(db, ctx.sellerId, r.ids, time.at);
  const rendered = renderBody(v.kind, await shopNameOf(db, ctx.sellerId), v.body);
  return {
    ok: true as const,
    matched: r.matched,
    consented: r.ids.length,
    noConsent: r.matched - r.ids.length,
    dailyCapped: cap.capped,
    finalCount: cap.ids.length,
    sendAt: time.at,
    immediate: time.immediate,
    rescheduled: time.rescheduled,
    renderedBody: rendered,
    longMessage: isLongMessage(rendered),
  };
}

// ───────────── 만들기·기록 ─────────────

// 받는 사람을 확정해 기록으로 바꾼다. 호출하는 쪽이 쇼핑몰 lock과 이 발송 행 잠금을 잡은 뒤 부른다.
async function record(tx: Tx, m: Pick<MemberMessage, "id" | "sellerId" | "kind" | "targetType" | "targetParams" | "renderedBody">, now: Date) {
  // 광고성 문구에 (광고)·무료 수신거부가 없으면 기록 자체를 거부한다
  if (m.kind === "AD" && !adTextOk(m.renderedBody)) return { ok: false as const, reason: "opt_out_missing" as const };
  const target = { type: m.targetType, ...(m.targetParams as object) } as TargetSpec;
  const r = await resolveRecipients(tx, m.sellerId, m.kind, target, now);
  if (r.tooMany) return { ok: false as const, reason: "too_many_recipients" as const };
  const cap = await applyDailyCap(tx, m.sellerId, r.ids, now);
  if (cap.ids.length > 0) await tx.memberMessageRecipient.createMany({ data: cap.ids.map((buyerMemberId) => ({ sellerId: m.sellerId, messageId: m.id, buyerMemberId, createdAt: now })) });
  await tx.memberMessage.update({ where: { id: m.id }, data: { status: "RECORDED", recordedAt: now, recipientCount: cap.ids.length, skippedDailyCap: cap.capped, updatedAt: now } });
  return { ok: true as const, count: cap.ids.length, capped: cap.capped };
}

const targetOk = async (tx: Db, sellerId: string, t: TargetSpec) => {
  if (t.type === "GRADE") return (await tx.memberGrade.count({ where: { sellerId, id: { in: t.gradeIds } } })) === t.gradeIds.length;
  if (t.type === "WISHED" || t.type === "PRODUCT_BOUGHT") return (await tx.product.count({ where: { sellerId, id: t.productId, deletedAt: null } })) === 1;
  return true;
};

export async function createMessage(db: PrismaClient, ctx: TenantContext, raw: Record<string, unknown>) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const parsed = parseMessage(raw);
  if (!parsed.ok) return fail(parsed.reason);
  const v = parsed.v;
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const now = await clockNow(tx);
    if (!(await targetOk(tx, ctx.sellerId, v.target))) return fail("invalid_target");
    const time = decideTime(v, now);
    if (!time.ok) return fail(time.reason, time.suggestedAt ? { suggestedAt: time.suggestedAt } : {});
    const r = await resolveRecipients(tx, ctx.sellerId, v.kind, v.target, now);
    if (r.tooMany) return fail("too_many_recipients");
    if (r.ids.length === 0) return fail("no_recipients");
    const renderedBody = renderBody(v.kind, await shopNameOf(tx, ctx.sellerId), v.body);
    if (v.kind === "AD" && !adTextOk(renderedBody)) return fail("opt_out_missing");
    const created = await tx.memberMessage.create({
      data: {
        sellerId: ctx.sellerId,
        title: v.title,
        kind: v.kind,
        channel: v.channel,
        body: v.body,
        renderedBody,
        targetType: v.target.type,
        targetParams: targetParams(v.target) as Prisma.InputJsonValue,
        status: "SCHEDULED",
        scheduledAt: time.at,
        estimatedCount: r.ids.length,
        staffId: ctx.actorId,
        createdAt: now,
        updatedAt: now,
      },
    });
    let recorded: { count: number; capped: number } | null = null;
    if (time.immediate) {
      const rec = await record(tx, created, now);
      if (!rec.ok) throw new RecordFailed(rec.reason); // 만든 행이 남지 않게 트랜잭션을 되돌린다
      if (rec.count === 0) throw new NothingToSend();
      recorded = rec;
    }
    await audit(tx, ctx, "member_message.create", created.id, undefined, {
      kind: v.kind,
      channel: v.channel,
      target: v.target.type,
      title: v.title,
      renderedBody: created.renderedBody,
      status: recorded ? "RECORDED" : "SCHEDULED",
      scheduledAt: recorded ? null : time.at,
      rescheduled: time.rescheduled,
      count: recorded?.count ?? r.ids.length,
      dailyCapped: recorded?.capped ?? 0,
    });
    const row = await tx.memberMessage.findUniqueOrThrow({ where: { id: created.id } });
    return { ok: true as const, message: view(row), rescheduled: time.rescheduled };
  }).catch((e) => {
    if (e instanceof NothingToSend) return fail("no_recipients");
    if (e instanceof RecordFailed) return fail(e.reason);
    throw e;
  });
}
// 하루 2건 한도로 모두 빠지면 아무것도 기록하지 않고 되돌린다
class NothingToSend extends Error {}
class RecordFailed extends Error {
  constructor(readonly reason: "too_many_recipients" | "opt_out_missing") {
    super(reason);
  }
}

// 예약 수정: 제목·문구·채널·보내는 시각만(종류·대상은 고정). 예약일 때만.
export async function updateMessage(db: PrismaClient, ctx: TenantContext, id: string, raw: Record<string, unknown>) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(id)) return fail("not_found");
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const [cur] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MemberMessage" WHERE "id" = ${id}::uuid AND "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    if (!cur) return fail("not_found");
    const m = await tx.memberMessage.findUniqueOrThrow({ where: { id } });
    if (m.status !== "SCHEDULED") return fail("invalid_transition");
    const parsed = parseMessage({ ...raw, kind: m.kind, target: { type: m.targetType, ...(m.targetParams as object) }, sendMode: "SCHEDULE" });
    if (!parsed.ok) return fail(parsed.reason);
    const v = parsed.v;
    const now = await clockNow(tx);
    const time = decideTime(v, now);
    if (!time.ok) return fail(time.reason, time.suggestedAt ? { suggestedAt: time.suggestedAt } : {});
    const rendered = renderBody(m.kind, await shopNameOf(tx, ctx.sellerId), v.body);
    if (m.kind === "AD" && !adTextOk(rendered)) return fail("opt_out_missing");
    const next = await tx.memberMessage.update({ where: { id }, data: { title: v.title, channel: v.channel, body: v.body, renderedBody: rendered, scheduledAt: time.at, updatedAt: now } });
    await audit(tx, ctx, "member_message.update", id, { title: m.title, body: m.body, scheduledAt: m.scheduledAt, channel: m.channel }, { title: v.title, renderedBody: rendered, scheduledAt: time.at, channel: v.channel });
    return { ok: true as const, message: view(next) };
  });
}

export async function cancelMessage(db: PrismaClient, ctx: TenantContext, id: string) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(id)) return fail("not_found");
  return db.$transaction(async (tx) => {
    const now = await clockNow(tx);
    // 시각이 되어 기록으로 바뀐 것과 겹치지 않게 조건부로 바꾼다
    const done = await tx.memberMessage.updateMany({ where: { id, sellerId: ctx.sellerId, status: "SCHEDULED" }, data: { status: "CANCELLED", updatedAt: now } });
    if (done.count !== 1) return fail((await tx.memberMessage.count({ where: { id, sellerId: ctx.sellerId } })) === 0 ? "not_found" : "invalid_transition");
    await audit(tx, ctx, "member_message.cancel", id, { status: "SCHEDULED" }, { status: "CANCELLED" });
    return { ok: true as const };
  });
}

// 정기 작업: 시각이 된 예약을 기록으로 바꾼다(쇼핑몰별 lock → 발송 행 잠금 → 대상 다시 계산). 하루 2건 한도로 모두 빠져도 기록(받는 사람 0명)으로 닫는다.
export async function processDueMemberMessages(db: PrismaClient, now = new Date(), limit = 100): Promise<number> {
  const due = await db.memberMessage.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now } }, orderBy: [{ scheduledAt: "asc" }, { id: "asc" }], take: limit, select: { id: true, sellerId: true } });
  let done = 0;
  for (const d of due) {
    done += await db.$transaction(async (tx) => {
      await lockSeller(tx, d.sellerId);
      const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MemberMessage" WHERE "id" = ${d.id}::uuid AND "status" = 'SCHEDULED' FOR UPDATE`;
      if (!row) return 0;
      const m = await tx.memberMessage.findUniqueOrThrow({ where: { id: d.id } });
      const rec = await record(tx, m, now);
      if (!rec.ok && rec.reason === "opt_out_missing") {
        // 수신거부 문구가 빠진 광고성 예약은 기록하지 않고 취소한다
        await tx.memberMessage.update({ where: { id: d.id }, data: { status: "CANCELLED", updatedAt: now } });
        await writeAudit(tx, { actorType: "SYSTEM", actorId: null, sellerId: d.sellerId, action: "member_message.cancel", targetType: "MemberMessage", targetId: d.id, after: { status: "CANCELLED", reason: "opt_out_missing" } });
        return 1;
      }
      if (!rec.ok) {
        await tx.memberMessage.update({ where: { id: d.id }, data: { status: "RECORDED", recordedAt: now, recipientCount: 0, updatedAt: now } });
        return 1;
      }
      await writeAudit(tx, { actorType: "SYSTEM", actorId: null, sellerId: d.sellerId, action: "member_message.record", targetType: "MemberMessage", targetId: d.id, after: { count: rec.count, dailyCapped: rec.capped } });
      return 1;
    });
  }
  return done;
}

// ───────────── 조회 ─────────────

const CHANNEL_LABEL = { ALIMTALK_SMS: "알림톡(실패 시 문자)", ALIMTALK: "알림톡", MAIL: "메일" } as const;
function view(m: MemberMessage) {
  return {
    id: m.id,
    title: m.title,
    kind: m.kind,
    channel: m.channel,
    channelLabel: CHANNEL_LABEL[m.channel],
    body: m.body,
    renderedBody: m.renderedBody,
    targetType: m.targetType,
    targetParams: m.targetParams,
    status: m.status,
    scheduledAt: m.scheduledAt,
    recordedAt: m.recordedAt,
    estimatedCount: m.estimatedCount,
    recipientCount: m.recipientCount,
    skippedDailyCap: m.skippedDailyCap,
    createdAt: m.createdAt,
  };
}
export type MessageView = ReturnType<typeof view>;

const PAGE = 30;

export async function listMessages(db: PrismaClient, ctx: TenantContext, q: { cursor?: unknown } = {}) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  let after: Prisma.MemberMessageWhereInput = {};
  if (typeof q.cursor === "string" && isUuid(q.cursor)) {
    const c = await db.memberMessage.findFirst({ where: { id: q.cursor, sellerId: ctx.sellerId }, select: { id: true, createdAt: true } });
    if (c) after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
  }
  const rows = await db.memberMessage.findMany({ where: { sellerId: ctx.sellerId, ...after }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PAGE + 1 });
  const page = rows.slice(0, PAGE);
  return { messages: page.map(view), nextCursor: rows.length > PAGE ? page[page.length - 1].id : null, summary: await summaryOf(db, ctx.sellerId) };
}

// 요약: 동의 회원, 이번 달(KST) 기록 건수·채널별, 기록 뒤 24시간 안 결제 주문, 최근 30일 수신 철회
async function summaryOf(db: PrismaClient, sellerId: string) {
  const now = await clockNow(db);
  const monthStart = kstMonthStart(now);
  const [active, consented, withdrawn30, byChannel, orders] = await Promise.all([
    db.buyerMember.count({ where: { sellerId, status: "ACTIVE", deletedAt: null } }),
    db.buyerMember.count({ where: { sellerId, status: "ACTIVE", deletedAt: null, marketingConsentAt: { not: null } } }),
    db.buyerMember.count({ where: { sellerId, status: "ACTIVE", deletedAt: null, marketingWithdrawnAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } } }),
    db.memberMessage.groupBy({ by: ["channel"], where: { sellerId, status: "RECORDED", recordedAt: { gte: monthStart } }, _sum: { recipientCount: true } }),
    db.$queryRaw<{ cnt: bigint; amount: bigint }[]>`
      SELECT count(*) AS "cnt", coalesce(sum(t."amount"), 0) AS "amount"
      FROM (
        SELECT DISTINCT o."id", o."totalAmount" - coalesce(o."refundAmount", 0) AS "amount"
        FROM "MemberMessage" m
        JOIN "MemberMessageRecipient" r ON r."messageId" = m."id"
        JOIN "Order" o ON o."buyerMemberId" = r."buyerMemberId" AND o."sellerId" = m."sellerId" AND o."status" = 'PAID'
          AND o."paidAt" >= m."recordedAt" AND o."paidAt" < m."recordedAt" + interval '24 hours'
        WHERE m."sellerId" = ${sellerId}::uuid AND m."status" = 'RECORDED' AND m."recordedAt" >= ${monthStart}
      ) t`,
  ]);
  const sent = (c: string) => byChannel.filter((b) => (c === "MAIL" ? b.channel === "MAIL" : b.channel !== "MAIL")).reduce((n, b) => n + (b._sum.recipientCount ?? 0), 0);
  const alimtalk = sent("ALIMTALK");
  const mail = sent("MAIL");
  return {
    consented,
    activeMembers: active,
    consentedPercent: active === 0 ? null : Math.round((consented / active) * 100),
    monthRecorded: alimtalk + mail,
    monthAlimtalk: alimtalk,
    monthMail: mail,
    orders24h: Number(orders[0]?.cnt ?? 0),
    orders24hAmount: Number(orders[0]?.amount ?? 0),
    withdrawn30,
    withdrawn30Percent: active === 0 ? null : Math.round((withdrawn30 / (active + withdrawn30)) * 1000) / 10,
  };
}

// 상세: 기록 뒤 24시간 안에 받는 사람이 결제한 주문(실제 DB 값). 열람·클릭 집계는 실제 발송 채널이 생기기 전에는 없다.
export async function getMessage(db: PrismaClient, ctx: TenantContext, id: string) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  if (!isUuid(id)) return null;
  const m = await db.memberMessage.findFirst({ where: { id, sellerId: ctx.sellerId } });
  if (!m) return null;
  let orders24h = null as { count: number; amount: number } | null;
  if (m.status === "RECORDED" && m.recordedAt) {
    const rows = await db.$queryRaw<{ cnt: bigint; amount: bigint }[]>`
      SELECT count(*) AS "cnt", coalesce(sum(o."totalAmount" - coalesce(o."refundAmount", 0)), 0) AS "amount"
      FROM "Order" o
      WHERE o."sellerId" = ${ctx.sellerId}::uuid AND o."status" = 'PAID' AND o."paidAt" >= ${m.recordedAt} AND o."paidAt" < ${new Date(m.recordedAt.getTime() + 86_400_000)}
        AND o."buyerMemberId" IN (SELECT r."buyerMemberId" FROM "MemberMessageRecipient" r WHERE r."messageId" = ${id}::uuid)`;
    orders24h = { count: Number(rows[0].cnt), amount: Number(rows[0].amount) };
  }
  return { ...view(m), orders24h, reaction: null as null };
}

// 탈퇴 때: 그 회원이 받은 발송 기록(받는 사람 행)을 지운다(발송 건 자체는 남고 받는 사람 수 요약만 남는다)
export async function deleteMemberMessageData(tx: Tx, scope: { sellerId: string; buyerMemberId: string }) {
  await tx.memberMessageRecipient.deleteMany({ where: scope });
}
