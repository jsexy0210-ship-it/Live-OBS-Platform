import { Prisma, type ActorType, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { grantPromotionCoupon, SHIPPING_DISCOUNT_MAX } from "./benefits";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { GRADES_MAX, isUuid, nextRank, nextRunAt, parseCadence, parseDemotion, parseGradeName, parseMinAmount, parseOverrideReason, parseUntilDate, parseWindowMonths, runKey, targetRank, thresholdsIncrease, windowStart, type Cadence, type Demotion, type GradeRejection } from "./rules";

// 회원 등급(SA-044, 2026-10-04 대표님 지시): 등급 이름·승급 기준액 편집, 등급 추가·삭제, 회원 수동 조정(고정: 기간·사유),
// 자동 재산정(선택, 기본 꺼짐)과 「지금 재산정」. 산정 기준은 설정: 기간(3·6·12개월·누적) × 주기(매월 1일·매주 월요일·매일, KST) × 강등(한 단계씩·바로·없음).
// 재산정 기준액은 기간 안의 결제 완료 주문 결제액 − 부분 환불액 합계이고, 승급은 목표 등급까지 한 번에, 「고정」한 회원은 건너뛴다.
// 자동 재산정을 켤 때(또는 주기를 바꿀 때)는 그 주기를 이미 돈 것으로 기록해 바로 도는 일을 막는다. 등급 기능 권한은 MEMBER_POINTS.
// 적립률은 적립 정책(SA-031)이 등급 id로 갖고 있으므로 이 화면은 읽기만 한다. 모든 변경은 로그 추적(member_grade.*)에 남긴다.
type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

export type GradeFailure = GradeRejection | "invalid_benefit" | "invalid_coupon" | "not_found" | "base_grade_fixed" | "member_not_active" | "invalid_thresholds_for_run";
export const GRADE_MESSAGES: Record<string, string> = {
  invalid_grade_name: "등급 이름을 12자 이내로 입력해 주십시오",
  invalid_min_amount: "기준 금액은 0원 이상의 정수로 입력해 주십시오",
  invalid_thresholds: "기준 금액은 높은 등급일수록 커야 합니다. 첫 등급은 0원입니다",
  too_many_grades: "등급은 10개까지 만들 수 있습니다",
  duplicate_name: "같은 이름의 등급이 있습니다",
  base_grade_amount: "첫 등급의 기준 금액은 0원입니다",
  invalid_body: "입력을 확인해 주십시오",
  invalid_benefit: "배송비 혜택을 확인해 주십시오. 정액 할인은 1원 이상 100,000원 이하로 입력합니다",
  invalid_coupon: "승급 쿠폰은 직접 지급 방식으로 만든 쿠폰만 고를 수 있습니다",
  invalid_setting: "산정 기준을 확인해 주십시오",
  invalid_until: "고정 종료일은 오늘 이후 날짜로 입력해 주십시오",
  invalid_reason: "사유는 100자 이내로 입력해 주십시오",
  invalid_thresholds_for_run: "기준 금액이 높은 등급일수록 커지도록 저장한 뒤 재산정해 주십시오",
  not_found: "찾을 수 없습니다",
  base_grade_fixed: "기본 등급은 지울 수 없습니다",
  member_not_active: "정상 회원만 등급을 바꿀 수 있습니다",
};

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const audit = (tx: Db, ctx: TenantContext, action: string, targetId: string | undefined, before: unknown, after: unknown, targetType = "MemberGrade") =>
  writeAudit(tx, { actorType: ctx.actorType as ActorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType, targetId, before, after });
const fail = (reason: GradeFailure) => ({ ok: false as const, reason });

async function clockNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return rows[0].now;
}

type Rates = Record<string, { card?: number; bankTransfer?: number }>;
const activeLock = (now: Date): Prisma.MemberGradeOverrideWhereInput => ({ OR: [{ until: null }, { until: { gt: now } }] });

