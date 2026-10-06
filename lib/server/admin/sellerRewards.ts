import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { kstDayStart } from "../orders/read";
import { kstDate } from "../stats/range";
import { REWARD_EXPIRE_YEARS } from "../rewards/expire";
import { listLivePayoutHistoryOf } from "../rewards/livePayoutAdmin";
import { RATE_MAX } from "../rewards/policyAdmin";
import type { RewardRates } from "../rewards/earn";

// 마스터 관리자 파트너스 상세 「적립금 설정」 탭(MA-012-7, platform.read, 읽기 전용). 플랫폼은 설정을 보고 이상 징후만 살피며 스위치는 파트너스만 조작한다.
// 판매자 격리: 모든 조회가 sellerId로 묶인다. 마스터 관리자 전 역할(조회 전용 포함)이 읽는다. 회원 개인정보는 나가지 않는다(회원 수·합계만).
const DAY_MS = 86_400_000;
const FAILED_WINDOW_DAYS = 30; // 지급 실패는 최근 N일
// 이상 징후 기준
const BALANCE_RATIO_MAX = 25; // 잔액 총액 / 이번 달 거래액(%) 초과
const CONCENTRATION_MAX = 30; // 한 회원이 잔액 총액에서 차지하는 비율(%) 초과
const FAIL_REPEAT_MIN = 3; // 최근 30일 지급 실패 N건 이상

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const flag = (on: boolean) => (on ? ("WARN" as const) : ("OK" as const));

