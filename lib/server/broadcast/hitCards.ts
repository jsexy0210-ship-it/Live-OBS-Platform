import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { notifySellerChanged } from "../realtime/notify";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";
import { orderNoLabel } from "../orders/orderNoLabel";
import { formatCsv, guardText } from "../shop-bulk-io/csv";

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
export const HIT_PAGE_SIZE = 10;
export const GRADE_MAX = 12;
export const BULK_DELETE_MAX = 100;
// 등급 추천 값(SA-001-M4 HIT 기록 창·SA-053 목록). 화면의 「직접 입력」을 받으므로 등급은 자유 입력이고, 이 목록은 추천 값일 뿐이다. 비워 둘 수 있다.
export const HIT_GRADES = ["SAR", "SR", "UR", "SE", "SP", "AA"] as const;

export type HitRejection = "invalid_card_name" | "invalid_grade" | "invalid_note" | "invalid_nickname" | "invalid_queue_item" | "invalid_filter" | "invalid_ids";

// 파트너스 관리자 화면 문구(명사형·합니다체)
export const HIT_MESSAGES: Record<HitRejection, string> = {
  invalid_card_name: `카드 이름을 ${CARD_NAME_MAX}자 안에서 입력해 주십시오`,
  invalid_grade: `등급을 ${GRADE_MAX}자 안에서 입력해 주십시오`,
  invalid_note: `메모는 ${NOTE_MAX}자까지 입력할 수 있습니다`,
  invalid_nickname: `닉네임을 ${NICKNAME_MAX}자 안에서 입력해 주십시오`,
  invalid_queue_item: "주문대기 항목을 찾을 수 없습니다. 새로고침한 뒤 다시 시도해 주십시오",
  invalid_filter: "조회 조건을 다시 확인해 주십시오",
  invalid_ids: `지울 카드를 1~${BULK_DELETE_MAX}개 선택해 주십시오`,
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
  grade: true,
  note: true,
  nicknameSnapshot: true,
  createdAt: true,
  overlayShownAt: true,
  broadcastSession: { select: { id: true, title: true, status: true } },
  queueItem: { select: { id: true, productLabel: true, receivedAt: true, order: { select: { id: true, orderNo: true, createdAt: true } }, externalOrderId: true, externalOrder: { select: { connection: { select: { shopKey: true } } } } } },
} satisfies Prisma.HitCardSelect;
type CardRow = Prisma.HitCardGetPayload<{ select: typeof cardSelect }>;

const view = (r: CardRow) => ({
  id: r.id,
  cardName: r.cardName,
  grade: r.grade,
  note: r.note,
  nickname: r.nicknameSnapshot,
  broadcast: r.broadcastSession ? { id: r.broadcastSession.id, title: r.broadcastSession.title } : null,
  // 외부 쇼핑몰 주문에서 나온 HIT는 내부 주문이 없어 order가 null이다(닉네임·상품은 queueItem 기준)
  order: r.queueItem?.order ? { id: r.queueItem.order.id, orderNo: r.queueItem.order.orderNo, orderNoLabel: orderNoLabel(r.queueItem.order.createdAt, r.queueItem.order.orderNo), productLabel: r.queueItem.productLabel } : null,
  // 출처: 외부 쇼핑몰 주문에서 나온 카드면 EXTERNAL(externalShopName은 지금은 몰 ID). 직접 입력한 카드는 queueItem이 없어 null
  source: r.queueItem ? (r.queueItem.externalOrderId ? ("EXTERNAL" as const) : ("INTERNAL" as const)) : null,
  externalShopName: r.queueItem?.externalOrder?.connection.shopKey ?? null,
  // 주문대기 접수 시각(SA-053 「주문」 열 「14:12 접수」). 직접 입력한 카드는 null
  orderReceivedAt: r.queueItem?.receivedAt ?? null,
  createdAt: r.createdAt,
  // 방송 화면 노출(SA-053 「방송 화면」 열): shown=오버레이가 읽어 감(shownAt), pending=지금 방송 중이라 아직 안 나감, skipped=안 나가고 방송이 끝났거나 방송 없이 등록(노출 생략)
  overlay: r.overlayShownAt ? ({ status: "shown" as const, shownAt: r.overlayShownAt }) : { status: r.broadcastSession?.status === "LIVE" ? ("pending" as const) : ("skipped" as const), shownAt: null },
});

export type HitFilter = { broadcastId?: string | null; from?: string | null; to?: string | null; cursor?: string | null; grade?: string | null; offset?: string | null };
export const HIT_EXPORT_MAX = 5_000;

const OFFSET_MAX = 1_000_000;

