import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { formatCsv } from "../shop-bulk-io/csv";
import { requireSellerRead, type TenantContext } from "../tenant/context";

// 구독·결제 화면(SA-090 청구 내역)의 합친 행: 구독료 청구(월 구독·첫 결제)·차액 청구·발송·이용 충전을 시간순으로, 맨 위에 다음 결제 예정 1건.
// 기존 payments 배열은 그대로 두고 이 배열만 새로 준다(billingRows). 매출전표는 receiptUrl(없으면 null).
export type BillingRowKind = "SUBSCRIPTION" | "PRORATION" | "MESSAGE_CHARGE";
export type BillingRowState = "SCHEDULED" | "PENDING" | "PAID" | "FAILED";
export type BillingRow = { id: string; kind: BillingRowKind; billingMonth: string; state: BillingRowState; amount: number; at: Date; receiptUrl: string | null };

export const BILLING_ROWS_VIEW_LIMIT = 24;
export const BILLING_EXPORT_MAX = 5000;
const KST_MS = 9 * 3_600_000;
// 청구월: 한국 시간 기준 YYYY-MM
export const kstMonth = (d: Date) => new Date(d.getTime() + KST_MS).toISOString().slice(0, 7);

type Db = PrismaClient;

// 지금까지의 청구·충전을 최신순으로(최대 limit). 예정 행은 호출하는 쪽이 따로 붙인다.
export async function listBillingRows(db: Db, sellerId: string, limit: number): Promise<BillingRow[]> {
  const [payments, charges] = await Promise.all([
    db.subscriptionPayment.findMany({ where: { sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit }),
    db.messageCharge.findMany({ where: { sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit }),
  ]);
  const rows: BillingRow[] = [
    ...payments.map((p) => ({
      id: p.id,
      kind: (p.kind === "PRORATION" ? "PRORATION" : "SUBSCRIPTION") as BillingRowKind,
      billingMonth: kstMonth(p.periodStart),
      state: p.status as BillingRowState,
      amount: p.amount,
      at: p.paidAt ?? p.createdAt,
      receiptUrl: p.receiptUrl,
    })),
    ...charges.map((c) => ({
      id: c.id,
      kind: "MESSAGE_CHARGE" as BillingRowKind,
      billingMonth: kstMonth(c.createdAt),
      state: c.status as BillingRowState,
      amount: c.amount,
      at: c.finishedAt ?? c.createdAt,
      receiptUrl: c.receiptUrl,
    })),
  ];
  return rows.sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id)).slice(0, limit);
}

// 다음 결제 예정 1건. 결제한 기간이 남은 자동결제 정상 구독(해지 예약·연체·체험 카드만·종료 아님)만. amount는 화면 plan.nextAmount와 같은 값.
export function scheduledBillingRow(
  sub: { id: string; status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null; nextChargeAt: Date | null } | null,
  nextAmount: number | null,
  now: Date,
): BillingRow | null {
  if (!sub || sub.status !== "ACTIVE" || sub.cancelAtPeriodEnd || !sub.currentPeriodEnd || sub.currentPeriodEnd <= now || !sub.nextChargeAt || nextAmount === null) return null;
  return { id: `scheduled:${sub.id}`, kind: "SUBSCRIPTION", billingMonth: kstMonth(sub.currentPeriodEnd), state: "SCHEDULED", amount: nextAmount, at: sub.nextChargeAt, receiptUrl: null };
}

const KIND_TEXT: Record<BillingRowKind, string> = { SUBSCRIPTION: "월 구독", PRORATION: "이용권 변경 차액", MESSAGE_CHARGE: "발송·이용 충전" };
const STATE_TEXT: Record<BillingRowState, string> = { SCHEDULED: "예정", PENDING: "결제 확인 중", PAID: "결제 완료", FAILED: "결제 실패" };
const pad = (n: number) => String(n).padStart(2, "0");
const kstDateTime = (d: Date) => {
  const t = new Date(d.getTime() + KST_MS);
  return `${t.getUTCFullYear()}.${pad(t.getUTCMonth() + 1)}.${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
};

// 청구 내역 엑셀(CSV): 본인 쇼핑몰 전체(최대 5,000줄), UTF-8(BOM). 열: 청구월·항목·금액·결제일·상태. 예정 행은 넣지 않는다(결제 전).
// 대표자만(SUBSCRIPTION_MANAGE 조회), 내려받은 사실은 로그 추적(billing.export)에 줄 수와 함께 남는다.
export async function exportBillingRows(db: Db, ctx: TenantContext, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  requireSellerRead(ctx, "SUBSCRIPTION_MANAGE");
  const rows = await listBillingRows(db, ctx.sellerId, BILLING_EXPORT_MAX + 1);
  const truncated = rows.length > BILLING_EXPORT_MAX;
  const out = rows.slice(0, BILLING_EXPORT_MAX);
  const csv = formatCsv([
    ["청구월", "항목", "금액", "결제일", "상태"],
    ...out.map((r) => [r.billingMonth.replace("-", "."), KIND_TEXT[r.kind], String(r.amount), kstDateTime(r.at), STATE_TEXT[r.state]]),
  ]);
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "billing.export",
    targetType: "Seller",
    targetId: ctx.sellerId,
    after: { rows: out.length, truncated },
    ip: meta.ip ?? undefined,
    userAgent: meta.userAgent ?? undefined,
  });
  return { ok: true as const, csv, rows: out.length, truncated };
}