// 화면 데이터: 등급(회원 수·적립률), 산정 기준, 지난·다음 재산정, 최근 변경, 고정한 회원
export async function getMemberGrades(db: PrismaClient, ctx: TenantContext, now = new Date()) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const [grades, policy, lastRun, reward, history, locked, lockedCount, counts, couponRows] = await Promise.all([
    db.memberGrade.findMany({ where: { sellerId: ctx.sellerId }, orderBy: { sortOrder: "asc" } }),
    db.memberGradePolicy.findUnique({ where: { sellerId: ctx.sellerId } }),
    db.memberGradeRun.findFirst({ where: { sellerId: ctx.sellerId }, orderBy: { ranAt: "desc" } }),
    db.rewardPolicy.findUnique({ where: { sellerId: ctx.sellerId }, select: { rates: true } }),
    db.memberGradeHistory.findMany({ where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, include: { buyerMember: { select: { broadcastNickname: true } } } }),
    db.memberGradeOverride.findMany({ where: { sellerId: ctx.sellerId, ...activeLock(now) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, include: { buyerMember: { select: { id: true, broadcastNickname: true, gradeId: true } } } }),
    db.memberGradeOverride.count({ where: { sellerId: ctx.sellerId, ...activeLock(now) } }),
    db.buyerMember.groupBy({ by: ["gradeId"], where: { sellerId: ctx.sellerId, deletedAt: null, status: "ACTIVE" }, _count: { _all: true } }),
    // 승급 쿠폰으로 고를 수 있는 쿠폰: 직접 지급 방식(종료된 쿠폰은 화면에서 이름 옆에 표시)
    db.coupon.findMany({ where: { sellerId: ctx.sellerId, issueMethod: "MANUAL" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, name: true, isActive: true, endsAt: true } }),
  ]);
  const rates = (reward?.rates && typeof reward.rates === "object" ? reward.rates : {}) as Rates;
  const cadence = (policy?.cadence ?? "MONTHLY") as Cadence;
  return {
    grades: grades.map((g) => ({
      id: g.id,
      displayName: g.displayName,
      sortOrder: g.sortOrder,
      minAmount: g.minAmount,
      isBase: g.systemKey === "BASIC",
      members: counts.find((c) => c.gradeId === g.id)?._count._all ?? 0,
      rewardCard: rates[g.id]?.card ?? null,
      rewardBankTransfer: rates[g.id]?.bankTransfer ?? null,
      shippingBenefit: g.shippingBenefit,
      shippingDiscount: g.shippingDiscount,
      promotionCouponId: g.promotionCouponId,
    })),
    couponOptions: couponRows.map((c) => ({ id: c.id, name: c.name, usable: c.isActive && c.endsAt > now })),
    memberTotal: counts.reduce((n, c) => n + c._count._all, 0),
    autoEnabled: policy?.autoEnabled ?? false,
    windowMonths: policy?.windowMonths ?? 6,
    cadence,
    demotion: (policy?.demotion ?? "STEP") as Demotion,
    lockedCount,
    lastRun: lastRun ? { key: lastRun.monthKey, promoted: lastRun.promoted, demoted: lastRun.demoted, ranAt: lastRun.ranAt } : null,
    nextRunAt: nextRunAt(cadence, now),
    recent: history.map((h) => ({ id: h.id, nickname: h.buyerMember.broadcastNickname, fromName: h.fromName, toName: h.toName, reason: h.reason, amount: h.amount, createdAt: h.createdAt })),
    locked: locked.map((l) => ({ memberId: l.buyerMember.id, nickname: l.buyerMember.broadcastNickname, gradeId: l.buyerMember.gradeId, until: l.until, reason: l.reason })),
  };
}

type SaveBody = { autoEnabled?: unknown; windowMonths?: unknown; cadence?: unknown; demotion?: unknown; grades?: unknown };