// 없는 파트너스는 null.
// policy: 적립 정책(등급별 카드·무통장 적립률과 회원 수, 지급 시점, 회수 모드, 사용 조건, 1위 보너스). 유효 기간은 정책 값이 아니라 플랫폼 고정(마지막 적립 뒤 expiryYears년, 대표님 결정 2026-10-03).
// limits.withinLimits = 모든 적립률이 플랫폼 상한(rateMax %) 이하. 정책을 저장하지 않았으면 policy.saved=false.
// totals: 발행 잔액 총액, 이번 달(KST) 지급·사용(처리 완료 기준, 사용은 반환 반영 순액), 지급 대기, 지급 실패(최근 30일, 탈퇴 회원으로 닫힌 줄 제외).
// anomalies: balanceRatio(잔액 총액 ÷ 이번 달 거래액 %, 기준 초과면 WARN) · manualGrant(이번 달 수동 지급 건수·금액, 참고용 항상 OK) · concentration(최대 잔액 1명의 비율 %) · failRepeat(지급 실패 반복 건수).
// history: 실제 지급 켜기·끄기 전환 이력 최근 20건(파트너스 SA-034와 같은 값).
export async function getSellerRewards(db: PrismaClient, admin: AdminSessionContext, sellerId: string) {
  requireRead(admin);
  if (!(await db.seller.findUnique({ where: { id: sellerId }, select: { id: true } }))) return null;
  const now = await dbNow(db);
  const monthStart = kstDayStart(`${kstDate(now).slice(0, 7)}-01`)!;
  const failedSince = new Date(now.getTime() - FAILED_WINDOW_DAYS * DAY_MS);
  const done = { sellerId, status: "SUCCEEDED" as const, processedAt: { gte: monthStart } };
  const [policy, grades, memberGroups, balanceSum, topBalance, granted, ranked, adjusted, used, pending, failed, monthPaid, historyRes] = await Promise.all([
    db.rewardPolicy.findUnique({ where: { sellerId } }),
    db.memberGrade.findMany({ where: { sellerId }, orderBy: { sortOrder: "asc" }, select: { id: true, displayName: true } }),
    db.buyerMember.groupBy({ by: ["gradeId"], where: { sellerId, status: { not: "WITHDRAWN" } }, _count: true }),
    db.rewardBalance.aggregate({ where: { sellerId }, _sum: { balance: true } }),
    db.rewardBalance.findFirst({ where: { sellerId }, orderBy: [{ balance: "desc" }, { buyerMemberId: "asc" }], select: { balance: true } }),
    db.rewardLedger.aggregate({ where: { ...done, type: "EARN", amount: { gt: 0 } }, _sum: { amount: true } }),
    db.rewardLedger.aggregate({ where: { ...done, type: "RANKING_BONUS", amount: { gt: 0 } }, _sum: { amount: true } }),
    db.rewardLedger.aggregate({ where: { ...done, type: "ADJUST", amount: { gt: 0 } }, _count: true, _sum: { amount: true } }),
    db.rewardLedger.aggregate({ where: { ...done, type: "USE" }, _sum: { amount: true } }),
    db.rewardLedger.aggregate({ where: { sellerId, status: "PENDING", amount: { gt: 0 } }, _count: true, _sum: { amount: true } }),
    db.rewardLedger.aggregate({ where: { sellerId, status: "FAILED", OR: [{ failureReason: null }, { failureReason: { not: "member_withdrawn" } }], processedAt: { gte: failedSince } }, _count: true, _sum: { amount: true } }),
    db.order.aggregate({ where: { sellerId, paidAt: { gte: monthStart } }, _sum: { totalAmount: true, refundAmount: true } }),
    listLivePayoutHistoryOf(db, sellerId, { limit: "20" }),
  ]);
  const rates = (policy?.rates && typeof policy.rates === "object" ? policy.rates : {}) as RewardRates;
  const counts = new Map(memberGroups.map((g) => [g.gradeId, g._count]));
  const changedBy = policy?.livePayoutChangedBy ? await db.sellerUser.findFirst({ where: { id: policy.livePayoutChangedBy, sellerId }, select: { name: true } }) : null;
  const balance = balanceSum._sum.balance ?? 0;
  const monthAmount = (monthPaid._sum.totalAmount ?? 0) - (monthPaid._sum.refundAmount ?? 0);
  const balanceRatio = pct(balance, monthAmount);
  const concentration = pct(topBalance?.balance ?? 0, balance);
  const failedCount = failed._count;
  return {
    policy: {
      saved: policy != null,
      earnTiming: policy?.earnTiming ?? null,
      revokeMode: policy?.revokeMode ?? null,
      expiryYears: REWARD_EXPIRE_YEARS,
      useMinAmount: policy?.useMinAmount ?? null,
      useMaxRatio: policy?.useMaxRatio ?? null,
      rankingBonus: { enabled: policy?.rankingBonusEnabled ?? false, amount: policy?.rankingBonusAmount ?? 0 },
      grades: grades.map((g) => ({ id: g.id, name: g.displayName, cardRate: rates[g.id]?.card ?? 0, bankTransferRate: rates[g.id]?.bankTransfer ?? 0, members: counts.get(g.id) ?? 0 })),
    },
    limits: {
      rateMax: RATE_MAX,
      withinLimits: Object.values(rates).every((r) => (r.card ?? 0) <= RATE_MAX && (r.bankTransfer ?? 0) <= RATE_MAX),
    },
    livePayout: { enabled: policy?.livePayoutEnabled ?? false, changedAt: policy?.livePayoutChangedAt ?? null, changedByName: changedBy?.name ?? null },
    totals: {
      balance,
      monthGranted: (granted._sum.amount ?? 0) + (ranked._sum.amount ?? 0) + (adjusted._sum.amount ?? 0),
      monthUsed: -(used._sum.amount ?? 0),
      pending: { count: pending._count, amount: pending._sum.amount ?? 0 },
      failed: { count: failedCount, amount: Math.abs(failed._sum.amount ?? 0), sinceDays: FAILED_WINDOW_DAYS },
      since: monthStart,
    },
    history: historyRes.ok ? historyRes.history : [],
    anomalies: {
      balanceRatio: { status: flag(balanceRatio != null && balanceRatio > BALANCE_RATIO_MAX), ratio: balanceRatio, threshold: BALANCE_RATIO_MAX },
      manualGrant: { status: "OK" as const, count: adjusted._count, amount: adjusted._sum.amount ?? 0 },
      concentration: { status: flag(concentration != null && concentration > CONCENTRATION_MAX), ratio: concentration, threshold: CONCENTRATION_MAX },
      failRepeat: { status: flag(failedCount >= FAIL_REPEAT_MIN), count: failedCount, threshold: FAIL_REPEAT_MIN },
    },
  };
}
