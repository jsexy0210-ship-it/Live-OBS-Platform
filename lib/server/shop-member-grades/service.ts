import { Prisma, type ActorType, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { GRADES_MAX, isUuid, kstMonthKey, nextMonthStart, nextRank, parseGradeName, parseMinAmount, targetRank, thresholdsIncrease, windowStart, type GradeRejection } from "./rules";

// 회원 등급(SA-044, 2026-10-04 대표님 지시): 등급 이름·승급 기준액 편집, 등급 추가·삭제, 회원 수동 조정(고정),
// 매월 1일(KST) 자동 재산정(선택, 기본 꺼짐). 재산정 기준은 최근 6개월 결제 완료·미환불 주문 결제액 합계이고,
// 승급은 목표 등급까지 한 번에, 강등은 한 단계씩이며, 「고정」한 회원은 건너뛴다. 등급 기능 권한은 MEMBER_POINTS.
// 적립률은 적립 정책(SA-031)이 등급 id로 갖고 있으므로 이 화면은 읽기만 한다. 모든 변경은 로그 추적(member_grade.*)에 남긴다.
type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

export type GradeFailure = GradeRejection | "not_found" | "grade_in_use" | "base_grade_fixed" | "member_not_active";
export const GRADE_MESSAGES: Record<string, string> = {
  invalid_grade_name: "등급 이름을 12자 이내로 입력해 주십시오",
  invalid_min_amount: "기준 금액은 0원 이상의 정수로 입력해 주십시오",
  invalid_thresholds: "기준 금액은 높은 등급일수록 커야 합니다. 첫 등급은 0원입니다",
  too_many_grades: "등급은 10개까지 만들 수 있습니다",
  duplicate_name: "같은 이름의 등급이 있습니다",
  base_grade_amount: "첫 등급의 기준 금액은 0원입니다",
  invalid_body: "입력을 확인해 주십시오",
  not_found: "찾을 수 없습니다",
  grade_in_use: "회원이 있는 등급은 지울 수 없습니다. 회원을 다른 등급으로 옮겨 주십시오",
  base_grade_fixed: "기본 등급은 지울 수 없습니다",
  member_not_active: "정상 회원만 등급을 바꿀 수 있습니다",
};

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const audit = (tx: Db, ctx: TenantContext, action: string, targetId: string | undefined, before: unknown, after: unknown, targetType = "MemberGrade") =>
  writeAudit(tx, { actorType: ctx.actorType as ActorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType, targetId, before, after });

async function clockNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return rows[0].now;
}

type Rates = Record<string, { card?: number; bankTransfer?: number }>;

// 화면 데이터: 등급(회원 수·고정 수·적립률), 설정, 지난 재산정, 최근 변경, 고정한 회원
export async function getMemberGrades(db: PrismaClient, ctx: TenantContext, now = new Date()) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const [grades, policy, lastRun, reward, history, locked] = await Promise.all([
    db.memberGrade.findMany({ where: { sellerId: ctx.sellerId }, orderBy: { sortOrder: "asc" } }),
    db.memberGradePolicy.findUnique({ where: { sellerId: ctx.sellerId } }),
    db.memberGradeRun.findFirst({ where: { sellerId: ctx.sellerId }, orderBy: { monthKey: "desc" } }),
    db.rewardPolicy.findUnique({ where: { sellerId: ctx.sellerId }, select: { rates: true } }),
    db.memberGradeHistory.findMany({ where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, include: { buyerMember: { select: { broadcastNickname: true } } } }),
    db.memberGradeOverride.findMany({ where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, include: { buyerMember: { select: { id: true, broadcastNickname: true, gradeId: true } } } }),
  ]);
  const counts = await db.buyerMember.groupBy({ by: ["gradeId"], where: { sellerId: ctx.sellerId, deletedAt: null, status: "ACTIVE" }, _count: { _all: true } });
  const lockedCounts = await db.memberGradeOverride.count({ where: { sellerId: ctx.sellerId } });
  const rates = (reward?.rates && typeof reward.rates === "object" ? reward.rates : {}) as Rates;
  return {
    grades: grades.map((g) => ({
      id: g.id,
      displayName: g.displayName,
      sortOrder: g.sortOrder,
      minAmount: g.minAmount,
      isBase: g.systemKey === "BASIC",
      custom: g.systemKey === null,
      members: counts.find((c) => c.gradeId === g.id)?._count._all ?? 0,
      rewardCard: rates[g.id]?.card ?? null,
      rewardBankTransfer: rates[g.id]?.bankTransfer ?? null,
    })),
    autoEnabled: policy?.autoEnabled ?? false,
    lockedCount: lockedCounts,
    lastRun: lastRun ? { monthKey: lastRun.monthKey, promoted: lastRun.promoted, demoted: lastRun.demoted, ranAt: lastRun.ranAt } : null,
    nextRunAt: nextMonthStart(now),
    recent: history.map((h) => ({ id: h.id, nickname: h.buyerMember.broadcastNickname, fromName: h.fromName, toName: h.toName, reason: h.reason, amount: h.amount, createdAt: h.createdAt })),
    locked: locked.map((l) => ({ memberId: l.buyerMember.id, nickname: l.buyerMember.broadcastNickname, gradeId: l.buyerMember.gradeId })),
  };
}

