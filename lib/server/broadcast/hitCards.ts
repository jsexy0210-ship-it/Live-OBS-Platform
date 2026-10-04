import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { notifySellerChanged } from "../realtime/notify";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// HIT 카드(SA-053 이력, 방송 대시보드 「HIT 카드 등록」). 규칙:
// - 조회는 대표자·「방송 진행」(BROADCAST_RUN) 직원(마스터 대리 조회 포함), 등록·해제는 BROADCAST_RUN 쓰기 권한.
// - 등록은 주문대기 항목(queueItemId)을 고르면 그 항목의 방송 닉네임·구매자로, 고르지 않으면 닉네임을 직접 받는다.
//   방송은 지금 방송(LIVE), 없으면 그 주문대기 항목의 방송, 둘 다 없으면 비운다. 오버레이는 지금 방송 카드를 최신순으로 보여 준다.
// - 등록·해제는 판매자 행의 liveVersion을 올리고 커밋 뒤 오버레이에 알린다(주문대기 변경과 같은 잠금 순서: 판매자 행 먼저).
// - 목록은 최신순, 방송·기간(KST 날짜) 필터, cursor(마지막 카드 id). 다른 판매자 카드·방송은 없는 것으로 본다.

type Tx = Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };

export const CARD_NAME_MAX = 60;
export const NOTE_MAX = 200;
export const NICKNAME_MAX = 30;
export const HIT_PAGE_SIZE = 50;

export type HitRejection = "invalid_card_name" | "invalid_note" | "invalid_nickname" | "invalid_queue_item" | "invalid_filter";

// 파트너스 관리자 화면 문구(명사형·합니다체)
export const HIT_MESSAGES: Record<HitRejection, string> = {
  invalid_card_name: `카드 이름을 ${CARD_NAME_MAX}자 안에서 입력해 주십시오`,
  invalid_note: `메모는 ${NOTE_MAX}자까지 입력할 수 있습니다`,
  invalid_nickname: `닉네임을 ${NICKNAME_MAX}자 안에서 입력해 주십시오`,
  invalid_queue_item: "주문대기 항목을 찾을 수 없습니다. 새로고침한 뒤 다시 시도해 주십시오",
  invalid_filter: "조회 조건을 다시 확인해 주십시오",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

// KST 날짜(YYYY-MM-DD) → 그날 0시(KST). 잘못된 날짜는 null.
function kstStart(v: string): Date | null {
  if (!DATE.test(v)) return null;
  const d = new Date(`${v}T00:00:00+09:00`);
  // 2026-02-30처럼 넘치는 날짜는 다른 날로 바뀌므로 되돌려 같은지 본다
  return !Number.isNaN(d.getTime()) && new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10) === v ? d : null;
}

const cardSelect = {
  id: true,
  cardName: true,
  note: true,
  nicknameSnapshot: true,
  createdAt: true,
  broadcastSession: { select: { id: true, title: true } },
  queueItem: { select: { id: true, productLabel: true, order: { select: { id: true, orderNo: true } } } },
} satisfies Prisma.HitCardSelect;
type CardRow = Prisma.HitCardGetPayload<{ select: typeof cardSelect }>;

const view = (r: CardRow) => ({
  id: r.id,
  cardName: r.cardName,
  note: r.note,
  nickname: r.nicknameSnapshot,
  broadcast: r.broadcastSession ? { id: r.broadcastSession.id, title: r.broadcastSession.title } : null,
  order: r.queueItem ? { id: r.queueItem.order.id, orderNo: r.queueItem.order.orderNo, productLabel: r.queueItem.productLabel } : null,
  createdAt: r.createdAt,
});

export type HitFilter = { broadcastId?: string | null; from?: string | null; to?: string | null; cursor?: string | null };