// 이름·기준액·산정 기준·자동 재산정 켜기를 한 번에 저장. 보낸 값만 바꾼다. 자동 재산정을 켜 두면 기준액이 순서대로 커야 한다.
// 자동 재산정을 새로 켜거나 주기를 바꾸면 그 주기를 이미 돈 것으로 기록해, 저장하자마자 도는 일을 막는다.
export async function saveMemberGrades(db: PrismaClient, ctx: TenantContext, body: SaveBody) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (body.autoEnabled !== undefined && typeof body.autoEnabled !== "boolean") return fail("invalid_body");
  if (body.grades !== undefined && !Array.isArray(body.grades)) return fail("invalid_body");
  const windowMonths = body.windowMonths === undefined ? undefined : parseWindowMonths(body.windowMonths);
  const cadence = body.cadence === undefined ? undefined : parseCadence(body.cadence);
  const demotion = body.demotion === undefined ? undefined : parseDemotion(body.demotion);
  if (windowMonths === null || cadence === null || demotion === null) return fail("invalid_setting");
  type BenefitEdit = { shippingBenefit?: "NONE" | "DISCOUNT" | "FREE"; shippingDiscount?: number; promotionCouponId?: string | null };
  const edits: ({ id: string; displayName: string; minAmount: number } & BenefitEdit)[] = [];
  for (const g of (body.grades ?? []) as Record<string, unknown>[]) {
    const name = parseGradeName(g?.displayName);
    const amount = parseMinAmount(g?.minAmount);
    if (!isUuid(g?.id)) return fail("invalid_body");
    if (!name) return fail("invalid_grade_name");
    if (amount === null) return fail("invalid_min_amount");
    const benefit: BenefitEdit = {};
    if (g.shippingBenefit !== undefined) {
      if (g.shippingBenefit !== "NONE" && g.shippingBenefit !== "DISCOUNT" && g.shippingBenefit !== "FREE") return fail("invalid_benefit");
      benefit.shippingBenefit = g.shippingBenefit;
      if (g.shippingBenefit === "DISCOUNT") {
        if (typeof g.shippingDiscount !== "number" || !Number.isInteger(g.shippingDiscount) || g.shippingDiscount < 1 || g.shippingDiscount > SHIPPING_DISCOUNT_MAX) return fail("invalid_benefit");
        benefit.shippingDiscount = g.shippingDiscount;
      } else {
        if (g.shippingDiscount !== undefined && g.shippingDiscount !== 0 && g.shippingDiscount !== null) return fail("invalid_benefit");
        benefit.shippingDiscount = 0;
      }
    } else if (g.shippingDiscount !== undefined) return fail("invalid_benefit");
    if (g.promotionCouponId !== undefined) {
      if (g.promotionCouponId !== null && !isUuid(g.promotionCouponId)) return fail("invalid_coupon");
      benefit.promotionCouponId = g.promotionCouponId as string | null;
    }
    edits.push({ id: g.id as string, displayName: name, minAmount: amount, ...benefit });
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
        return {
          ...g,
          displayName: e?.displayName ?? g.displayName,
          minAmount: e?.minAmount ?? g.minAmount,
          shippingBenefit: e?.shippingBenefit ?? g.shippingBenefit,
          shippingDiscount: e?.shippingDiscount ?? g.shippingDiscount,
          promotionCouponId: e?.promotionCouponId === undefined ? g.promotionCouponId : e.promotionCouponId,
        };
      });
      if (new Set(next.map((g) => g.displayName)).size !== next.length) return fail("duplicate_name");
      // 승급 쿠폰은 이 쇼핑몰의 직접 지급 방식 쿠폰이어야 한다
      const couponIds = [...new Set(edits.map((e) => e.promotionCouponId).filter((v): v is string => typeof v === "string"))];
      if (couponIds.length > 0 && (await tx.coupon.count({ where: { sellerId: ctx.sellerId, id: { in: couponIds }, issueMethod: "MANUAL" } })) !== couponIds.length) return fail("invalid_coupon");
      if (next[0] && next[0].minAmount !== 0) return fail("base_grade_amount");
      const before = await tx.memberGradePolicy.findUniqueOrThrow({ where: { sellerId: ctx.sellerId } });
      const auto = body.autoEnabled ?? before.autoEnabled;
      if (auto && !thresholdsIncrease(next.map((g) => g.minAmount))) return fail("invalid_thresholds");
      // 이름을 서로 맞바꿔도 유니크 키에 걸리지 않게 임시 이름을 거친다
      for (const e of edits) await tx.memberGrade.update({ where: { id: e.id }, data: { displayName: `__tmp_${e.id}` } });
      for (const e of edits) {
        const { id: _id, ...data } = e;
        await tx.memberGrade.update({ where: { id: e.id }, data });
      }
      const now = await clockNow(tx);
      const after = {
        autoEnabled: auto,
        windowMonths: windowMonths ?? before.windowMonths,
        cadence: (cadence ?? before.cadence) as Cadence,
        demotion: (demotion ?? before.demotion) as Demotion,
      };
      await tx.memberGradePolicy.update({ where: { sellerId: ctx.sellerId }, data: { ...after, updatedAt: now } });
      if (auto && (!before.autoEnabled || after.cadence !== before.cadence)) {
        const key = runKey(after.cadence, now);
        await tx.memberGradeRun.upsert({ where: { sellerId_monthKey: { sellerId: ctx.sellerId, monthKey: key } }, create: { sellerId: ctx.sellerId, monthKey: key, ranAt: now }, update: {} });
      }
      await audit(
        tx,
        ctx,
        "member_grade.update",
        undefined,
        { ...pick(before), grades: current.map((g) => [g.displayName, g.minAmount, g.shippingBenefit, g.shippingDiscount, g.promotionCouponId]) },
        { ...after, grades: next.map((g) => [g.displayName, g.minAmount, g.shippingBenefit, g.shippingDiscount, g.promotionCouponId]) },
      );
      return { ok: true as const };
    });
  } catch (e) {
    if (isUnique(e)) return fail("duplicate_name");
    throw e;
  }
}
const pick = (p: { autoEnabled: boolean; windowMonths: number; cadence: string; demotion: string }) => ({ autoEnabled: p.autoEnabled, windowMonths: p.windowMonths, cadence: p.cadence, demotion: p.demotion });

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

