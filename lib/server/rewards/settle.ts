import type { ActorType, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 대기(PENDING) 적립 원장 지급 처리(SA-034 켜기 일괄 지급·SA-032 실패 재시도·정기 처리). 돈이 움직이는 곳이라 아래 규칙을 모두 지킨다.
// - 실제 지급이 켜져 있는 쇼핑몰만 처리한다(꺼져 있으면 아무것도 바꾸지 않는다). 처리하는 동안 스위치 변경(rewardLivePayout, 같은 advisory 잠금)은 기다린다.
// - 회원 한 명씩 한 트랜잭션: 회원 행 FOR SHARE(탈퇴와 순서를 맞춤) → 잔액 행 FOR UPDATE → 그 회원의 대기 줄을 만든 순서(createdAt, id)대로 적용.
//   그래서 같은 주문의 적립 뒤 회수가 순서대로 반영되고, 수동 조정·주문 사용과 동시에 돌아도 잔액 = 성공 원장 합계가 유지된다(음수 잔액 금지, DB CHECK도 막는다).
// - 한 줄의 적용: 양수는 잔액에 더하고, 음수(회수·수동 회수)는 잔액이 모자라면 적용하지 않고 실패(insufficient_balance)로 남긴다(회수 방식 AUTO의 「잔액 부족 시 실패 기록」).
//   적용한 줄은 SUCCEEDED·testMode=false·processedAt. 탈퇴 회원 줄은 실패(member_withdrawn)로 닫는다. 잔액이 20억을 넘게 되면 실패(balance_overflow).
// - 멱등: 줄 상태를 PENDING(또는 재시도 대상 FAILED)일 때만 조건부로 바꾸므로 같은 줄을 두 번 적용하지 않는다. 두 번 불러도(동시에도) 결과는 같다.
// - 재시도(retryIds): 실패 줄(탈퇴로 닫힌 줄 제외) 중 고른 것을 같은 규칙으로 다시 적용한다.
// - 한 번에 회원 memberLimit명(기본 200)까지. 남은 대기는 remaining으로 알려 주고 다시 부르면 이어서 처리한다.
export const SETTLE_MEMBER_LIMIT = 200;
const SETTLE_ROWS_PER_MEMBER = 500;
const BALANCE_MAX = 2_000_000_000;

export type SettleTrigger = "live_on" | "continue" | "retry" | "job";
export type SettleResult = { settled: number; settledAmount: number; revokedAmount: number; failed: number; remaining: number; skipped: "not_live" | null };

type Actor = { actorType: ActorType; actorId: string | null };
type Opts = { sellerId: string; trigger: SettleTrigger; retryIds?: string[]; memberLimit?: number; now?: Date; actor?: Actor; meta?: { ip?: string | null; userAgent?: string | null } };

export async function settlePendingRewards(db: PrismaClient, o: Opts): Promise<SettleResult> {
  const sellerId = o.sellerId;
  const limit = Math.min(Math.max(o.memberLimit ?? SETTLE_MEMBER_LIMIT, 1), 1000);
  const retryIds = o.retryIds ?? [];
  const total: SettleResult = { settled: 0, settledAmount: 0, revokedAmount: 0, failed: 0, remaining: 0, skipped: null };

  // 꺼져 있으면 처리할 줄이 없어도 바로 알린다(회원 트랜잭션 안에서도 다시 확인한다)
  const live = await db.rewardPolicy.findUnique({ where: { sellerId }, select: { livePayoutEnabled: true } });
  if (!live?.livePayoutEnabled) return { ...total, remaining: await db.rewardLedger.count({ where: { sellerId, status: "PENDING" } }), skipped: "not_live" };

  const members = await db.$queryRaw<{ buyerMemberId: string }[]>`
    SELECT l."buyerMemberId" FROM "RewardLedger" l
    WHERE l."sellerId" = ${sellerId}::uuid
      AND (l."status" = 'PENDING' OR (l."status" = 'FAILED' AND l."id" = ANY(${retryIds}::uuid[]) AND l."failureReason" IS DISTINCT FROM 'member_withdrawn'))
    GROUP BY l."buyerMemberId" ORDER BY min(l."createdAt"), l."buyerMemberId" LIMIT ${limit}`;

  for (const m of members) {
    const r = await db.$transaction(async (tx) => settleMember(tx, sellerId, m.buyerMemberId, retryIds, o.now ?? (await dbNow(tx))), { timeout: 30_000 });
    if (r.skipped) {
      total.skipped = r.skipped;
      break;
    }
    total.settled += r.settled;
    total.settledAmount += r.settledAmount;
    total.revokedAmount += r.revokedAmount;
    total.failed += r.failed;
  }
  total.remaining = await db.rewardLedger.count({ where: { sellerId, status: "PENDING" } });
  if (total.settled + total.failed > 0) {
    await writeAudit(db, {
      actorType: o.actor?.actorType ?? "SYSTEM",
      actorId: o.actor?.actorId ?? null,
      sellerId,
      action: "reward.settle",
      targetType: "Seller",
      targetId: sellerId,
      after: { trigger: o.trigger, settled: total.settled, settledAmount: total.settledAmount, revokedAmount: total.revokedAmount, failed: total.failed, remaining: total.remaining },
      ip: o.meta?.ip,
      userAgent: o.meta?.userAgent,
    });
  }
  return total;
}

async function settleMember(tx: Prisma.TransactionClient, sellerId: string, memberId: string, retryIds: string[], now: Date) {
  const out: SettleResult = { settled: 0, settledAmount: 0, revokedAmount: 0, failed: 0, remaining: 0, skipped: null };
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${`reward_live_payout:${sellerId}`}))`;
  const policy = await tx.rewardPolicy.findUnique({ where: { sellerId }, select: { livePayoutEnabled: true } });
  if (!policy?.livePayoutEnabled) return { ...out, skipped: "not_live" as const };

  const [m] = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "BuyerMember" WHERE "id" = ${memberId}::uuid AND "sellerId" = ${sellerId}::uuid FOR SHARE`;
  const withdrawn = !m || m.status === "WITHDRAWN";
  await tx.$executeRaw`INSERT INTO "RewardBalance" ("sellerId", "buyerMemberId", "balance", "updatedAt") VALUES (${sellerId}::uuid, ${memberId}::uuid, 0, now()) ON CONFLICT DO NOTHING`;
  const [bal] = await tx.$queryRaw<{ balance: number }[]>`
    SELECT "balance" FROM "RewardBalance" WHERE "sellerId" = ${sellerId}::uuid AND "buyerMemberId" = ${memberId}::uuid FOR UPDATE`;
  let balance = bal.balance;

  const rows = await tx.rewardLedger.findMany({
    where: { sellerId, buyerMemberId: memberId, OR: [{ status: "PENDING" }, { status: "FAILED", id: { in: retryIds }, NOT: { failureReason: "member_withdrawn" } }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: SETTLE_ROWS_PER_MEMBER,
    select: { id: true, amount: true, status: true, type: true },
  });
  for (const row of rows) {
    const reason = withdrawn ? "member_withdrawn" : row.amount < 0 && balance + row.amount < 0 ? "insufficient_balance" : balance + row.amount > BALANCE_MAX ? "balance_overflow" : null;
    const was = { id: row.id, status: row.status };
    if (reason) {
      const moved = await tx.rewardLedger.updateMany({ where: was, data: { status: "FAILED", failureReason: reason, processedAt: now } });
      if (moved.count === 1) out.failed += 1;
      continue;
    }
    const moved = await tx.rewardLedger.updateMany({ where: was, data: { status: "SUCCEEDED", testMode: false, failureReason: null, processedAt: now } });
    if (moved.count !== 1) continue;
    balance += row.amount;
    out.settled += 1;
    if (row.amount > 0) out.settledAmount += row.amount;
    else if (row.type === "REVOKE") out.revokedAmount += -row.amount;
  }
  if (balance !== bal.balance) await tx.rewardBalance.update({ where: { sellerId_buyerMemberId: { sellerId, buyerMemberId: memberId } }, data: { balance } });
  return out;
}

// 정기 처리(앱 안 스케줄러): 실제 지급이 켜진 쇼핑몰의 대기 줄을 처리한다. 처리한 줄 수를 돌려준다.
export async function settleAllLiveSellers(db: PrismaClient, now: Date = new Date()): Promise<number> {
  const sellers = await db.$queryRaw<{ sellerId: string }[]>`
    SELECT DISTINCT l."sellerId" FROM "RewardLedger" l JOIN "RewardPolicy" p ON p."sellerId" = l."sellerId"
    WHERE l."status" = 'PENDING' AND p."livePayoutEnabled" = true LIMIT 200`;
  let n = 0;
  for (const s of sellers) {
    try {
      const r = await settlePendingRewards(db, { sellerId: s.sellerId, trigger: "job", now });
      n += r.settled + r.failed;
    } catch (e) {
      console.error("[reward.settle_failed]", s.sellerId, e instanceof Error ? e.message : e);
    }
  }
  return n;
}

// ───────────── 파트너스 호출(권한 MEMBER_POINTS) ─────────────
export const RETRY_IDS_MAX = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 켜기 일괄 지급 이어서 처리(SA-034 「지급 중… 21 / 37」). 남은 대기가 있으면 remaining > 0이라 다시 부른다. 꺼져 있으면 skipped: "not_live".
export async function continueSettlement(db: PrismaClient, ctx: TenantContext, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<SettleResult> {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  return settlePendingRewards(db, { sellerId: ctx.sellerId, trigger: "continue", actor: { actorType: ctx.actorType, actorId: ctx.actorId }, meta });
}

// 실패 재시도(SA-032 「실패 N건 재시도」). ids가 없으면 처리할 수 있는 실패 줄 전체(최대 200), 있으면 그 줄만(내 쇼핑몰 것만, 최대 200개).
// 결과: settled(이번에 성공), failed(다시 실패). 실제 지급이 꺼져 있으면 skipped: "not_live"이고 아무것도 바꾸지 않는다.
export async function retryFailedRewards(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let ids: string[];
  if (b.ids === undefined) {
    ids = (await db.rewardLedger.findMany({ where: { sellerId: ctx.sellerId, status: "FAILED", NOT: { failureReason: "member_withdrawn" } }, orderBy: [{ processedAt: "asc" }, { id: "asc" }], take: RETRY_IDS_MAX, select: { id: true } })).map((r) => r.id);
  } else {
    if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > RETRY_IDS_MAX || b.ids.some((v) => typeof v !== "string" || !UUID_RE.test(v))) return { ok: false as const, reason: "invalid_retry" as const };
    ids = [...new Set(b.ids as string[])];
  }
  if (ids.length === 0) return { ok: true as const, result: { settled: 0, settledAmount: 0, revokedAmount: 0, failed: 0, remaining: 0, skipped: null } satisfies SettleResult, requested: 0 };
  // 내 쇼핑몰의 처리할 수 있는 실패 줄만(남의 id·성공 줄·탈퇴로 닫힌 줄은 settlePendingRewards가 건드리지 않는다)
  const result = await settlePendingRewards(db, { sellerId: ctx.sellerId, trigger: "retry", retryIds: ids, actor: { actorType: ctx.actorType, actorId: ctx.actorId }, meta });
  return { ok: true as const, result, requested: ids.length };
}