// 이름·기준액·자동 재산정 켜기를 한 번에 저장. 보낸 등급만 바꾼다. 자동 재산정을 켜 두면 기준액이 순서대로 커야 한다.
export async function saveMemberGrades(db: PrismaClient, ctx: TenantContext, body: { autoEnabled?: unknown; grades?: unknown }) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (body.autoEnabled !== undefined && typeof body.autoEnabled !== "boolean") return fail("invalid_body");
  if (body.grades !== undefined && !Array.isArray(body.grades)) return fail("invalid_body");
  const edits: { id: string; displayName: string; minAmount: number }[] = [];
  for (const g of (body.grades ?? []) as Record<string, unknown>[]) {
    const name = parseGradeName(g?.displayName);
    const amount = parseMinAmount(g?.minAmount);
    if (!isUuid(g?.id)) return fail("invalid_body");
    if (!name) return fail("invalid_grade_name");
    if (amount === null) return fail("invalid_min_amount");
    edits.push({ id: g.id as string, displayName: name, minAmount: amount });
  }
  try {
    return await db.$transaction(async (tx) => {
      // 쇼핑몰 등급 설정 한 줄을 잠가 동시 저장·재산정과 겹치지 않게 한다
      await tx.memberGradePolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId }, update: {} });
      await tx.$queryRaw`SELECT 1 FROM "MemberGradePolicy" WHERE "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
      const current = await tx.memberGrade.findMany({ where: { sellerId: ctx.sellerId }, orderBy: { sortOrder: "asc" } });
      const known = new Set(current.map((g) => g.id));
      if (edits.some((e) => !known.has(e.id)) || new Set(edits.map((e) => e.id)).size !== edits.length) return fail("not_found");
      const next = current.map((g) => {
        const e = edits.find((x) => x.id === g.id);
        return { ...g, displayName: e?.displayName ?? g.displayName, minAmount: e?.minAmount ?? g.minAmount };
      });
      if (new Set(next.map((g) => g.displayName)).size !== next.length) return fail("duplicate_name");
      if (next[0] && next[0].minAmount !== 0) return fail("base_grade_amount");
      const before = await tx.memberGradePolicy.findUniqueOrThrow({ where: { sellerId: ctx.sellerId } });
      const auto = body.autoEnabled ?? before.autoEnabled;
      if (auto && !thresholdsIncrease(next.map((g) => g.minAmount))) return fail("invalid_thresholds");
      // 이름을 서로 맞바꿔도 유니크 키에 걸리지 않게 임시 이름을 거친다
      for (const e of edits) await tx.memberGrade.update({ where: { id: e.id }, data: { displayName: `__tmp_${e.id}` } });
      for (const e of edits) await tx.memberGrade.update({ where: { id: e.id }, data: { displayName: e.displayName, minAmount: e.minAmount } });
      await tx.memberGradePolicy.update({ where: { sellerId: ctx.sellerId }, data: { autoEnabled: auto, updatedAt: await clockNow(tx) } });
      await audit(tx, ctx, "member_grade.update", undefined, { autoEnabled: before.autoEnabled, grades: current.map((g) => [g.displayName, g.minAmount]) }, { autoEnabled: auto, grades: next.map((g) => [g.displayName, g.minAmount]) });
      return { ok: true as const };
    });
  } catch (e) {
    if (isUnique(e)) return fail("duplicate_name");
    throw e;
  }
}

const fail = (reason: GradeFailure) => ({ ok: false as const, reason });

// 등급 추가: 가장 높은 등급 위에 붙는다. 자동 재산정이 켜져 있으면 기준액이 맨 위 등급보다 커야 한다.
export async function addMemberGrade(db: PrismaClient, ctx: TenantContext, body: { displayName?: unknown; minAmount?: unknown }) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const name = parseGradeName(body.displayName);
  const amount = parseMinAmount(body.minAmount);
  if (!name) return fail("invalid_grade_name");
  if (amount === null) return fail("invalid_min_amount");
  try {
    return await db.$transaction(async (tx) => {
      await tx.memberGradePolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId }, update: {} });
      const policy = (await tx.$queryRaw<{ autoEnabled: boolean }[]>`SELECT "autoEnabled" FROM "MemberGradePolicy" WHERE "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`)[0];
      const all = await tx.memberGrade.findMany({ where: { sellerId: ctx.sellerId }, orderBy: { sortOrder: "asc" } });
      if (all.length >= GRADES_MAX) return fail("too_many_grades");
      const top = all[all.length - 1];
      if (policy.autoEnabled && top && amount <= top.minAmount) return fail("invalid_thresholds");
      const g = await tx.memberGrade.create({ data: { sellerId: ctx.sellerId, displayName: name, minAmount: amount, sortOrder: (top?.sortOrder ?? -1) + 1 }, select: { id: true } });
      await audit(tx, ctx, "member_grade.create", g.id, undefined, { displayName: name, minAmount: amount });
      return { ok: true as const, id: g.id };
    });
  } catch (e) {
    if (isUnique(e)) return fail("duplicate_name");
    throw e;
  }
}