// 등급 삭제: 기본 등급(일반)만 못 지운다. 회원이 있으면 모두 기본 등급으로 옮기고(변경 기록 GRADE_REMOVED),
// 다음 재산정 때 기준에 맞는 등급으로 다시 올라간다. 남은 기준액이 순서대로 커야 자동 재산정이 돈다(가운데를 지워도 순서는 유지).
export async function deleteMemberGrade(db: PrismaClient, ctx: TenantContext, gradeId: string) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(gradeId)) return fail("not_found");
  return db.$transaction(async (tx) => {
    await tx.memberGradePolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId }, update: {} });
    await tx.$queryRaw`SELECT 1 FROM "MemberGradePolicy" WHERE "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    const g = await tx.memberGrade.findFirst({ where: { id: gradeId, sellerId: ctx.sellerId } });
    if (!g) return fail("not_found");
    if (g.systemKey === "BASIC") return fail("base_grade_fixed");
    const base = await tx.memberGrade.findFirstOrThrow({ where: { sellerId: ctx.sellerId, systemKey: "BASIC" } });
    // 탈퇴·휴면 포함 이 등급의 모든 회원을 기본 등급으로. 회원 행을 잠가 동시 가입·조정과 겹치지 않게 한다.
    const members = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BuyerMember" WHERE "sellerId" = ${ctx.sellerId}::uuid AND "gradeId" = ${gradeId}::uuid ORDER BY "id" FOR UPDATE`;
    if (members.length > 0) {
      await tx.buyerMember.updateMany({ where: { sellerId: ctx.sellerId, id: { in: members.map((m) => m.id) } }, data: { gradeId: base.id } });
      await tx.memberGradeHistory.createMany({ data: members.map((m) => ({ sellerId: ctx.sellerId, buyerMemberId: m.id, fromName: g.displayName, toName: base.displayName, reason: "GRADE_REMOVED" as const, staffId: ctx.actorId })) });
    }
    await tx.memberGrade.delete({ where: { id: gradeId } });
    await audit(tx, ctx, "member_grade.delete", gradeId, { displayName: g.displayName, minAmount: g.minAmount }, { movedMembers: members.length, movedTo: base.displayName });
    return { ok: true as const, moved: members.length };
  });
}

