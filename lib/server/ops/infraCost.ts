import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { connectionWarnings, listConnections } from "./connections";
import { infraSignals, measureInfra } from "./infra";

// 인프라 비용(MA-120, 대표님 지시 2026-10-06). 1단계: 마스터가 입력한 단가 × 우리가 센 사용량 = 「추정」.
// 2단계(카카오클라우드 청구 조회로 「실제」)는 API 키 발급 뒤라 actual은 항상 null(not_connected)이다.

// 단가 키. 원 단위 정수(결제 수수료율만 % 소수 둘째 자리까지). 입력하지 않은 키는 「단가 없음」으로 추정에서 뺀다.
export const WON_PRICE_KEYS = ["serverMonthlyWon", "diskMonthlyWon", "publicIpMonthlyWon", "storageWonPerGbMonth", "trafficWonPerGb", "mailWonEach", "smsWonEach", "alimtalkWonEach"] as const;
export const PRICE_KEYS = [...WON_PRICE_KEYS, "pgFeeRatePct"] as const;
export type PriceKey = (typeof PRICE_KEYS)[number];
export type Prices = Partial<Record<PriceKey, number>>;

const WON_MAX = 100_000_000;
const KST_MS = 9 * 3_600_000;

const validPrice = (k: PriceKey, v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && (k === "pgFeeRatePct" ? v <= 100 && Math.round(v * 100) === v * 100 : Number.isInteger(v) && v <= WON_MAX);

const readPrices = (raw: Prisma.JsonValue | undefined): Prices => {
  const out: Prices = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const k of PRICE_KEYS) if (validPrice(k, raw[k])) out[k] = raw[k] as number;
  return out;
};