// 등급 삭제: 직접 만든 등급 중 회원(탈퇴 제외 모든 회원)이 없는 것만. 가운데 등급을 지워도 자동 재산정은 남은 기준액 순서대로 돈다.
export async function deleteMemberGrade(db: PrismaClient, ctx: TenantContext, gradeId: string) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(gradeId)) return fail("not_found");
  return db.$transaction(async (tx) => {
    await tx.memberGradePolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId }, update: {} });
    await tx.$queryRaw`SELECT 1 FROM "MemberGradePolicy" WHERE "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    const g = await tx.memberGrade.findFirst({ where: { id: gradeId, sellerId: ctx.sellerId } });
    if (!g) return fail("not_found");
    if (g.systemKey !== null) return fail("base_grade_fixed");
    if ((await tx.buyerMember.count({ where: { sellerId: ctx.sellerId, gradeId } })) > 0) return fail("grade_in_use");
    await tx.memberGrade.delete({ where: { id: gradeId } });
    await audit(tx, ctx, "member_grade.delete", gradeId, { displayName: g.displayName, minAmount: g.minAmount }, undefined);
    return { ok: true as const };
  });
}

// 회원 등급 직접 조정. lock이면 「고정」: 자동 재산정에서 건너뛴다. lock이 아니면 지금 등급만 바꾸고 고정을 푼다.
export async function setMemberGrade(db: PrismaClient, ctx: TenantContext, memberId: string, body: { gradeId?: unknown; lock?: unknown }) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(memberId)) return fail("not_found");
  if (!isUuid(body.gradeId) || typeof body.lock !== "boolean") return fail("invalid_body");
  const gradeId = body.gradeId;
  const lock = body.lock;
  return db.$transaction(async (tx) => {
    const [m] = await tx.$queryRaw<{ id: string; gradeId: string; status: string; deletedAt: Date | null }[]>`
      SELECT "id", "gradeId", "status"::text AS "status", "deletedAt" FROM "BuyerMember" WHERE "id" = ${memberId}::uuid AND "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    if (!m) return fail("not_found");
    if (m.status !== "ACTIVE" || m.deletedAt) return fail("member_not_active");
    const to = await tx.memberGrade.findFirst({ where: { id: gradeId, sellerId: ctx.sellerId } });
    if (!to) return fail("not_found");
    const from = await tx.memberGrade.findUniqueOrThrow({ where: { id: m.gradeId } });
    const hadLock = (await tx.memberGradeOverride.count({ where: { buyerMemberId: memberId } })) > 0;
    if (from.id !== to.id) {
      await tx.buyerMember.update({ where: { id: memberId }, data: { gradeId: to.id } });
      await tx.memberGradeHistory.create({ data: { sellerId: ctx.sellerId, buyerMemberId: memberId, fromName: from.displayName, toName: to.displayName, reason: "MANUAL", staffId: ctx.actorId } });
    }
    if (lock && !hadLock) await tx.memberGradeOverride.create({ data: { sellerId: ctx.sellerId, buyerMemberId: memberId, staffId: ctx.actorId } });
    if (!lock && hadLock) await tx.memberGradeOverride.deleteMany({ where: { buyerMemberId: memberId } });
    await audit(tx, ctx, "member_grade.manual", memberId, { grade: from.displayName, locked: hadLock }, { grade: to.displayName, locked: lock }, "BuyerMember");
    return { ok: true as const, changed: from.id !== to.id };
  });
}

// 탈퇴 때: 그 회원의 고정 표시·등급 변경 기록을 지운다(개인정보는 없지만 회원에 딸린 기록이라 남기지 않는다)
export async function deleteMemberGradeData(tx: Tx, scope: { sellerId: string; buyerMemberId: string }) {
  await tx.memberGradeOverride.deleteMany({ where: scope });
  await tx.memberGradeHistory.deleteMany({ where: scope });
}

// ───────────── 월 1회 자동 재산정 ─────────────

const PAGE = 500;