// 회원 등급 직접 조정. lock이면 「고정」: 자동 재산정에서 건너뛴다(until: 끝나는 날 YYYY-MM-DD(KST), 없으면 직접 풀 때까지. reason: 사유 100자).
// lock이 아니면 지금 등급만 바꾸고 고정을 푼다.
export async function setMemberGrade(db: PrismaClient, ctx: TenantContext, memberId: string, body: { gradeId?: unknown; lock?: unknown; until?: unknown; reason?: unknown }) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!isUuid(memberId)) return fail("not_found");
  if (!isUuid(body.gradeId) || typeof body.lock !== "boolean") return fail("invalid_body");
  const gradeId = body.gradeId;
  const lock = body.lock;
  const reasonGiven = body.reason !== undefined && body.reason !== null && body.reason !== "";
  const reason = reasonGiven ? parseOverrideReason(body.reason) : null;
  if (reasonGiven && !reason) return fail("invalid_reason");
  const untilGiven = body.until !== undefined && body.until !== null && body.until !== "";
  return db.$transaction(async (tx) => {
    const now = await clockNow(tx);
    const until = untilGiven ? parseUntilDate(body.until, now) : null;
    if (untilGiven && !until) return fail("invalid_until");
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
      // 직접 올린 경우에도 그 등급의 승급 쿠폰을 한 장 준다(이미 받은 쿠폰은 다시 주지 않음)
      if (to.sortOrder > from.sortOrder) await grantPromotionCoupon(tx, { sellerId: ctx.sellerId, buyerMemberId: memberId, gradeId: to.id });
    }
    if (lock) {
      // 이미 고정한 회원이면 기간·사유만 새로 정한다
      await tx.memberGradeOverride.upsert({
        where: { buyerMemberId: memberId },
        create: { sellerId: ctx.sellerId, buyerMemberId: memberId, staffId: ctx.actorId, until, reason },
        update: { staffId: ctx.actorId, until, reason },
      });
    } else if (hadLock) await tx.memberGradeOverride.deleteMany({ where: { buyerMemberId: memberId } });
    await audit(tx, ctx, "member_grade.manual", memberId, { grade: from.displayName, locked: hadLock }, { grade: to.displayName, locked: lock, until, reason }, "BuyerMember");
    return { ok: true as const, changed: from.id !== to.id };
  });
}