export async function listHitCards(db: PrismaClient, ctx: TenantContext, f: HitFilter) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  const where: Prisma.HitCardWhereInput = { sellerId: ctx.sellerId };
  if (f.broadcastId) {
    if (!isUuid(f.broadcastId)) return { ok: false as const, reason: "invalid_filter" as const };
    where.broadcastSessionId = f.broadcastId;
  }
  const from = f.from ? kstStart(f.from) : null;
  const to = f.to ? kstStart(f.to) : null;
  if ((f.from && !from) || (f.to && !to) || (from && to && from > to)) return { ok: false as const, reason: "invalid_filter" as const };
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}) };
  const at = isUuid(f.cursor) ? await db.hitCard.findFirst({ where: { id: f.cursor, sellerId: ctx.sellerId }, select: { id: true, createdAt: true } }) : null;
  const rows = await db.hitCard.findMany({
    where: at ? { AND: [where, { OR: [{ createdAt: { lt: at.createdAt } }, { createdAt: at.createdAt, id: { lt: at.id } }] }] } : where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HIT_PAGE_SIZE + 1,
    select: cardSelect,
  });
  const items = rows.slice(0, HIT_PAGE_SIZE).map(view);
  return { ok: true as const, value: { items, nextCursor: rows.length > HIT_PAGE_SIZE ? items[items.length - 1].id : null } };
}

// 판매자 행을 잠그고 liveVersion을 올린다(오버레이가 새 카드를 다시 읽게)
async function bump(tx: Tx, sellerId: string) {
  return (await tx.seller.update({ where: { id: sellerId }, data: { liveVersion: { increment: 1 } }, select: { liveVersion: true } })).liveVersion;
}

// 등록. 본문: { cardName(60자), note?(200자), queueItemId? | nickname?(30자, queueItemId가 없을 때 필수) }
export async function createHitCard(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const b = obj(raw);
  const cardName = cleanText(b.cardName, CARD_NAME_MAX, "memo");
  if (!cardName) return { ok: false as const, reason: "invalid_card_name" as const };
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null && !(typeof b.note === "string" && b.note.trim() === "")) {
    note = cleanText(b.note, NOTE_MAX, "memo");
    if (!note) return { ok: false as const, reason: "invalid_note" as const };
  }
  const queueItemId = b.queueItemId === undefined || b.queueItemId === null ? null : b.queueItemId;
  if (queueItemId !== null && !isUuid(queueItemId)) return { ok: false as const, reason: "invalid_queue_item" as const };
  const typedNickname = queueItemId ? null : cleanText(b.nickname, NICKNAME_MAX);
  if (!queueItemId && !typedNickname) return { ok: false as const, reason: "invalid_nickname" as const };
  const result = await db.$transaction(async (tx) => {
    const version = await bump(tx, ctx.sellerId);
    const item = queueItemId
      ? await tx.queueItem.findFirst({ where: { id: queueItemId, sellerId: ctx.sellerId }, select: { id: true, nicknameSnapshot: true, broadcastSessionId: true, order: { select: { buyerMemberId: true } } } })
      : null;
    if (queueItemId && !item) return { ok: false as const, reason: "invalid_queue_item" as const };
    const live = await tx.broadcastSession.findFirst({ where: { sellerId: ctx.sellerId, status: "LIVE" }, select: { id: true } });
    const row = await tx.hitCard.create({
      data: {
        sellerId: ctx.sellerId,
        broadcastSessionId: live?.id ?? item?.broadcastSessionId ?? null,
        queueItemId: item?.id ?? null,
        buyerMemberId: item?.order.buyerMemberId ?? null,
        nicknameSnapshot: item?.nicknameSnapshot ?? typedNickname!,
        cardName,
        note,
        createdByUserId: ctx.actorType === "SELLER_USER" ? ctx.actorId : null,
      },
      select: cardSelect,
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "hit_card.create",
      targetType: "HitCard",
      targetId: row.id,
      after: { cardName, note, queueItemId: item?.id ?? null, broadcastSessionId: row.broadcastSession?.id ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, card: view(row), version };
  });
  if (result.ok) await notifySellerChanged(db, ctx.sellerId, result.version);
  return result;
}

// 해제(잘못 등록한 카드 지우기). 다른 판매자 카드는 404.
export async function deleteHitCard(db: PrismaClient, ctx: TenantContext, id: string, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  if (!isUuid(id)) throw notFound();
  const version = await db.$transaction(async (tx) => {
    const v = await bump(tx, ctx.sellerId);
    const before = await tx.hitCard.findFirst({ where: { id, sellerId: ctx.sellerId } });
    if (!before) throw notFound();
    await tx.hitCard.delete({ where: { id } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "hit_card.delete",
      targetType: "HitCard",
      targetId: id,
      before: { cardName: before.cardName, note: before.note, queueItemId: before.queueItemId, broadcastSessionId: before.broadcastSessionId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return v;
  });
  await notifySellerChanged(db, ctx.sellerId, version);
}