function hitWhere(sellerId: string, f: HitFilter): Prisma.HitCardWhereInput | null {
  const where: Prisma.HitCardWhereInput = { sellerId };
  if (f.broadcastId) {
    if (!isUuid(f.broadcastId)) return null;
    where.broadcastSessionId = f.broadcastId;
  }
  if (f.grade) {
    const g = cleanText(f.grade, GRADE_MAX);
    if (!g) return null;
    where.grade = g;
  }
  const from = f.from ? kstStart(f.from) : null;
  const to = f.to ? kstStart(f.to) : null;
  if ((f.from && !from) || (f.to && !to) || (from && to && from > to)) return null;
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}) };
  return where;
}

export async function listHitCards(db: PrismaClient, ctx: TenantContext, f: HitFilter) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  const where = hitWhere(ctx.sellerId, f);
  if (!where) return { ok: false as const, reason: "invalid_filter" as const };
  // offset(쪽 번호 이동·끝 이동)을 주면 cursor보다 우선한다. 숫자가 아니거나 음수·너무 크면 invalid_filter
  let offset: number | null = null;
  if (f.offset !== undefined && f.offset !== null && f.offset !== "") {
    offset = /^\d+$/.test(f.offset) ? Number(f.offset) : -1;
    if (offset < 0 || offset > OFFSET_MAX) return { ok: false as const, reason: "invalid_filter" as const };
  }
  const at = offset === null && isUuid(f.cursor) ? await db.hitCard.findFirst({ where: { id: f.cursor, sellerId: ctx.sellerId }, select: { id: true, createdAt: true } }) : null;
  const [total, rows] = await Promise.all([db.hitCard.count({ where }), db.hitCard.findMany({
    where: at ? { AND: [where, { OR: [{ createdAt: { lt: at.createdAt } }, { createdAt: at.createdAt, id: { lt: at.id } }] }] } : where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(offset ? { skip: offset } : {}),
    take: HIT_PAGE_SIZE + 1,
    select: cardSelect,
  })]);
  const items = rows.slice(0, HIT_PAGE_SIZE).map(view);
  return { ok: true as const, value: { items, total, grades: [...HIT_GRADES], nextCursor: rows.length > HIT_PAGE_SIZE ? items[items.length - 1].id : null } };
}

// 판매자 행을 잠그고 liveVersion을 올린다(오버레이가 새 카드를 다시 읽게)
async function bump(tx: Tx, sellerId: string) {
  return (await tx.seller.update({ where: { id: sellerId }, data: { liveVersion: { increment: 1 } }, select: { liveVersion: true } })).liveVersion;
}

// 등록. 본문: { cardName(60자), grade?(12자 이내 자유 입력·추천 SAR·SR·UR·SE·SP·AA, 비우면 없음), note?(200자), queueItemId? | nickname?(30자, queueItemId가 없을 때 필수) }
export async function createHitCard(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const b = obj(raw);
  const cardName = cleanText(b.cardName, CARD_NAME_MAX, "memo");
  if (!cardName) return { ok: false as const, reason: "invalid_card_name" as const };
  const grade = b.grade === undefined || b.grade === null || b.grade === "" ? null : (cleanText(b.grade, GRADE_MAX) ?? undefined);
  if (grade === undefined) return { ok: false as const, reason: "invalid_grade" as const };
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
        buyerMemberId: item?.order?.buyerMemberId ?? null,
        nicknameSnapshot: item?.nicknameSnapshot ?? typedNickname!,
        cardName,
        grade,
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
      after: { cardName, grade, note, queueItemId: item?.id ?? null, broadcastSessionId: row.broadcastSession?.id ?? null },
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
      before: { cardName: before.cardName, grade: before.grade, note: before.note, queueItemId: before.queueItemId, broadcastSessionId: before.broadcastSessionId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return v;
  });
  await notifySellerChanged(db, ctx.sellerId, version);
}