// 「변동 회원 보기」: 최근 변경(승급·강등·직접 조정) 목록. kind: up(승급) / down(강등) / 없으면 전체. 최근 100건.
export async function listGradeChanges(db: PrismaClient, ctx: TenantContext, q: { kind?: unknown } = {}) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const reasons = q.kind === "up" ? (["AUTO_UP"] as const) : q.kind === "down" ? (["AUTO_DOWN"] as const) : undefined;
  const rows = await db.memberGradeHistory.findMany({
    where: { sellerId: ctx.sellerId, ...(reasons ? { reason: { in: [...reasons] } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    include: { buyerMember: { select: { id: true, broadcastNickname: true } } },
  });
  return { changes: rows.map((h) => ({ id: h.id, memberId: h.buyerMember.id, nickname: h.buyerMember.broadcastNickname, fromName: h.fromName, toName: h.toName, reason: h.reason, amount: h.amount, createdAt: h.createdAt })) };
}

// 탈퇴 때: 그 회원의 고정 표시·등급 변경 기록을 지운다(개인정보는 없지만 회원에 딸린 기록이라 남기지 않는다)
export async function deleteMemberGradeData(tx: Tx, scope: { sellerId: string; buyerMemberId: string }) {
  await tx.memberGradeOverride.deleteMany({ where: scope });
  await tx.memberGradeHistory.deleteMany({ where: scope });
}

// ───────────── 재산정 ─────────────

const PAGE = 500;
export type RecalcResult = { ran: boolean; promoted: number; demoted: number; unchanged: number };
const NOT_RAN: RecalcResult = { ran: false, promoted: 0, demoted: 0, unchanged: 0 };

// 한 쇼핑몰 재산정. 정기 실행(기본): 켠 쇼핑몰만, 이 주기(월·주·일 키)에 아직 안 돌았을 때만(실행 기록의 기본 키가 동시 실행도 막음).
// manual(「지금 재산정」): 켜짐·실행 기록과 상관없이 지금 기준으로 한 번 더 계산한다(기록은 남기지 않음).
export async function recalcSellerGrades(db: PrismaClient, sellerId: string, now: Date, opts: { manual?: boolean; actor?: { actorType: ActorType; actorId: string | null } } = {}): Promise<RecalcResult> {
  try {
    return await db.$transaction(async (tx) => {
      await tx.memberGradePolicy.upsert({ where: { sellerId }, create: { sellerId }, update: {} });
      const [policy] = await tx.$queryRaw<{ autoEnabled: boolean; windowMonths: number; cadence: Cadence; demotion: Demotion }[]>`
        SELECT "autoEnabled", "windowMonths", "cadence"::text AS "cadence", "demotion"::text AS "demotion" FROM "MemberGradePolicy" WHERE "sellerId" = ${sellerId}::uuid FOR UPDATE`;
      const key = runKey(policy.cadence, now);
      if (!opts.manual) {
        if (!policy.autoEnabled) return NOT_RAN;
        await tx.memberGradeRun.create({ data: { sellerId, monthKey: key, ranAt: now } });
      }
      const grades = await tx.memberGrade.findMany({ where: { sellerId }, orderBy: { sortOrder: "asc" } });
      if (grades.length === 0 || !thresholdsIncrease(grades.map((g) => g.minAmount))) throw new Skip();
      const thresholds = grades.map((g) => g.minAmount);
      const rankOf = new Map(grades.map((g, i) => [g.id, i]));
      // 끝난 고정은 지우고, 남은 고정 회원은 건너뛴다
      await tx.memberGradeOverride.deleteMany({ where: { sellerId, until: { lte: now } } });
      const locked = new Set((await tx.memberGradeOverride.findMany({ where: { sellerId }, select: { buyerMemberId: true } })).map((o) => o.buyerMemberId));
      const from = windowStart(now, policy.windowMonths);
      const sums = await tx.order.groupBy({ by: ["buyerMemberId"], where: { sellerId, status: "PAID", paidAt: { gte: from, lt: now } }, _sum: { totalAmount: true, refundAmount: true } });
      // 결제액 − 부분 환불액(결제 완료 주문에 남은 환불액, 관리자 매출 집계와 같은 기준)
      const amount = new Map(sums.map((s) => [s.buyerMemberId, Math.max(0, (s._sum.totalAmount ?? 0) - (s._sum.refundAmount ?? 0))]));
      let promoted = 0;
      let demoted = 0;
      let unchanged = 0;
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
          const cur = rankOf.get(m.gradeId);
          if (locked.has(m.id) || cur === undefined) {
            unchanged++;
            continue;
          }
          const amt = amount.get(m.id) ?? 0;
          const nxt = nextRank(cur, targetRank(thresholds, amt), policy.demotion);
          if (nxt === cur) {
            unchanged++;
            continue;
          }
          // 그사이 직접 조정한 회원(등급이 바뀜)은 건드리지 않는다
          const moved = await tx.buyerMember.updateMany({ where: { id: m.id, sellerId, gradeId: m.gradeId }, data: { gradeId: grades[nxt].id } });
          if (moved.count !== 1) {
            unchanged++;
            continue;
          }
          if (nxt > cur) promoted++;
          else demoted++;
          await tx.memberGradeHistory.create({
            data: { sellerId, buyerMemberId: m.id, fromName: grades[cur].displayName, toName: grades[nxt].displayName, reason: nxt > cur ? "AUTO_UP" : "AUTO_DOWN", amount: amt, createdAt: now, staffId: opts.actor?.actorId ?? null },
          });
          // 승급이면 그 등급의 승급 쿠폰을 한 장 준다(같은 쿠폰은 다시 주지 않음). 승급·강등 알림은 발송 채널이 정해질 때까지 발송 기록만 남긴다.
          const coupon = nxt > cur ? await grantPromotionCoupon(tx, { sellerId, buyerMemberId: m.id, gradeId: grades[nxt].id }) : "none";
          await writeAudit(tx, {
            actorType: "SYSTEM",
            actorId: null,
            sellerId,
            action: "member_grade.notice",
            targetType: "BuyerMember",
            targetId: m.id,
            after: { kind: nxt > cur ? "UP" : "DOWN", to: grades[nxt].displayName, coupon, delivered: false },
          });
        }
        if (page.length < PAGE) break;
      }
      if (!opts.manual) await tx.memberGradeRun.update({ where: { sellerId_monthKey: { sellerId, monthKey: key } }, data: { promoted, demoted } });
      await writeAudit(tx, {
        actorType: opts.actor?.actorType ?? "SYSTEM",
        actorId: opts.actor?.actorId ?? null,
        sellerId,
        action: opts.manual ? "member_grade.recalc_now" : "member_grade.recalc",
        targetType: "Seller",
        targetId: sellerId,
        after: { key, promoted, demoted, unchanged },
      });
      return { ran: true, promoted, demoted, unchanged };
    });
  } catch (e) {
    // 이 주기에 이미 돌았거나(기록 중복) 기준액이 올바르지 않아 건너뜀: 실패가 아니다
    if (isUnique(e) || e instanceof Skip) return opts.manual && e instanceof Skip ? { ...NOT_RAN, ran: false } : NOT_RAN;
    throw e;
  }
}
class Skip extends Error {}

