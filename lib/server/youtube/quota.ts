import type { Prisma, PrismaClient } from "@prisma/client";

// 하루 할당량(무료 10,000단위, 프로젝트 전체 공유). 구글 할당량은 태평양 시각 자정에 초기화되므로 그 날짜로 센다.
// 대표님 지시(2026-10-05): 유료 전환·할당량 증설 없이 무료 할당량 안에서만 동작한다. 환경변수로는 한도를 낮출 수만 있다.
// - 호출 전에 단위를 먼저 예약한다(넘으면 호출하지 않음). 실패한 호출도 구글은 단위를 센다.
// - 채팅 수집(PR 2)은 전체의 95%까지만, 방송 상태 확인·연결은 100%까지. 80%를 넘으면 경고(sync.ts).
// - 판매자별 하루 상한(기본 3,000단위)은 판매자 한 명이 몫을 다 쓰지 않게 한다. 여러 판매자를 묶은 상태 확인은 전체에만 센다.
// - 403 quotaExceeded를 받으면 그날 전체를 다 쓴 것으로 표시한다(markQuotaExhausted).
type Db = PrismaClient | Prisma.TransactionClient;

export const QUOTA_ALL = "all";
export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_CHAT_RATIO = 0.95;

export const FREE_DAILY_QUOTA = 10_000;
export type QuotaLimits = { daily: number; perSeller: number };
const positiveInt = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
};
export function quotaLimits(env: Record<string, string | undefined> = process.env): QuotaLimits {
  const daily = Math.min(positiveInt(env.YOUTUBE_DAILY_QUOTA, FREE_DAILY_QUOTA), FREE_DAILY_QUOTA);
  return { daily, perSeller: Math.min(positiveInt(env.YOUTUBE_SELLER_DAILY_QUOTA, 3_000), daily) };
}

const PT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
export const quotaDay = (now: Date) => PT.format(now);

export type QuotaPurpose = "status" | "link" | "chat";
export type QuotaReservation = { ok: true; used: number } | { ok: false; reason: "quota_exhausted" | "seller_quota_exhausted" };

// scope 행에 units를 더하되 cap을 넘으면 더하지 않는다. 더했으면 새 합계, 아니면 null.
async function add(db: Db, day: string, scope: string, units: number, cap: number): Promise<number | null> {
  if (units > cap) return null;
  const rows = await db.$queryRaw<{ units: number }[]>`
    INSERT INTO "YoutubeQuotaUsage" ("day", "scope", "units") VALUES (${day}, ${scope}, ${units})
    ON CONFLICT ("day", "scope") DO UPDATE SET "units" = "YoutubeQuotaUsage"."units" + ${units}
    WHERE "YoutubeQuotaUsage"."units" + ${units} <= ${cap}
    RETURNING "units"`;
  return rows[0]?.units ?? null;
}

export async function reserveQuota(
  db: PrismaClient,
  input: { units: number; purpose: QuotaPurpose; sellerId?: string },
  now: Date,
  limits: QuotaLimits = quotaLimits(),
): Promise<QuotaReservation> {
  const day = quotaDay(now);
  const cap = input.purpose === "chat" ? Math.floor(limits.daily * QUOTA_CHAT_RATIO) : limits.daily;
  return db.$transaction(async (tx) => {
    const used = await add(tx, day, QUOTA_ALL, input.units, cap);
    if (used === null) return { ok: false, reason: "quota_exhausted" } as const;
    if (input.sellerId && (await add(tx, day, input.sellerId, input.units, limits.perSeller)) === null) {
      // 전체 몫에 더한 것도 되돌린다
      await tx.youtubeQuotaUsage.update({ where: { day_scope: { day, scope: QUOTA_ALL } }, data: { units: { decrement: input.units } } });
      return { ok: false, reason: "seller_quota_exhausted" } as const;
    }
    return { ok: true, used } as const;
  });
}

export async function markQuotaExhausted(db: Db, now: Date, limits: QuotaLimits = quotaLimits()): Promise<void> {
  const day = quotaDay(now);
  await db.$executeRaw`
    INSERT INTO "YoutubeQuotaUsage" ("day", "scope", "units") VALUES (${day}, ${QUOTA_ALL}, ${limits.daily})
    ON CONFLICT ("day", "scope") DO UPDATE SET "units" = GREATEST("YoutubeQuotaUsage"."units", ${limits.daily})`;
}

export async function quotaUsage(db: Db, now: Date, limits: QuotaLimits = quotaLimits()) {
  const row = await db.youtubeQuotaUsage.findUnique({ where: { day_scope: { day: quotaDay(now), scope: QUOTA_ALL } } });
  const used = row?.units ?? 0;
  return { day: quotaDay(now), used, limit: limits.daily, ratio: used / limits.daily };
}

// 30일 지난 사용 기록 정리(날짜 문자열은 YYYY-MM-DD라 문자열 비교로 충분)
export async function purgeOldQuotaUsage(db: Db, now: Date): Promise<number> {
  const r = await db.youtubeQuotaUsage.deleteMany({ where: { day: { lt: quotaDay(new Date(now.getTime() - 30 * 86_400_000)) } } });
  return r.count;
}
