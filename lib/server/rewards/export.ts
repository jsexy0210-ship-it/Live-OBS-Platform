import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { formatCsv, guardText } from "../shop-bulk-io/csv";
import { listRewardBalances } from "../seller-settings/rewardBalances";
import { listRewardLedger, type LedgerKind, type RewardLedgerQuery } from "../seller-settings/rewardLedger";
import { requireSellerRead, type TenantContext } from "../tenant/context";

// 적립금 엑셀(CSV) 내려받기(SA-032 원장·SA-033 회원별 잔액, MEMBER_POINTS 조회 권한). 화면 목록과 같은 조건·같은 값을 최대 5,000줄까지 UTF-8(BOM) CSV로 준다.
// 회원은 방송 닉네임만 넣는다(이름·연락처·이메일은 넣지 않는다). 시작이 = + - @ 인 글자는 앞에 작은따옴표를 붙여 엑셀 수식으로 읽히지 않게 한다.
// 내려받은 사실은 로그 추적(reward.ledger.export·reward.balances.export)에 줄 수·조건과 함께 남는다.
export const REWARD_EXPORT_MAX = 5000;
const PAGE = 200;
const KST_MS = 9 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");
const kst = (d: Date | null) => {
  if (!d) return "";
  const t = new Date(d.getTime() + KST_MS);
  return `${t.getUTCFullYear()}.${pad(t.getUTCMonth() + 1)}.${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};

const KIND_TEXT: Record<LedgerKind, string> = {
  EARN_DELIVERY: "배송 완료 적립",
  EARN_PAYMENT: "결제 적립",
  REVIEW: "리뷰 적립",
  REVOKE: "회수",
  ADJUST_GRANT: "수동 지급",
  ADJUST_REVOKE: "수동 회수",
  BONUS: "인기 카드 보너스",
  USE: "사용",
  EXPIRE: "소멸",
};
const STATUS_TEXT = { PENDING: "대기", SUCCEEDED: "성공", FAILED: "실패" } as const;
const FAIL_TEXT: Record<string, string> = { member_withdrawn: "탈퇴 회원", insufficient_balance: "잔액 부족", balance_overflow: "한도 초과" };
const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

type Meta = { ip?: string | null; userAgent?: string | null };

export async function exportRewardLedger(db: PrismaClient, ctx: TenantContext, query: RewardLedgerQuery, meta: Meta = {}) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const rows: NonNullable<Awaited<ReturnType<typeof listRewardLedger>> extends infer R ? (R extends { ok: true; entries: infer E } ? E : never) : never> = [];
  let cursor: string | null = null;
  let truncated = false;
  while (true) {
    const page = await listRewardLedger(db, ctx, { ...query, cursor, limit: String(PAGE) });
    if (!page.ok) return { ok: false as const };
    for (const e of page.entries) {
      if (rows.length >= REWARD_EXPORT_MAX) {
        truncated = true;
        break;
      }
      rows.push(e);
    }
    if (truncated || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const csv = formatCsv([
    ["회원", "일시", "유형", "사유 · 주문", "금액", "잔액(후)", "상태", "실패 사유"],
    ...rows.map((e) => {
      const orderText = e.order ? `${e.order.orderNoLabel}${e.order.firstProductName ? ` · ${e.order.firstProductName}${e.order.itemCount > 1 ? ` 외 ${e.order.itemCount - 1}` : ""}` : ""}` : "";
      return [
        guardText(e.member.broadcastNickname),
        kst(e.createdAt),
        KIND_TEXT[e.kind],
        guardText([e.reason, orderText].filter(Boolean).join(" · ")),
        sign(e.amount),
        e.balanceAfter === null ? "" : String(e.balanceAfter),
        STATUS_TEXT[e.status],
        e.failureReason ? (FAIL_TEXT[e.failureReason] ?? e.failureReason) : "",
      ];
    }),
  ]);
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "reward.ledger.export",
    targetType: "RewardLedger",
    targetId: ctx.sellerId,
    after: { rows: rows.length, truncated, filters: Object.fromEntries(Object.entries(query).filter(([k, v]) => v && k !== "cursor" && k !== "limit")) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, csv, rows: rows.length, truncated };
}

export async function exportRewardBalances(db: PrismaClient, ctx: TenantContext, query: { q?: string | null }, meta: Meta = {}) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const rows: Extract<Awaited<ReturnType<typeof listRewardBalances>>, { ok: true }>["balances"] = [];
  let cursor: string | null = null;
  let truncated = false;
  while (true) {
    const page = await listRewardBalances(db, ctx, { q: query.q ?? null, cursor, limit: String(PAGE) });
    if (!page.ok) return { ok: false as const };
    for (const b of page.balances) {
      if (rows.length >= REWARD_EXPORT_MAX) {
        truncated = true;
        break;
      }
      rows.push(b);
    }
    if (truncated || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const csv = formatCsv([
    ["회원", "잔액", "누적 지급", "누적 사용", "누적 회수", "소멸", "수동 조정", "마지막 변동"],
    ...rows.map((b) => [guardText(b.member.broadcastNickname), String(b.balance), String(b.totalEarned), String(b.totalUsed), String(b.totalRevoked), String(b.totalExpired), sign(b.totalAdjusted), kst(b.updatedAt)]),
  ]);
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "reward.balances.export",
    targetType: "RewardBalance",
    targetId: ctx.sellerId,
    after: { rows: rows.length, truncated, filters: query.q ? { q: query.q } : {} },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, csv, rows: rows.length, truncated };
}