// 「지금 재산정」(파트너스, MEMBER_POINTS): 기준 금액이 순서대로 커야 한다(아니면 invalid_thresholds_for_run).
export async function recalcNow(db: PrismaClient, ctx: TenantContext, now?: Date) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const at = now ?? (await clockNow(db));
  const grades = await db.memberGrade.findMany({ where: { sellerId: ctx.sellerId }, orderBy: { sortOrder: "asc" }, select: { minAmount: true } });
  if (!thresholdsIncrease(grades.map((g) => g.minAmount))) return fail("invalid_thresholds_for_run");
  const r = await recalcSellerGrades(db, ctx.sellerId, at, { manual: true, actor: { actorType: ctx.actorType as ActorType, actorId: ctx.actorId } });
  return { ok: true as const, ...r };
}

// 정기 실행(앱 안 스케줄러가 매시간 부름): 자동 재산정을 켠 쇼핑몰 중 이 주기에 아직 돌지 않은 곳을 하나씩 처리한다. 처리한 쇼핑몰 수를 돌려준다.
export async function recalcMonthlyGrades(db: PrismaClient, now = new Date()): Promise<number> {
  const policies = await db.memberGradePolicy.findMany({ where: { autoEnabled: true }, select: { sellerId: true, cadence: true } });
  if (policies.length === 0) return 0;
  const keys = [...new Set(policies.map((p) => runKey(p.cadence, now)))];
  const ran = await db.memberGradeRun.findMany({ where: { sellerId: { in: policies.map((p) => p.sellerId) }, monthKey: { in: keys } }, select: { sellerId: true, monthKey: true } });
  const done = new Set(ran.map((r) => `${r.sellerId}:${r.monthKey}`));
  let count = 0;
  for (const p of policies) {
    if (done.has(`${p.sellerId}:${runKey(p.cadence, now)}`)) continue;
    try {
      if ((await recalcSellerGrades(db, p.sellerId, now)).ran) count++;
    } catch (e) {
      console.error("[member_grade.recalc_failed]", p.sellerId, e);
    }
  }
  return count;
}
