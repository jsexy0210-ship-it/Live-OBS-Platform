import type { PrismaClient, PaymentMethod, RevokeMode, RewardEarnTiming } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { decodeCursor, encodeCursor } from "../orders/read";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { earnQuote, type RewardRates } from "./earn";
import { DEFAULT_EARN_TIMING, EARN_TIMINGS } from "./policy";

// 적립 정책(SA-031, MEMBER_POINTS). 등급별 적립률(카드·무통장)·지급 시점·취소/환불 회수 방식·인기 카드 1위 보너스를 읽고 저장한다.
// - 저장은 보낸 항목만 바꾼다(부분 저장). 바꾼 항목은 한 건의 로그 추적(reward_policy.update)과 정책 변경 이력에 항목별로 남는다.
// - 적립률은 0~10%, 소수 첫째 자리까지. 등급은 이 쇼핑몰 것만. 바뀐 적립률은 저장 뒤 결제되는 주문부터(이미 지급한 적립금은 그대로).
// - 회수 방식은 AUTO(자동 회수, 잔액이 모자라면 실패로 기록)·MANUAL(원장에서 수동 처리). 잔액은 0 아래로 내려갈 수 없어 「마이너스 허용」은 없다.
// - 같은 쇼핑몰의 동시 저장은 잠금으로 한 줄로 세운다(JSON 적립률이 서로 덮이지 않게).
export const RATE_MAX = 10;
export const RANKING_BONUS_MAX = 1_000_000;
export const REVOKE_MODES = ["AUTO", "MANUAL"] as const satisfies readonly RevokeMode[];

export const REWARD_POLICY_MESSAGES = {
  invalid_reward_policy: "저장할 값을 확인해 주십시오",
  reward_rate_out_of_range: "적립률은 0~10% 사이로 입력해 주십시오",
  reward_rate_unit: "적립률은 소수점 1자리까지 입력해 주십시오",
  reward_grade_not_found: "등급을 찾을 수 없습니다",
  reward_ranking_bonus_invalid: "인기 카드 1위 보너스 금액을 확인해 주십시오",
} as const;
export type RewardPolicyFailure = keyof typeof REWARD_POLICY_MESSAGES;
export const REWARD_POLICY_STATUS = { invalid_reward_policy: 400, reward_rate_out_of_range: 400, reward_rate_unit: 400, reward_grade_not_found: 404, reward_ranking_bonus_invalid: 400 } as const;

type Rates = RewardRates;
const asRates = (v: unknown): Rates => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rates) : {});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export type Change =
  | { kind: "rate"; gradeId: string; gradeName: string; method: "card" | "bankTransfer"; before: number | null; after: number | null }
  | { kind: "earnTiming"; before: RewardEarnTiming; after: RewardEarnTiming }
  | { kind: "revokeMode"; before: RevokeMode; after: RevokeMode }
  | { kind: "rankingBonus"; before: { enabled: boolean; amount: number }; after: { enabled: boolean; amount: number } };

async function readState(db: Pick<PrismaClient, "rewardPolicy" | "memberGrade">, sellerId: string) {
  const [p, grades] = await Promise.all([
    db.rewardPolicy.findUnique({ where: { sellerId }, select: { rates: true, earnTiming: true, revokeMode: true, rankingBonusEnabled: true, rankingBonusAmount: true, livePayoutEnabled: true, updatedAt: true } }),
    db.memberGrade.findMany({ where: { sellerId }, orderBy: { sortOrder: "asc" }, select: { id: true, displayName: true, systemKey: true, minAmount: true, sortOrder: true, _count: { select: { members: { where: { deletedAt: null } } } } } }),
  ]);
  const rates = asRates(p?.rates);
  return {
    configured: !!p,
    earnTiming: p?.earnTiming ?? DEFAULT_EARN_TIMING,
    revokeMode: p?.revokeMode ?? ("AUTO" as RevokeMode),
    rankingBonus: { enabled: p?.rankingBonusEnabled ?? false, amount: p?.rankingBonusAmount ?? 0 },
    livePayoutEnabled: p?.livePayoutEnabled ?? false,
    updatedAt: p?.updatedAt ?? null,
    rates,
    grades: grades.map((g) => ({ id: g.id, name: g.displayName, systemKey: g.systemKey, minAmount: g.minAmount, memberCount: g._count.members, card: rates[g.id]?.card ?? null, bankTransfer: rates[g.id]?.bankTransfer ?? null })),
  };
}

// 조회: { configured(저장된 정책이 있는가, 없으면 「정책 없음」 초기 상태), earnTiming, revokeMode, rankingBonus, livePayoutEnabled, grades[{id,name,systemKey,minAmount,memberCount,card,bankTransfer}] }
export async function readRewardPolicy(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const { rates: _rates, ...rest } = await readState(db, ctx.sellerId);
  return rest;
}

