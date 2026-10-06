import { Prisma, type PrismaClient } from "@prisma/client";
import { ledgerKind } from "../seller-settings/rewardLedger";
import { decodeCursor, encodeCursor } from "../orders/read";
import { REWARD_EXPIRE_YEARS, REWARD_EXPIRY_NOTICE_DAYS, lastEarnSql } from "./expire";

// 구매자 본인의 적립금 내역·곧 소멸(SH-023 내 적립금). 본인(sellerId·buyerMemberId) 값만 읽고, 내부 메모(reason)·상태·시험 모드 값은 내보내지 않는다.
// 내역: 처리 끝난(SUCCEEDED) 실지급(testMode=false) 원장만. 대기·실패는 잔액에 반영되지 않아 보이지 않는다. 최신순 (createdAt, id) 커서.
// 탭: earn(적립·인기 카드 보너스·양수 조정) · use(사용·사용 취소로 돌려받음) · clawback(회수·음수 조정) · expire(소멸).
export const BUYER_REWARD_TABS = ["all", "earn", "use", "clawback", "expire"] as const;
export type BuyerRewardTab = (typeof BUYER_REWARD_TABS)[number];
export type BuyerRewardEntryType = "earn" | "use" | "clawback" | "expire";
export const BUYER_REWARD_PAGE_DEFAULT = 20;
export const BUYER_REWARD_PAGE_MAX = 50;

type Scope = { sellerId: string; buyerMemberId: string };

function tabWhere(tab: BuyerRewardTab): Prisma.RewardLedgerWhereInput {
  switch (tab) {
    case "earn":
      return { OR: [{ type: { in: ["EARN", "RANKING_BONUS"] } }, { type: "ADJUST", amount: { gt: 0 } }] };
    case "use":
      return { type: "USE" };
    case "clawback":
      return { OR: [{ type: "REVOKE" }, { type: "ADJUST", amount: { lt: 0 } }] };
    case "expire":
      return { type: "EXPIRE" };
    default:
      return {};
  }
}

function entryType(type: string, amount: number): BuyerRewardEntryType {
  if (type === "USE") return "use";
  if (type === "EXPIRE") return "expire";
  if (type === "REVOKE" || (type === "ADJUST" && amount < 0)) return "clawback";
  return "earn";
}

const rateLabel = (rate: number) => `${Number(rate.toFixed(2))}%`;

export async function listBuyerRewardLedger(db: PrismaClient, scope: Scope, query: { type?: string | null; cursor?: string | null; limit?: string | null }) {
  const tab = (query.type || "all") as BuyerRewardTab;
  if (!BUYER_REWARD_TABS.includes(tab)) return { ok: false as const };
  const limit = query.limit == null || query.limit === "" ? BUYER_REWARD_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, BUYER_REWARD_PAGE_MAX);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };

  const and: Prisma.RewardLedgerWhereInput[] = [{ ...scope, status: "SUCCEEDED", testMode: false }, tabWhere(tab)];
  if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
  const rows = await db.rewardLedger.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: { id: true, type: true, amount: true, idempotencyKey: true, createdAt: true, order: { select: { id: true, rewardEarnTiming: true, rewardGradeId: true, rewardRate: true } } },
  });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];

  const orderIds = [...new Set(page.flatMap((r) => (r.order ? [r.order.id] : [])))];
  const gradeIds = [...new Set(page.flatMap((r) => (r.order?.rewardGradeId ? [r.order.rewardGradeId] : [])))];
  const [items, grades] = await Promise.all([
    orderIds.length
      ? db.orderItem.findMany({ where: { sellerId: scope.sellerId, orderId: { in: orderIds } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { orderId: true, productNameSnapshot: true } })
      : [],
    gradeIds.length ? db.memberGrade.findMany({ where: { sellerId: scope.sellerId, id: { in: gradeIds } }, select: { id: true, displayName: true } }) : [],
  ]);
  const summary = new Map<string, { first: string; count: number }>();
  for (const i of items) {
    const cur = summary.get(i.orderId);
    if (cur) cur.count += 1;
    else summary.set(i.orderId, { first: i.productNameSnapshot, count: 1 });
  }
  const gradeName = new Map(grades.map((g) => [g.id, g.displayName]));

  return {
    ok: true as const,
    items: page.map((r) => {
      const kind = ledgerKind({ type: r.type, amount: r.amount, idempotencyKey: r.idempotencyKey, order: r.order ? { rewardEarnTiming: r.order.rewardEarnTiming } : null });
      const g = r.order?.rewardGradeId ? gradeName.get(r.order.rewardGradeId) : null;
      const rate = g && r.order?.rewardRate ? ` (${g} ${rateLabel(r.order.rewardRate)})` : "";
      let text: string;
      switch (kind) {
        case "EARN_DELIVERY":
          text = `개봉 완료 적립${rate}`;
          break;
        case "EARN_PAYMENT":
          text = `결제 적립${rate}`;
          break;
        case "REVIEW":
          text = "리뷰 적립";
          break;
        case "BONUS":
          text = "명예의 전당 1위 보너스";
          break;
        case "ADJUST_GRANT":
        case "ADJUST_REVOKE":
          text = "운영 조정";
          break;
        case "REVOKE":
          text = r.idempotencyKey.startsWith("review_revoke:") ? "리뷰 변경으로 회수" : "주문 취소로 회수";
          break;
        case "USE":
          text = r.amount > 0 ? "주문 취소로 돌려받음" : "주문에 사용";
          break;
        default:
          text = `소멸(${REWARD_EXPIRE_YEARS}년간 적립 없음)`;
      }
      const s = r.order ? summary.get(r.order.id) : null;
      return {
        id: r.id,
        at: r.createdAt,
        type: entryType(r.type, r.amount),
        text,
        productSummary: s ? (s.count > 1 ? `${s.first} 외 ${s.count - 1}` : s.first) : null,
        amount: r.amount,
      };
    }),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

// 곧 소멸: 소멸은 「마지막 적립 + 3년」에 남은 잔액 전체라 amount는 지금 잔액, expiresAt은 마지막 적립 + 3년.
// 소멸 30일 전부터(안내 기준과 같음) 값이 있고, 잔액이 0이거나 아직 멀거나 적립 기록이 없으면 null.
export async function readBuyerRewardExpiringSoon(db: PrismaClient, scope: Scope, now: Date = new Date()): Promise<{ amount: number; expiresAt: Date } | null> {
  const [row] = await db.$queryRaw<{ balance: number; expiresAt: Date }[]>`
    SELECT b."balance", e."at" + make_interval(years => ${REWARD_EXPIRE_YEARS}::int) AS "expiresAt"
    FROM "RewardBalance" b CROSS JOIN LATERAL (${lastEarnSql()}) e
    WHERE b."sellerId" = ${scope.sellerId}::uuid AND b."buyerMemberId" = ${scope.buyerMemberId}::uuid
      AND b."balance" > 0 AND e."at" IS NOT NULL
      AND e."at" + make_interval(years => ${REWARD_EXPIRE_YEARS}::int) > ${now}
      AND e."at" + make_interval(years => ${REWARD_EXPIRE_YEARS}::int, days => ${-REWARD_EXPIRY_NOTICE_DAYS}::int) <= ${now}`;
  return row ? { amount: row.balance, expiresAt: row.expiresAt } : null;
}