// 단가 입력(최고관리자만). 본문 prices는 바꿀 키만 담고(null이면 지움), expectedVersion이 다르면 거절(다른 사람이 먼저 바꿈).
// 변경 전후는 로그 추적(admin.infra.price_update)에 남긴다. 한 키라도 틀리면 전체 거절.
export async function updateInfraPrices(
  db: PrismaClient,
  admin: AdminSessionContext,
  input: { prices?: unknown; expectedVersion?: unknown },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  if (!adminCan(admin.admin.role, "infra.manage")) throw forbidden();
  const patch = input.prices;
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || typeof input.expectedVersion !== "number") return { ok: false as const, reason: "invalid_input" as const };
  const entries = Object.entries(patch as Record<string, unknown>);
  if (entries.length === 0) return { ok: false as const, reason: "invalid_input" as const };
  for (const [k, v] of entries) {
    if (!(PRICE_KEYS as readonly string[]).includes(k)) return { ok: false as const, reason: "invalid_price" as const };
    if (v !== null && !validPrice(k as PriceKey, v)) return { ok: false as const, reason: "invalid_price" as const };
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "InfraPriceSetting" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING`;
    await tx.$queryRaw`SELECT "id" FROM "InfraPriceSetting" WHERE "id" = 1 FOR UPDATE`;
    const cur = await tx.infraPriceSetting.findUniqueOrThrow({ where: { id: 1 } });
    if (cur.version !== input.expectedVersion) return { ok: false as const, reason: "version_conflict" as const };
    const before = readPrices(cur.prices);
    const after: Prices = { ...before };
    for (const [k, v] of entries) {
      if (v === null) delete after[k as PriceKey];
      else after[k as PriceKey] = v as number;
    }
    const row = await tx.infraPriceSetting.update({ where: { id: 1 }, data: { prices: after, version: { increment: 1 }, updatedByAdminId: admin.admin.id } });
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.infra.price_update", targetType: "InfraPriceSetting", targetId: "1", before, after, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const, prices: after, version: row.version };
  });
}

type ItemStatus = "estimated" | "no_price" | "not_measured";
type CostItem = {
  key: string;
  kind: "fixed" | "usage";
  status: ItemStatus;
  unitPrice: number | null;
  usage: { value: number; unit: string } | null;
  accruedWon: number | null;
  projectedWon: number | null;
};
type LimitedItem = { key: string; usedWon: number; limitWon: number; stopped: boolean; stoppedAt: string | null };

// 이번 달(KST) 경과 비율. 월초 몇 시간으로 월말 예상이 부풀지 않게 최소 1일로 본다.
function monthClock(now: Date) {
  const k = new Date(now.getTime() + KST_MS);
  const y = k.getUTCFullYear();
  const m = k.getUTCMonth();
  const startUtc = new Date(Date.UTC(y, m, 1) - KST_MS);
  const endUtc = new Date(Date.UTC(y, m + 1, 1) - KST_MS);
  const days = (endUtc.getTime() - startUtc.getTime()) / 86_400_000;
  const elapsedDays = (now.getTime() - startUtc.getTime()) / 86_400_000;
  return { period: `${y}-${String(m + 1).padStart(2, "0")}`, startUtc, endUtc, fraction: Math.min(Math.max(elapsedDays, 1), days) / days, rawFraction: elapsedDays / days };
}

// 이번 달 비용 추정. 고정비(서버·디스크·공인 IP)는 월 단가를 경과 비율만큼 누적하고 월말 예상은 월 단가 그대로,
// 사용량 비용(메일 건수·결제 수수료)은 누적 사용량 × 단가이고 월말 예상은 경과 비율로 늘린다. 저장소·트래픽·문자·알림톡은 아직 못 세서 not_measured.
// 한도 기능(월 1만 원: 도우미·외부 API)은 사용액·한도·정지 상태를 limited로 따로 낸다(요금 합계에도 사용액을 넣는다).
export async function infraCost(db: PrismaClient, admin: AdminSessionContext, opts: { now?: Date } = {}) {
  if (!adminCan(admin.admin.role, "infra.manage")) throw forbidden();
  const now = opts.now ?? new Date();
  const clock = monthClock(now);
  const setting = await db.infraPriceSetting.findUnique({ where: { id: 1 } });
  const prices = readPrices(setting?.prices);

  const [mail, pay, assistantUse, assistantSetting, apiUse] = await Promise.all([
    db.mailDelivery.count({ where: { status: "SENT", createdAt: { gte: clock.startUtc, lt: clock.endUtc } } }),
    db.$queryRaw<{ net: bigint }[]>`
      SELECT COALESCE(SUM("amount" - "cancelledAmount"), 0)::bigint AS net FROM "Payment"
      WHERE "status" IN ('PAID', 'PARTIAL_CANCELLED') AND "approvedAt" >= ${clock.startUtc} AND "approvedAt" < ${clock.endUtc}`,
    db.assistantMonthUsage.findUnique({ where: { month: clock.period } }),
    db.assistantSetting.findUnique({ where: { id: 1 } }),
    db.externalApiUsage.findMany({ where: { period: clock.period }, orderBy: { provider: "asc" } }),
  ]);
  const r = (n: number) => Math.round(n);

  const fixed = (key: string, price: PriceKey): CostItem => {
    const p = prices[price];
    return p === undefined
      ? { key, kind: "fixed", status: "no_price", unitPrice: null, usage: null, accruedWon: null, projectedWon: null }
      : { key, kind: "fixed", status: "estimated", unitPrice: p, usage: null, accruedWon: r(p * clock.rawFraction), projectedWon: p };
  };
  const usage = (key: string, price: PriceKey, value: number, unit: string, charge: (p: number) => number): CostItem => {
    const p = prices[price];
    if (p === undefined) return { key, kind: "usage", status: "no_price", unitPrice: null, usage: { value, unit }, accruedWon: null, projectedWon: null };
    const accrued = charge(p);
    return { key, kind: "usage", status: "estimated", unitPrice: p, usage: { value, unit }, accruedWon: r(accrued), projectedWon: r(accrued / clock.fraction) };
  };
  const notMeasured = (key: string, price: PriceKey): CostItem => ({ key, kind: "usage", status: "not_measured", unitPrice: prices[price] ?? null, usage: null, accruedWon: null, projectedWon: null });

  const net = Number(pay[0].net);
  const items: CostItem[] = [
    fixed("server", "serverMonthlyWon"),
    fixed("disk", "diskMonthlyWon"),
    fixed("publicIp", "publicIpMonthlyWon"),
    notMeasured("storage", "storageWonPerGbMonth"),
    notMeasured("traffic", "trafficWonPerGb"),
    usage("mail", "mailWonEach", mail, "count", (p) => p * mail),
    notMeasured("sms", "smsWonEach"),
    notMeasured("alimtalk", "alimtalkWonEach"),
    usage("pgFee", "pgFeeRatePct", net, "won", (p) => (net * p) / 100),
  ];

  // 한도 기능: 도우미(AssistantMonthUsage, 1/1000원)와 외부 API 공급자별 사용량(ExternalApiUsage)
  const limited: LimitedItem[] = [];
  const budgetWon = assistantSetting?.monthlyBudgetWon ?? 10_000;
  const assistantUsed = Math.ceil((assistantUse?.usedMilliWon ?? 0) / 1000);
  limited.push({ key: "assistant", usedWon: assistantUsed, limitWon: budgetWon, stopped: assistantUsed >= budgetWon, stoppedAt: null });
  for (const u of apiUse) limited.push({ key: `externalApi:${u.provider}`, usedWon: u.usedWon, limitWon: u.limitWon, stopped: u.stoppedAt !== null || u.usedWon >= u.limitWon, stoppedAt: u.stoppedAt?.toISOString() ?? null });

  const sum = (f: (i: CostItem) => number | null) => items.reduce((a, i) => a + (f(i) ?? 0), 0);
  const limitedUsed = limited.reduce((a, l) => a + l.usedWon, 0);
  const limitedProjected = limited.reduce((a, l) => a + Math.min(l.limitWon, r(l.usedWon / clock.fraction)), 0);
  return {
    checkedAt: now.toISOString(),
    month: clock.period,
    estimated: true as const,
    // 2단계(카카오클라우드 청구 조회)는 API 키 발급(대표님 조치) 뒤. 그때까지 실제 금액은 없다.
    actual: null,
    actualSource: "not_connected" as const,
    prices,
    priceVersion: setting?.version ?? 0,
    items,
    limited,
    totals: { accruedWon: sum((i) => i.accruedWon) + limitedUsed, projectedWon: sum((i) => i.projectedWon) + limitedProjected },
  };
}

// 마스터 홈 요약 카드(최고관리자만): 서버별 디스크·메모리 사용률, 이번 달 요금 누적·월말 예상(추정), 경고 개수.
// 서버는 이 서버의 지금 값과 같은 DB에 최근 3시간 안에 스냅숏을 남긴 다른 서버의 마지막 값. 경고 = 용량 기준 초과 신호 + 한도 정지 기능 수 + 외부 연결(만료 30일·7일 이내, 인증 오류).
export async function infraSummary(db: PrismaClient, admin: AdminSessionContext, opts: { now?: Date } = {}) {
  if (!adminCan(admin.admin.role, "infra.manage")) throw forbidden();
  const now = opts.now ?? new Date();
  const [m, cost, conns, others] = await Promise.all([
    measureInfra(db, now),
    infraCost(db, admin, { now }),
    listConnections(db, admin, { now }),
    db.$queryRaw<{ instance: string; takenAt: Date; diskTotalBytes: bigint | null; diskUsedBytes: bigint | null; memTotalBytes: bigint | null; memUsedBytes: bigint | null }[]>`
      SELECT DISTINCT ON ("instance") "instance", "takenAt", "diskTotalBytes", "diskUsedBytes", "memTotalBytes", "memUsedBytes"
      FROM "InfraSnapshot" WHERE "takenAt" >= ${new Date(now.getTime() - 3 * 3_600_000)} ORDER BY "instance", "takenAt" DESC`,
  ]);
  const pct = (u: number | null, t: number | null) => (u !== null && t ? Math.round((u / t) * 1000) / 10 : null);
  const n = (b: bigint | null) => (b === null ? null : Number(b));
  const servers = [
    { instance: m.instance, takenAt: m.takenAt.toISOString(), diskPct: pct(m.diskUsedBytes, m.diskTotalBytes), memoryPct: pct(m.memUsedBytes, m.memTotalBytes) },
    ...others.filter((o) => o.instance !== m.instance).map((o) => ({ instance: o.instance, takenAt: o.takenAt.toISOString(), diskPct: pct(n(o.diskUsedBytes), n(o.diskTotalBytes)), memoryPct: pct(n(o.memUsedBytes), n(o.memTotalBytes)) })),
  ];
  const capacity = infraSignals(m).length;
  const limitStopped = cost.limited.filter((l) => l.stopped).length;
  const cw = connectionWarnings(conns.connections);
  return {
    checkedAt: now.toISOString(),
    servers,
    cost: { month: cost.month, estimated: true as const, accruedWon: cost.totals.accruedWon, projectedWon: cost.totals.projectedWon },
    warnings: { capacity, limitStopped, ...cw, total: capacity + limitStopped + cw.expiring30 + cw.expiring7 + cw.authError },
  };
}