// 한 쇼핑몰 재산정(이미 이 달에 돌았으면 건너뜀: 실행 기록의 기본 키가 막는다). 처리한 {승급, 강등} 수를 돌려준다.
export async function recalcSellerGrades(db: PrismaClient, sellerId: string, now: Date): Promise<{ ran: boolean; promoted: number; demoted: number }> {
  const monthKey = kstMonthKey(now);
  try {
    return await db.$transaction(async (tx) => {
      const [policy] = await tx.$queryRaw<{ autoEnabled: boolean }[]>`SELECT "autoEnabled" FROM "MemberGradePolicy" WHERE "sellerId" = ${sellerId}::uuid FOR UPDATE`;
      if (!policy?.autoEnabled) return { ran: false, promoted: 0, demoted: 0 };
      await tx.memberGradeRun.create({ data: { sellerId, monthKey, ranAt: now } });
      const grades = await tx.memberGrade.findMany({ where: { sellerId }, orderBy: { sortOrder: "asc" } });
      if (grades.length === 0 || !thresholdsIncrease(grades.map((g) => g.minAmount))) throw new Skip();
      const thresholds = grades.map((g) => g.minAmount);
      const rankOf = new Map(grades.map((g, i) => [g.id, i]));
      const locked = new Set((await tx.memberGradeOverride.findMany({ where: { sellerId }, select: { buyerMemberId: true } })).map((o) => o.buyerMemberId));
      const from = windowStart(now);
      const sums = await tx.order.groupBy({ by: ["buyerMemberId"], where: { sellerId, status: "PAID", paidAt: { gte: from, lt: now } }, _sum: { totalAmount: true, refundAmount: true } });
      // 결제액 − 부분 환불액(결제 완료 주문에 남은 환불액, 관리자 매출 집계와 같은 기준)
      const amount = new Map(sums.map((s) => [s.buyerMemberId, Math.max(0, (s._sum.totalAmount ?? 0) - (s._sum.refundAmount ?? 0))]));
      let promoted = 0;
      let demoted = 0;
      let cursor: string | undefined;
      for (;;) {
        const page = await tx.buyerMember.findMany({
          where: { sellerId, status: "ACTIVE", deletedAt: null },
          orderBy: { id: "asc" },
          take: PAGE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: { id: true, gradeId: true },
        });
        if (page.length === 0) break;
        cursor = page[page.length - 1].id;
        for (const m of page) {
          if (locked.has(m.id)) continue;
          const cur = rankOf.get(m.gradeId);
          if (cur === undefined) continue;
          const amt = amount.get(m.id) ?? 0;
          const nxt = nextRank(cur, targetRank(thresholds, amt));
          if (nxt === cur) continue;
          // 그사이 직접 조정한 회원(등급이 바뀜)은 건드리지 않는다
          const moved = await tx.buyerMember.updateMany({ where: { id: m.id, sellerId, gradeId: m.gradeId }, data: { gradeId: grades[nxt].id } });
          if (moved.count !== 1) continue;
          if (nxt > cur) promoted++;
          else demoted++;
          await tx.memberGradeHistory.create({
            data: { sellerId, buyerMemberId: m.id, fromName: grades[cur].displayName, toName: grades[nxt].displayName, reason: nxt > cur ? "AUTO_UP" : "AUTO_DOWN", amount: amt, createdAt: now },
          });
        }
        if (page.length < PAGE) break;
      }
      await tx.memberGradeRun.update({ where: { sellerId_monthKey: { sellerId, monthKey } }, data: { promoted, demoted } });
      await writeAudit(tx, { actorType: "SYSTEM", sellerId, action: "member_grade.recalc", targetType: "Seller", targetId: sellerId, after: { monthKey, promoted, demoted } });
      return { ran: true, promoted, demoted };
    });
  } catch (e) {
    // 이 달에 이미 돌았거나(기록 중복) 기준액이 올바르지 않아 건너뜀: 실패가 아니다
    if (isUnique(e) || e instanceof Skip) return { ran: false, promoted: 0, demoted: 0 };
    throw e;
  }
}
class Skip extends Error {}

// 정기 실행(앱 안 스케줄러가 매시간 부름): 자동 재산정을 켠 쇼핑몰 중 이 달에 아직 돌지 않은 곳을 하나씩 처리한다. 처리한 쇼핑몰 수를 돌려준다.
export async function recalcMonthlyGrades(db: PrismaClient, now = new Date()): Promise<number> {
  const monthKey = kstMonthKey(now);
  const sellers = await db.memberGradePolicy.findMany({ where: { autoEnabled: true, seller: { memberGradeRuns: { none: { monthKey } } } }, select: { sellerId: true } });
  let done = 0;
  for (const s of sellers) {
    try {
      if ((await recalcSellerGrades(db, s.sellerId, now)).ran) done++;
    } catch (e) {
      console.error("[member_grade.recalc_failed]", s.sellerId, e);
    }
  }
  return done;
}