type Parsed = { earnTiming?: RewardEarnTiming; revokeMode?: RevokeMode; rankingBonus?: { enabled: boolean; amount: number }; rates?: Record<string, { card?: number | null; bankTransfer?: number | null }> };

function parseRate(v: unknown): number | null | RewardPolicyFailure {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return "invalid_reward_policy";
  if (v < 0 || v > RATE_MAX) return "reward_rate_out_of_range";
  if (Math.abs(Math.round(v * 10) - v * 10) > 1e-9) return "reward_rate_unit";
  return Math.round(v * 10) / 10;
}

function parse(raw: unknown): { ok: true; value: Parsed } | { ok: false; reason: RewardPolicyFailure } {
  if (!isObj(raw)) return { ok: false, reason: "invalid_reward_policy" };
  const known = ["earnTiming", "revokeMode", "rankingBonus", "rates"];
  if (Object.keys(raw).some((k) => !known.includes(k)) || Object.keys(raw).length === 0) return { ok: false, reason: "invalid_reward_policy" };
  const out: Parsed = {};
  if (raw.earnTiming !== undefined) {
    if (!EARN_TIMINGS.includes(raw.earnTiming as RewardEarnTiming)) return { ok: false, reason: "invalid_reward_policy" };
    out.earnTiming = raw.earnTiming as RewardEarnTiming;
  }
  if (raw.revokeMode !== undefined) {
    if (!REVOKE_MODES.includes(raw.revokeMode as RevokeMode)) return { ok: false, reason: "invalid_reward_policy" };
    out.revokeMode = raw.revokeMode as RevokeMode;
  }
  if (raw.rankingBonus !== undefined) {
    const r = raw.rankingBonus;
    if (!isObj(r) || typeof r.enabled !== "boolean") return { ok: false, reason: "invalid_reward_policy" };
    const amount = r.amount === undefined ? 0 : r.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > RANKING_BONUS_MAX || (r.enabled && amount < 1)) return { ok: false, reason: "reward_ranking_bonus_invalid" };
    out.rankingBonus = { enabled: r.enabled, amount };
  }
  if (raw.rates !== undefined) {
    if (!isObj(raw.rates)) return { ok: false, reason: "invalid_reward_policy" };
    out.rates = {};
    for (const [gradeId, v] of Object.entries(raw.rates)) {
      if (!UUID_RE.test(gradeId) || !isObj(v) || Object.keys(v).some((k) => k !== "card" && k !== "bankTransfer") || Object.keys(v).length === 0) return { ok: false, reason: "invalid_reward_policy" };
      const e: { card?: number | null; bankTransfer?: number | null } = {};
      for (const m of ["card", "bankTransfer"] as const) {
        if (v[m] === undefined) continue;
        const r = parseRate(v[m]);
        if (typeof r === "string") return { ok: false, reason: r };
        e[m] = r;
      }
      out.rates[gradeId] = e;
    }
  }
  return { ok: true, value: out };
}

export async function updateRewardPolicy(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const parsed = parse(raw);
  if (!parsed.ok) return { ok: false as const, reason: parsed.reason };
  const want = parsed.value;
  const sellerId = ctx.sellerId;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reward_policy:${sellerId}`}))`;
    const cur = await readState(tx, sellerId);
    const gradeNames = new Map(cur.grades.map((g) => [g.id, g.name]));
    const nextRates: Rates = { ...cur.rates };
    const changes: Change[] = [];
    for (const [gradeId, e] of Object.entries(want.rates ?? {})) {
      if (!gradeNames.has(gradeId)) return { ok: false as const, reason: "reward_grade_not_found" as const };
      const entry = { ...(nextRates[gradeId] ?? {}) } as { card?: number; bankTransfer?: number };
      for (const m of ["card", "bankTransfer"] as const) {
        if (!(m in e)) continue;
        const before = entry[m] ?? null;
        const after = e[m] ?? null;
        if (before === after) continue;
        if (after === null) delete entry[m];
        else entry[m] = after;
        changes.push({ kind: "rate", gradeId, gradeName: gradeNames.get(gradeId)!, method: m, before, after });
      }
      if (Object.keys(entry).length === 0) delete nextRates[gradeId];
      else nextRates[gradeId] = entry;
    }
    if (want.earnTiming && want.earnTiming !== cur.earnTiming) changes.push({ kind: "earnTiming", before: cur.earnTiming, after: want.earnTiming });
    if (want.revokeMode && want.revokeMode !== cur.revokeMode) changes.push({ kind: "revokeMode", before: cur.revokeMode, after: want.revokeMode });
    if (want.rankingBonus && (want.rankingBonus.enabled !== cur.rankingBonus.enabled || want.rankingBonus.amount !== cur.rankingBonus.amount)) {
      changes.push({ kind: "rankingBonus", before: cur.rankingBonus, after: want.rankingBonus });
    }
    // 처음 저장이면 정책 행을 만든다. 바뀐 게 없으면 로그도 남기지 않는다.
    if (changes.length === 0 && cur.configured) return { ok: true as const, changed: false as const, policy: await stateOf(tx, sellerId) };
    const data = {
      rates: nextRates as object,
      ...(want.earnTiming ? { earnTiming: want.earnTiming } : {}),
      ...(want.revokeMode ? { revokeMode: want.revokeMode } : {}),
      ...(want.rankingBonus ? { rankingBonusEnabled: want.rankingBonus.enabled, rankingBonusAmount: want.rankingBonus.amount } : {}),
    };
    await tx.rewardPolicy.upsert({ where: { sellerId }, create: { sellerId, ...data }, update: data });
    if (changes.length) {
      await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId, action: "reward_policy.update", targetType: "Seller", targetId: sellerId, after: { changes } });
    }
    return { ok: true as const, changed: changes.length > 0, policy: await stateOf(tx, sellerId) };
  });
}

