import type { MessageChannel, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { balanceOf, channelPrices, messageSettings } from "../messaging/balance";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 배송 자동화(SA-082): 기능별 켜기/끄기, 건당 단가, 이번 달 사용 건수·금액, 발송·이용 충전금 잔액.
// - 기능 4개: invoiceIssue(송장 자동 발급) · invoiceLabel(송장 출력) · deliveryTracking(배송 자동 조회) · returnInvoice(반품 송장 연동).
//   배송 자동 조회는 주문 정책 autoTrackingEnabled가 정본이라 읽고 쓰는 곳만 여기다(두 화면이 같은 값을 본다). 나머지는 SellerShippingAutomation.
// - 단가는 마스터 관리자가 정한 채널 단가(messaging/balance.ts): 송장 자동 발급·반품 송장 연동 = INVOICE_ISSUE, 송장 출력 = INVOICE_LABEL, 배송 자동 조회 = DELIVERY_TRACKING.
// - 이번 달(KST) 사용은 원장의 성공한 차감(DEBIT·SUCCEEDED)에서 센다. 반품 송장 연동은 아직 따로 세는 채널이 없어 0으로 준다.
// - 켜고 꺼도 충전금을 쓰지 않는다(쓰는 것은 실제 호출 때). 끄면 이미 쓴 금액·이미 발급된 송장은 그대로다.
// - 권한: 보기·바꾸기 모두 「쇼핑몰 설정」(SHOP_SETTINGS). 요금제는 쇼핑몰 통합(STORE_OPERATIONS)이 필요하다(라우트 가드, 403 plan_feature_required).

type Meta = { ip?: string | null; userAgent?: string | null };
type Db = PrismaClient | Prisma.TransactionClient;

export const AUTOMATION_FEATURES = ["invoiceIssue", "invoiceLabel", "deliveryTracking", "returnInvoice"] as const;
export type AutomationFeature = (typeof AUTOMATION_FEATURES)[number];

const CHANNEL: Record<AutomationFeature, MessageChannel> = {
  invoiceIssue: "INVOICE_ISSUE",
  invoiceLabel: "INVOICE_LABEL",
  deliveryTracking: "DELIVERY_TRACKING",
  returnInvoice: "INVOICE_ISSUE",
};
// 이번 달 사용을 따로 세는 채널(반품 송장 연동은 INVOICE_ISSUE를 송장 자동 발급과 같이 쓰므로 세지 않는다)
const COUNTED: Partial<Record<AutomationFeature, MessageChannel>> = { invoiceIssue: "INVOICE_ISSUE", invoiceLabel: "INVOICE_LABEL", deliveryTracking: "DELIVERY_TRACKING" };

export const AUTOMATION_MESSAGES = {
  invalid_automation: "배송 자동화 설정을 다시 확인해 주십시오",
} as const;
export type AutomationRejection = keyof typeof AUTOMATION_MESSAGES;

// 이번 달(KST) 시작 시각
function kstMonthStart(now: Date): Date {
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 1) - 9 * 3_600_000);
}

async function states(db: Db, sellerId: string): Promise<Record<AutomationFeature, boolean>> {
  const [row, policy] = await Promise.all([
    db.sellerShippingAutomation.findUnique({ where: { sellerId } }),
    db.sellerOrderPolicy.findUnique({ where: { sellerId }, select: { autoTrackingEnabled: true } }),
  ]);
  return {
    invoiceIssue: row?.invoiceIssueEnabled ?? false,
    invoiceLabel: row?.invoiceLabelEnabled ?? false,
    deliveryTracking: policy?.autoTrackingEnabled ?? false,
    returnInvoice: row?.returnInvoiceEnabled ?? false,
  };
}