const pad = (n: number) => String(n).padStart(2, "0");
const kstText = (d: Date) => {
  const t = new Date(d.getTime() + 9 * 3_600_000);
  return `${t.getUTCFullYear()}.${pad(t.getUTCMonth() + 1)}.${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};

// 내보내기(SA-053 「내보내기」, CSV): 지금 방송·등급·기간 조건에 맞는 카드 전체(쪽과 상관없이 최신순, 최대 5,000건). BROADCAST_RUN 권한.
export async function exportHitCards(db: PrismaClient, ctx: TenantContext, f: HitFilter, meta: AuditMeta = {}) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  const where = hitWhere(ctx.sellerId, f);
  if (!where) return { ok: false as const, reason: "invalid_filter" as const };
  const rows = await db.hitCard.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: HIT_EXPORT_MAX + 1, select: cardSelect });
  const truncated = rows.length > HIT_EXPORT_MAX;
  const items = rows.slice(0, HIT_EXPORT_MAX).map(view);
  const csv = formatCsv([
    ["카드", "일시", "등급", "구매자", "주문 접수", "방송", "메모"],
    ...items.map((c) => [guardText(c.cardName), kstText(c.createdAt), guardText(c.grade ?? ""), guardText(c.nickname), c.orderReceivedAt ? kstText(c.orderReceivedAt) : "", guardText(c.broadcast?.title ?? ""), guardText(c.note ?? "")]),
  ]);
  await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "hit_card.export", targetType: "HitCard", after: { rows: items.length, truncated }, ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true as const, csv, truncated };
}

// 다시 연출(SA-053): 지금 방송의 카드만(오버레이는 지금 방송 카드만 보여 준다, 아니면 409 not_live). 노출 시각(overlayShownAt)을 새 시각으로 바꾸고 liveVersion으로 오버레이에 알린다(오버레이는 값이 바뀐 카드를 다시 보여 준다). 다른 판매자 카드는 404.
export async function replayHitCard(db: PrismaClient, ctx: TenantContext, id: string, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  if (!isUuid(id)) throw notFound();
  class NotLive extends Error {}
  const result = await db.$transaction(async (tx) => {
    const version = await bump(tx, ctx.sellerId);
    const card = await tx.hitCard.findFirst({ where: { id, sellerId: ctx.sellerId }, select: { id: true, broadcastSession: { select: { status: true } } } });
    if (!card) throw notFound();
    // 거절이면 던져서 앞에서 올린 liveVersion도 되돌린다(바뀐 게 없는데 버전만 오르지 않게)
    if (card.broadcastSession?.status !== "LIVE") throw new NotLive();
    await tx.hitCard.update({ where: { id }, data: { overlayShownAt: new Date() } });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "hit_card.replay", targetType: "HitCard", targetId: id, ip: meta.ip, userAgent: meta.userAgent });
    return version;
  }).catch((e) => {
    if (e instanceof NotLive) return null;
    throw e;
  });
  if (result === null) return { ok: false as const, reason: "not_live" as const };
  await notifySellerChanged(db, ctx.sellerId, result);
  return { ok: true as const };
}

// 선택 삭제(SA-053 「선택한 카드 지우기」): 한 번에 1~100장, 복구 없는 영구 삭제, 방송 화면에 나가 있는 카드도 지울 수 있다(이미 나간 연출에는 영향 없음, 오버레이는 다음 읽기부터 빠짐).
// 본문: { ids: string[] }. 형식이 틀리거나(배열 아님·0장·100장 초과·uuid 아님·중복) 비면 invalid_ids. 내 몰에 없는 id(다른 몰 카드 포함)는 없는 것으로 보고 missing으로만 센다.
// 하나도 지우지 못하면 liveVersion을 올리지 않는다. 지운 카드 정보는 감사 기록 하나에 모아 남긴다.
export async function deleteHitCards(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const ids = obj(raw).ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_DELETE_MAX || !ids.every(isUuid) || new Set(ids.map((i) => i.toLowerCase())).size !== ids.length) {
    return { ok: false as const, reason: "invalid_ids" as const };
  }
  class NothingDeleted extends Error {}
  const result = await db
    .$transaction(async (tx) => {
      const version = await bump(tx, ctx.sellerId);
      const cards = await tx.hitCard.findMany({ where: { sellerId: ctx.sellerId, id: { in: ids as string[] } }, select: { id: true, cardName: true, grade: true, broadcastSessionId: true } });
      if (cards.length === 0) throw new NothingDeleted();
      await tx.hitCard.deleteMany({ where: { sellerId: ctx.sellerId, id: { in: cards.map((c) => c.id) } } });
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: "hit_card.bulk_delete",
        targetType: "HitCard",
        before: { cards: cards.map((c) => ({ id: c.id, cardName: c.cardName, grade: c.grade, broadcastSessionId: c.broadcastSessionId })) },
        after: { requested: ids.length, deleted: cards.length },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { version, deleted: cards.length };
    })
    .catch((e) => {
      if (e instanceof NothingDeleted) return null;
      throw e;
    });
  if (result === null) return { ok: true as const, deleted: 0, missing: ids.length };
  await notifySellerChanged(db, ctx.sellerId, result.version);
  return { ok: true as const, deleted: result.deleted, missing: ids.length - result.deleted };
}