async function stateOf(db: Pick<PrismaClient, "rewardPolicy" | "memberGrade">, sellerId: string) {
  const { rates: _rates, ...rest } = await readState(db, sellerId);
  return rest;
}

// 변경 영향 미리보기: 예시 주문(금액·결제 수단·등급)에 지금 적립률과 바꾼 적립률을 각각 적용한 지급액. 아무것도 저장하지 않는다.
// 본문 { amount: 정수 원, paymentMethod: "CARD"|"BANK_TRANSFER", gradeId, rates?: 저장 본문의 rates 형식(없으면 지금과 같음) }
export async function previewRewardPolicy(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const b = isObj(raw) ? raw : {};
  const method = b.paymentMethod as PaymentMethod;
  if (typeof b.amount !== "number" || !Number.isInteger(b.amount) || b.amount < 0 || b.amount > 100_000_000 || (method !== "CARD" && method !== "BANK_TRANSFER") || typeof b.gradeId !== "string" || !UUID_RE.test(b.gradeId)) {
    return { ok: false as const, reason: "invalid_reward_policy" as const };
  }
  const parsed = parse({ rates: b.rates ?? {} });
  if (!parsed.ok) return { ok: false as const, reason: parsed.reason };
  const cur = await readState(db, ctx.sellerId);
  if (!cur.grades.some((g) => g.id === b.gradeId)) return { ok: false as const, reason: "reward_grade_not_found" as const };
  const next: Rates = { ...cur.rates };
  for (const [gid, e] of Object.entries(parsed.value.rates ?? {})) {
    const entry = { ...(next[gid] ?? {}) } as { card?: number; bankTransfer?: number };
    for (const m of ["card", "bankTransfer"] as const) {
      if (!(m in e)) continue;
      if (e[m] === null || e[m] === undefined) delete entry[m];
      else entry[m] = e[m]!;
    }
    next[gid] = entry;
  }
  const base = { earnStartsAt: null, gradeId: b.gradeId, paymentMethod: method, base: b.amount, now: new Date() };
  return { ok: true as const, current: earnQuote({ ...base, rates: cur.rates }), next: earnQuote({ ...base, rates: next }) };
}

// 정책 변경 이력: 최근 순, 한 번에 변경 한 건(여러 항목이 함께 바뀔 수 있음). 쿼리 cursor·limit(기본 20, 최대 100).
export const POLICY_HISTORY_DEFAULT = 20;
export const POLICY_HISTORY_MAX = 100;
export async function listRewardPolicyHistory(db: PrismaClient, ctx: TenantContext, query: { cursor?: string | null; limit?: string | null }) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const limit = query.limit == null || query.limit === "" ? POLICY_HISTORY_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, POLICY_HISTORY_MAX);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  const rows = await db.auditLog.findMany({
    where: {
      sellerId: ctx.sellerId,
      action: { in: ["reward_policy.update", "reward_policy.earn_timing"] },
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: { id: true, action: true, actorType: true, actorId: true, before: true, after: true, createdAt: true },
  });
  const page = rows.slice(0, take);
  const userIds = [...new Set(page.filter((r) => r.actorType === "SELLER_USER" && r.actorId).map((r) => r.actorId!))];
  const users = userIds.length ? await db.sellerUser.findMany({ where: { sellerId: ctx.sellerId, id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  const last = page[page.length - 1];
  return {
    ok: true as const,
    history: page.map((r) => {
      const a = (r.after ?? {}) as { changes?: Change[]; earnTiming?: RewardEarnTiming };
      const b = (r.before ?? {}) as { earnTiming?: RewardEarnTiming };
      const changes: Change[] = r.action === "reward_policy.earn_timing" && a.earnTiming && b.earnTiming ? [{ kind: "earnTiming", before: b.earnTiming, after: a.earnTiming }] : (a.changes ?? []);
      return { id: r.id, at: r.createdAt, actorName: r.actorId ? (names.get(r.actorId) ?? null) : null, changes };
    }),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