export async function readShippingAutomation(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  const now = await dbNow(db);
  const [on, prices, balance, settings, usage, shortages] = await Promise.all([
    states(db, ctx.sellerId),
    channelPrices(db, now),
    balanceOf(db, ctx.sellerId),
    messageSettings(db),
    db.sellerMessageLedger.groupBy({
      by: ["channel"],
      where: { sellerId: ctx.sellerId, type: "DEBIT", status: "SUCCEEDED", channel: { in: ["INVOICE_ISSUE", "INVOICE_LABEL", "DELIVERY_TRACKING"] }, createdAt: { gte: kstMonthStart(now) } },
      _sum: { quantity: true, paidAmount: true, freeAmount: true },
    }),
    db.messageShortage.findMany({ where: { sellerId: ctx.sellerId, resolvedAt: null, channel: { in: ["INVOICE_ISSUE", "INVOICE_LABEL", "DELIVERY_TRACKING"] } }, select: { channel: true, reason: true } }),
  ]);
  const features = AUTOMATION_FEATURES.map((feature) => {
    const channel = CHANNEL[feature];
    const counted = COUNTED[feature];
    const u = counted ? usage.find((x) => x.channel === counted) : undefined;
    return {
      feature,
      enabled: on[feature],
      unitPrice: prices.find((p) => p.channel === channel)?.unitPrice ?? 0,
      monthCount: u?._sum.quantity ?? 0,
      // 차감은 원장에서 음수다
      monthAmount: u ? -((u._sum.paidAmount ?? 0) + (u._sum.freeAmount ?? 0)) : 0,
    };
  });
  return {
    features,
    enabledCount: features.filter((f) => f.enabled).length,
    monthCount: features.reduce((n, f) => n + f.monthCount, 0),
    monthAmount: features.reduce((n, f) => n + f.monthAmount, 0),
    // 발송·이용 충전금 잔액과 충전 기능 켜짐 여부. 켜 둔 기능 중 부족해 멈춘 것은 shortage에(주문 처리는 계속)
    balance: balance.total,
    chargingEnabled: settings.chargingEnabled,
    // 꺼 둔 기능은 멈춘 것이 아니므로 뺀다(열린 부족 기록이 남아 있어도)
    shortage: AUTOMATION_FEATURES.filter((f) => on[f] && shortages.some((s) => s.channel === CHANNEL[f])),
  };
}

// 본문 { invoiceIssue?, invoiceLabel?, deliveryTracking?, returnInvoice? }(boolean). 빼면 지금 값 유지, 하나도 없거나 boolean이 아니면 400.
export async function updateShippingAutomation(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: Meta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const next: Partial<Record<AutomationFeature, boolean>> = {};
  for (const f of AUTOMATION_FEATURES) {
    if (b[f] === undefined) continue;
    if (typeof b[f] !== "boolean") return { ok: false as const, reason: "invalid_automation" as const };
    next[f] = b[f] as boolean;
  }
  if (Object.keys(next).length === 0) return { ok: false as const, reason: "invalid_automation" as const };
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shipping_automation:${ctx.sellerId}`}))`;
    const before = await states(tx, ctx.sellerId);
    const after = { ...before, ...next };
    const changed = AUTOMATION_FEATURES.filter((f) => before[f] !== after[f]);
    if (changed.length === 0) return;
    // 송장 자동 발급·송장 출력·반품 송장 연동은 이 표, 배송 자동 조회는 주문 정책(정본)
    const mine = { invoiceIssueEnabled: after.invoiceIssue, invoiceLabelEnabled: after.invoiceLabel, returnInvoiceEnabled: after.returnInvoice };
    if (changed.some((f) => f !== "deliveryTracking")) {
      await tx.sellerShippingAutomation.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...mine }, update: mine });
    }
    if (changed.includes("deliveryTracking")) {
      // 주문 정책 화면에서 저장한 적 없는 기본 행이면 savedAt은 비워 둔다(온보딩 「주문 정책」 완료 판정을 건드리지 않음)
      await tx.sellerOrderPolicy.upsert({
        where: { sellerId: ctx.sellerId },
        create: { sellerId: ctx.sellerId, autoTrackingEnabled: after.deliveryTracking },
        update: { autoTrackingEnabled: after.deliveryTracking },
      });
    }
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.shipping_automation.update",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before: Object.fromEntries(changed.map((f) => [f, before[f]])),
      after: Object.fromEntries(changed.map((f) => [f, after[f]])),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true as const, ...(await readShippingAutomation(db, ctx)) };
}
