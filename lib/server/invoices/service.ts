import { Prisma, type ActorType, type InvoiceStatus, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { decodeCursor, encodeCursor, itemSummary, itemSummarySelect } from "../orders/read";
import { orderNoLabel } from "../orders/orderNoLabel";
import { getShippingPolicy, isCourier, COURIERS, SHIPMENT_BATCH_MAX, type Courier } from "../orders/shipping";
import { TAB_WHERE } from "../orders/shipments";
import { canViewCustomerPii, requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { formatCsv, guardText } from "../shop-bulk-io/csv";
import { invoiceProvider, type InvoiceRecipient } from "./provider";

// 송장 발급(SA-027)·출력·추적(SA-028), ORDER_SHIPPING 권한. 배송 접수 업체가 정해지기 전이라 발급·추적은 모의 어댑터(provider.ts)다.
// - 대상 주문: 배송 목록 「발송 대기」와 같은 조건(결제 완료·즉시 발송·재고 차감됨·배송지 있음·발송 전)이면서 아직 송장에 묶이지 않은 주문.
// - 합배송: 받는 분·연락처·주소가 같은 주문을 상자 하나(송장 하나)로 묶는다(bundle=true가 「묶기」 확인). 우편번호·주소가 없는 주문은 발급에서 빠진다.
// - 발급은 3단계: ① 주문을 잠그고 송장 행(FAILED·발급 중)과 주문 묶음을 만든다 ② 잠금 밖에서 어댑터를 부른다 ③ 번호를 적고 발급됨으로 바꾼다(또는 실패 사유를 남긴다).
//   ②에서 멈춰도 송장은 FAILED로 남아 「실패 건 다시 발급」으로 이어진다.
// - 출력하면 PRINTED, 집하·배송 완료는 어댑터의 추적 이벤트를 동기화해 바꾼다(출력 전 송장은 집하되지 않는다). 모의 송장은 주문 상태·배송 레코드·구매자 안내를 바꾸지 않는다.
// - 받는 분 이름·연락처·주소는 CUSTOMER_PII_VIEW가 있을 때만 내보내고, 내보냈으면 customer.pii.view를 남긴다. 변경은 모두 로그 추적에 남는다.
export const INVOICE_PRINT_FORMATS = ["LABEL_100X150", "A4_2UP"] as const;
export type InvoicePrintFormat = (typeof INVOICE_PRINT_FORMATS)[number];
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ["FAILED", "ISSUED", "PRINTED", "PICKED_UP", "DELIVERED"];
export const INVOICE_PAGE = 30;
export const INVOICE_EXPORT_MAX = 5000;
const ISSUING = "issuing";
const ISSUING_STALE_MS = 5 * 60_000;
const PICKUP_DELAY_MS = 24 * 3_600_000;
const SYNC_MAX = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InvoiceFailure = "not_found" | "invalid_transition" | "invalid_request" | "invalid_courier" | "invalid_format" | "provider_error";
export const INVOICE_MESSAGES: Record<InvoiceFailure, string> = {
  not_found: "송장을 찾을 수 없습니다",
  invalid_transition: "처리할 수 없는 상태입니다. 화면을 새로 고쳐 주십시오",
  invalid_request: "요청을 확인해 주십시오",
  invalid_courier: "택배사를 선택해 주십시오",
  invalid_format: "출력 방식을 확인해 주십시오",
  provider_error: "택배사 응답 오류입니다. 잠시 뒤 다시 시도해 주십시오",
};
export function invoiceStatus(reason: string): number {
  if (reason === "not_found") return 404;
  if (reason === "invalid_transition") return 409;
  return 400;
}

const actorOf = (ctx: TenantContext) => ({ actorType: ctx.actorType as ActorType, actorId: ctx.actorId, sellerId: ctx.sellerId });
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
function idList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > SHIPMENT_BATCH_MAX || v.some((i) => !isUuid(i))) return null;
  const ids = (v as string[]).map((i) => i.toLowerCase());
  return new Set(ids).size === ids.length ? ids : null;
}

// ───────────── 발급 계획(합배송·주소 확인) ─────────────

export type AddressIssue = "zip_missing" | "address_missing";
const ZIP = /^\d{5}$/;
const addressIssueOf = (a: { zipCode: string; address1: string }): AddressIssue | null => (!ZIP.test(a.zipCode.trim()) ? "zip_missing" : !a.address1.trim() ? "address_missing" : null);
const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const bundleKey = (a: { recipientName: string; phone: string; zipCode: string; address1: string; address2: string | null }) =>
  [norm(a.recipientName), a.phone.replace(/\D/g, ""), a.zipCode.trim(), norm(a.address1), norm(a.address2)].join("|");

const planSelect = {
  id: true,
  orderNo: true,
  status: true,
  createdAt: true,
  fulfillmentType: true,
  stockShortageAt: true,
  broadcastNicknameSnapshot: true,
  shipment: { select: { status: true } },
  invoiceLink: { select: { invoiceId: true } },
  items: itemSummarySelect,
  shippingAddress: { select: { recipientName: true, phone: true, zipCode: true, address1: true, address2: true, isRemote: true } },
} satisfies Prisma.OrderSelect;
type PlanOrder = Prisma.OrderGetPayload<{ select: typeof planSelect }>;

type Rejected = { orderId: string; reason: "not_found" | "not_ready" | "already_invoiced" };
async function loadPlan(db: PrismaClient, sellerId: string, ids: string[], bundle: boolean) {
  const found = await db.order.findMany({ where: { sellerId, legalHoldAt: null, id: { in: ids } }, select: planSelect });
  const byId = new Map(found.map((o) => [o.id, o]));
  const rejected: Rejected[] = [];
  const ready: (PlanOrder & { shippingAddress: NonNullable<PlanOrder["shippingAddress"]> })[] = [];
  for (const id of ids) {
    const o = byId.get(id);
    if (!o) rejected.push({ orderId: id, reason: "not_found" });
    else if (o.invoiceLink) rejected.push({ orderId: id, reason: "already_invoiced" });
    else if (o.status !== "PAID" || o.fulfillmentType !== "IMMEDIATE" || o.stockShortageAt || !o.shippingAddress || (o.shipment && o.shipment.status !== "READY")) rejected.push({ orderId: id, reason: "not_ready" });
    else ready.push(o as (typeof ready)[number]);
  }
  ready.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  const groups: { no: number; orders: typeof ready; issue: AddressIssue | null }[] = [];
  const index = new Map<string, number>();
  for (const o of ready) {
    const key = bundle ? bundleKey(o.shippingAddress) : o.id;
    let gi = index.get(key);
    if (gi === undefined) {
      gi = groups.length;
      index.set(key, gi);
      groups.push({ no: gi + 1, orders: [], issue: addressIssueOf(o.shippingAddress) });
    }
    groups[gi].orders.push(o);
  }
  return { groups, rejected };
}

// 발급 전 확인(2단계 「합배송 · 주소 확인」): 고른 주문을 묶음(상자)과 주소 확인 필요로 나눠 보여 준다. 아무것도 바꾸지 않는다.
export async function planInvoices(db: PrismaClient, ctx: TenantContext, input: { orderIds?: unknown; bundle?: unknown }) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const ids = idList(input.orderIds);
  if (!ids || (input.bundle !== undefined && typeof input.bundle !== "boolean")) return { ok: false as const, reason: "invalid_request" as const };
  const { groups, rejected } = await loadPlan(db, ctx.sellerId, ids, input.bundle === true);
  const pii = canViewCustomerPii(ctx);
  const rows = groups.flatMap((g) =>
    g.orders.map((o) => ({
      orderId: o.id,
      orderNoLabel: orderNoLabel(o.createdAt, o.orderNo),
      nickname: o.broadcastNicknameSnapshot,
      itemSummary: itemSummary(o.items),
      groupNo: g.no,
      bundleCount: g.orders.length,
      addressIssue: g.issue,
      isRemote: o.shippingAddress.isRemote,
      shippingAddress: pii ? { recipientName: o.shippingAddress.recipientName, phone: o.shippingAddress.phone, zipCode: o.shippingAddress.zipCode, address1: o.shippingAddress.address1, address2: o.shippingAddress.address2 } : null,
    })),
  );
  if (pii && rows.length > 0) {
    await writeAudit(db, { ...actorOf(ctx), action: "customer.pii.view", targetType: "InvoicePlan", reason: "invoice_plan", after: { orderIds: rows.map((r) => r.orderId), count: rows.length } });
  }
  const issuable = groups.filter((g) => !g.issue);
  return {
    ok: true as const,
    rows,
    rejected,
    summary: {
      invoices: issuable.length,
      orders: issuable.reduce((n, g) => n + g.orders.length, 0),
      addressIssues: groups.filter((g) => g.issue).reduce((n, g) => n + g.orders.length, 0),
      bundles: groups.filter((g) => g.orders.length > 1).length,
    },
  };
}

// ───────────── 발급 ─────────────

type GroupResult = { orderIds: string[]; invoiceId: string | null; ok: boolean; trackingNumber?: string; reason?: string };

// ② 어댑터를 부르고 ③ 결과를 적는다. 번호가 겹치면(유니크) 어댑터를 다시 불러 새 번호를 받는다(최대 3번).
async function finishIssue(db: PrismaClient, ctx: TenantContext, invoiceId: string, courier: Courier, orderIds: string[], recipient: InvoiceRecipient): Promise<GroupResult> {
  const provider = invoiceProvider();
  let reason = "provider_error";
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await provider.issue({ courier, sellerId: ctx.sellerId, invoiceId, orderIds, recipient });
    } catch {
      res = { ok: false as const, reason: "provider_error" };
    }
    if (!res.ok) {
      reason = res.reason;
      break;
    }
    try {
      const done = await db.$transaction(async (tx) => {
        const now = await dbNow(tx);
        const upd = await tx.shipmentInvoice.updateMany({
          where: { id: invoiceId, sellerId: ctx.sellerId, status: "FAILED", failureCode: ISSUING },
          data: { status: "ISSUED", trackingNumber: res.trackingNumber, failureCode: null, issuedAt: now, mock: provider.mock, updatedAt: now },
        });
        if (upd.count !== 1) return false;
        await tx.shipmentInvoiceEvent.create({ data: { sellerId: ctx.sellerId, invoiceId, kind: "ISSUED", at: now, source: "SELLER", note: provider.mock ? "업체 연동 전 · 모의" : null } });
        await writeAudit(tx, { ...actorOf(ctx), action: "invoice.issue", targetType: "ShipmentInvoice", targetId: invoiceId, after: { courier, orderIds, mock: provider.mock } });
        return true;
      });
      if (!done) return { orderIds, invoiceId, ok: false, reason: "invalid_transition" };
      return { orderIds, invoiceId, ok: true, trackingNumber: res.trackingNumber };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    }
  }
  await db.$transaction(async (tx) => {
    await tx.shipmentInvoice.updateMany({ where: { id: invoiceId, sellerId: ctx.sellerId, status: "FAILED" }, data: { failureCode: reason.slice(0, 60), updatedAt: await dbNow(tx) } });
    await writeAudit(tx, { ...actorOf(ctx), action: "invoice.issue_failed", targetType: "ShipmentInvoice", targetId: invoiceId, after: { courier, orderIds, reason } });
  });
  return { orderIds, invoiceId, ok: false, reason };
}

const recipientOf = (a: { recipientName: string; phone: string; zipCode: string; address1: string; address2: string | null }): InvoiceRecipient => ({ name: a.recipientName, phone: a.phone, zipCode: a.zipCode, address1: a.address1, address2: a.address2 });

// 송장 발급(3단계). courier를 빼면 배송 설정의 기본 택배사. 주소 확인이 필요한 묶음·보낼 수 없는 주문은 빠지고 결과에 이유가 남는다.
// 묶음마다 따로 처리해 결과를 돌려준다(일부 실패해도 나머지는 발급).
export async function issueInvoices(db: PrismaClient, ctx: TenantContext, input: { orderIds?: unknown; bundle?: unknown; courier?: unknown }) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  const ids = idList(input.orderIds);
  if (!ids || (input.bundle !== undefined && typeof input.bundle !== "boolean")) return { ok: false as const, reason: "invalid_request" as const };
  let courier: Courier | null = null;
  if (input.courier !== undefined && input.courier !== null) {
    if (!isCourier(input.courier)) return { ok: false as const, reason: "invalid_courier" as const };
    courier = input.courier;
  } else courier = (await getShippingPolicy(db, ctx.sellerId)).defaultCourier;
  if (!courier) return { ok: false as const, reason: "invalid_courier" as const };
  const useCourier = courier;
  const { groups, rejected } = await loadPlan(db, ctx.sellerId, ids, input.bundle === true);
  const results: GroupResult[] = [];
  const skipped: { orderIds: string[]; reason: string }[] = rejected.map((r) => ({ orderIds: [r.orderId], reason: r.reason }));
  for (const g of groups) {
    const orderIds = g.orders.map((o) => o.id);
    if (g.issue) {
      skipped.push({ orderIds, reason: g.issue });
      continue;
    }
    // ① 주문을 잠그고 아직 보낼 수 있는지 다시 확인한 뒤 송장 행(발급 중)과 묶음을 만든다
    const invoiceId = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT o."id" FROM "Order" o
        WHERE o."sellerId" = ${ctx.sellerId}::uuid AND o."id" IN (${Prisma.join(orderIds.map((id) => Prisma.sql`${id}::uuid`))})
          AND o."status" = 'PAID' AND o."fulfillmentType" = 'IMMEDIATE' AND o."stockShortageAt" IS NULL AND o."legalHoldAt" IS NULL
        ORDER BY o."id" FOR UPDATE`;
      if (locked.length !== orderIds.length) return null;
      const ok = await tx.order.count({
        where: { sellerId: ctx.sellerId, id: { in: orderIds }, invoiceLink: null, shippingAddress: { isNot: null }, OR: [{ shipment: { is: null } }, { shipment: { is: { status: "READY" } } }] },
      });
      if (ok !== orderIds.length) return null;
      const inv = await tx.shipmentInvoice.create({
        data: { sellerId: ctx.sellerId, courier: useCourier, status: "FAILED", failureCode: ISSUING, mock: invoiceProvider().mock },
        select: { id: true },
      });
      await tx.shipmentInvoiceOrder.createMany({ data: orderIds.map((orderId) => ({ sellerId: ctx.sellerId, invoiceId: inv.id, orderId })) });
      return inv.id;
    });
    if (!invoiceId) {
      skipped.push({ orderIds, reason: "not_ready" });
      continue;
    }
    results.push(await finishIssue(db, ctx, invoiceId, useCourier, orderIds, recipientOf(g.orders[0].shippingAddress)));
  }
  return { ok: true as const, courier: useCourier, courierName: COURIERS[useCourier], results, skipped, issued: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// 실패 건 다시 발급: 번호가 없는(FAILED) 송장만. 발급 중인 송장(5분 안)은 건드리지 않는다. 같은 송장을 동시에 두 번 잡을 수 없다(시도 횟수·갱신 시각 비교).
export async function retryInvoice(db: PrismaClient, ctx: TenantContext, id: string) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  const inv = await db.shipmentInvoice.findFirst({
    where: { id, sellerId: ctx.sellerId },
    select: { id: true, courier: true, status: true, attempts: true, failureCode: true, updatedAt: true, orders: { select: { order: { select: { id: true, shippingAddress: true } } } } },
  });
  if (!inv) return { ok: false as const, reason: "not_found" as const };
  const stale = Date.now() - inv.updatedAt.getTime() > ISSUING_STALE_MS;
  if (inv.status !== "FAILED" || (inv.failureCode === ISSUING && !stale) || !isCourier(inv.courier)) return { ok: false as const, reason: "invalid_transition" as const };
  const address = inv.orders[0]?.order.shippingAddress;
  if (!address) return { ok: false as const, reason: "invalid_transition" as const };
  const claim = await db.shipmentInvoice.updateMany({
    where: { id, sellerId: ctx.sellerId, status: "FAILED", attempts: inv.attempts, updatedAt: inv.updatedAt },
    data: { attempts: { increment: 1 }, failureCode: ISSUING },
  });
  if (claim.count !== 1) return { ok: false as const, reason: "invalid_transition" as const };
  const r = await finishIssue(db, ctx, id, inv.courier, inv.orders.map((o) => o.order.id), recipientOf(address));
  return { ok: true as const, result: r };
}

// ───────────── 출력 ─────────────

// 출력(라벨 프린터 100×150 · A4 2매): invoiceIds를 빼면 아직 출력하지 않은 송장(발급됨) 전부(최대 100개). 발급됨이면 출력됨으로 바꾸고 출력 시각·방식을 남긴다.
// 이미 출력한 송장은 상태를 바꾸지 않고 라벨만 다시 준다. 번호가 없는(FAILED) 송장은 거부(결과에 이유). 라벨의 받는 분 정보는 개인정보 권한이 있을 때만.
export async function printInvoices(db: PrismaClient, ctx: TenantContext, input: { invoiceIds?: unknown; format?: unknown }) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!(INVOICE_PRINT_FORMATS as readonly unknown[]).includes(input.format)) return { ok: false as const, reason: "invalid_format" as const };
  const format = input.format as InvoicePrintFormat;
  let ids: string[];
  if (input.invoiceIds === undefined || input.invoiceIds === null) {
    const unprinted = await db.shipmentInvoice.findMany({ where: { sellerId: ctx.sellerId, status: "ISSUED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: SHIPMENT_BATCH_MAX, select: { id: true } });
    ids = unprinted.map((i) => i.id);
  } else {
    const list = idList(input.invoiceIds);
    if (!list) return { ok: false as const, reason: "invalid_request" as const };
    ids = list;
  }
  const invoices = ids.length
    ? await db.shipmentInvoice.findMany({
        where: { sellerId: ctx.sellerId, id: { in: ids } },
        select: {
          id: true,
          courier: true,
          trackingNumber: true,
          status: true,
          mock: true,
          orders: { select: { order: { select: { id: true, orderNo: true, createdAt: true, broadcastNicknameSnapshot: true, items: itemSummarySelect, shippingAddress: { select: { recipientName: true, phone: true, zipCode: true, address1: true, address2: true } } } } } },
        },
      })
    : [];
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const pii = canViewCustomerPii(ctx);
  const results: { invoiceId: string; ok: boolean; reason?: string; reprint?: boolean }[] = [];
  const labels: unknown[] = [];
  const exposed: string[] = [];
  for (const id of ids) {
    const inv = byId.get(id);
    if (!inv) {
      results.push({ invoiceId: id, ok: false, reason: "not_found" });
      continue;
    }
    if (inv.status === "FAILED" || !inv.trackingNumber) {
      results.push({ invoiceId: id, ok: false, reason: "invalid_transition" });
      continue;
    }
    let reprint = inv.status !== "ISSUED";
    if (!reprint) {
      const changed = await db.$transaction(async (tx) => {
        const now = await dbNow(tx);
        const upd = await tx.shipmentInvoice.updateMany({ where: { id, sellerId: ctx.sellerId, status: "ISSUED" }, data: { status: "PRINTED", printedAt: now, printFormat: format, updatedAt: now } });
        if (upd.count !== 1) return false;
        await tx.shipmentInvoiceEvent.create({ data: { sellerId: ctx.sellerId, invoiceId: id, kind: "PRINTED", at: now, source: "SELLER", note: format === "A4_2UP" ? "A4 2매" : "라벨 프린터" } });
        await writeAudit(tx, { ...actorOf(ctx), action: "invoice.print", targetType: "ShipmentInvoice", targetId: id, after: { format } });
        return true;
      });
      reprint = !changed;
    } else {
      await writeAudit(db, { ...actorOf(ctx), action: "invoice.reprint", targetType: "ShipmentInvoice", targetId: id, after: { format } });
    }
    results.push({ invoiceId: id, ok: true, reprint });
    const first = inv.orders[0]?.order.shippingAddress;
    if (pii) exposed.push(id);
    labels.push({
      invoiceId: id,
      courier: inv.courier,
      courierName: isCourier(inv.courier) ? COURIERS[inv.courier] : inv.courier,
      trackingNumber: inv.trackingNumber,
      mock: inv.mock,
      format,
      orders: inv.orders.map((o) => ({ orderId: o.order.id, orderNoLabel: orderNoLabel(o.order.createdAt, o.order.orderNo), nickname: o.order.broadcastNicknameSnapshot, itemSummary: itemSummary(o.order.items) })),
      recipient: pii && first ? { name: first.recipientName, phone: first.phone, zipCode: first.zipCode, address1: first.address1, address2: first.address2 } : null,
    });
  }
  if (exposed.length > 0) await writeAudit(db, { ...actorOf(ctx), action: "customer.pii.view", targetType: "InvoiceLabel", reason: "invoice_print", after: { invoiceIds: exposed, count: exposed.length } });
  return { ok: true as const, format, results, labels, printed: results.filter((r) => r.ok && !r.reprint).length };
}

// ───────────── 추적 ─────────────

// 출력한 송장(출력됨·집하됨)의 어댑터 추적 이벤트를 받아 이벤트 행과 상태·집하·배송 완료 시각에 반영한다(여러 번 불러도 같은 결과, 상태는 뒤로 가지 않는다).
export async function syncInvoiceTracking(db: PrismaClient, sellerId: string, invoiceIds?: string[]) {
  const provider = invoiceProvider();
  const now = await dbNow(db);
  const rows = await db.shipmentInvoice.findMany({
    where: { sellerId, status: { in: ["PRINTED", "PICKED_UP"] }, ...(invoiceIds ? { id: { in: invoiceIds } } : {}) },
    orderBy: [{ printedAt: "asc" }, { id: "asc" }],
    take: SYNC_MAX,
    select: { id: true, courier: true, trackingNumber: true, printedAt: true },
  });
  for (const inv of rows) {
    let events;
    try {
      events = await provider.track({ courier: inv.courier, trackingNumber: inv.trackingNumber!, printedAt: inv.printedAt }, now);
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    const picked = events.find((e) => e.kind === "PICKED_UP")?.at ?? null;
    const delivered = events.find((e) => e.kind === "DELIVERED")?.at ?? null;
    await db.$transaction(async (tx) => {
      await tx.shipmentInvoiceEvent.createMany({ data: events.map((e) => ({ sellerId, invoiceId: inv.id, kind: e.kind, at: e.at, source: "CARRIER", note: e.note })), skipDuplicates: true });
      await tx.shipmentInvoice.updateMany({
        where: { id: inv.id, sellerId, status: { in: ["PRINTED", "PICKED_UP"] } },
        data: { status: delivered ? "DELIVERED" : "PICKED_UP", pickedUpAt: picked ?? delivered, deliveredAt: delivered, updatedAt: now },
      });
    });
  }
}

const listSelect = {
  id: true,
  courier: true,
  trackingNumber: true,
  status: true,
  mock: true,
  attempts: true,
  failureCode: true,
  issuedAt: true,
  printedAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  createdAt: true,
  events: { orderBy: [{ at: "desc" as const }, { createdAt: "desc" as const }], take: 1, select: { kind: true, at: true, source: true, note: true } },
  orders: { select: { order: { select: { id: true, orderNo: true, createdAt: true, broadcastNicknameSnapshot: true, items: itemSummarySelect } } }, orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.ShipmentInvoiceSelect;
type ListRow = Prisma.ShipmentInvoiceGetPayload<{ select: typeof listSelect }>;

function listView(r: ListRow, now: Date) {
  const first = r.orders[0]?.order;
  const last = r.events[0] ?? null;
  return {
    id: r.id,
    courier: r.courier,
    courierName: isCourier(r.courier) ? COURIERS[r.courier] : r.courier,
    trackingNumber: r.trackingNumber,
    status: r.status,
    mock: r.mock,
    attempts: r.attempts,
    // FAILED이면서 발급 중(issuing)이면 실패가 아니라 진행 중
    issuing: r.status === "FAILED" && r.failureCode === ISSUING,
    failureCode: r.status === "FAILED" && r.failureCode !== ISSUING ? r.failureCode : null,
    issuedAt: r.issuedAt,
    printedAt: r.printedAt,
    pickedUpAt: r.pickedUpAt,
    deliveredAt: r.deliveredAt,
    createdAt: r.createdAt,
    // 출력한 지 24시간이 지나도 집하되지 않음(집하 지연)
    pickupDelayed: r.status === "PRINTED" && r.printedAt !== null && now.getTime() - r.printedAt.getTime() > PICKUP_DELAY_MS,
    lastEvent: last,
    orderCount: r.orders.length,
    nickname: first?.broadcastNicknameSnapshot ?? null,
    firstProductName: first ? itemSummary(first.items).firstProductName : null,
    orders: r.orders.map((o) => ({ orderId: o.order.id, orderNoLabel: orderNoLabel(o.order.createdAt, o.order.orderNo) })),
  };
}

export type InvoiceListQuery = { status?: unknown; q?: unknown; cursor?: unknown; limit?: unknown };
function listWhere(sellerId: string, q: InvoiceListQuery): Prisma.ShipmentInvoiceWhereInput | null {
  const and: Prisma.ShipmentInvoiceWhereInput[] = [{ sellerId }];
  const status = INVOICE_STATUSES.find((s) => s === q.status);
  if (q.status !== undefined && q.status !== null && q.status !== "" && !status) return null;
  if (status) and.push({ status });
  const text = typeof q.q === "string" ? q.q.trim() : "";
  if (typeof q.q === "string" && text.length > 50) return null;
  if (text) {
    const num = text.replace(/[\s-]/g, "");
    and.push({ OR: [{ trackingNumber: { contains: num } }, { orders: { some: { order: { broadcastNicknameSnapshot: { contains: text, mode: "insensitive" } } } } }] });
  }
  return { AND: and };
}

// 출력·추적 목록: 상태별 건수(counts, total은 발급 전 실패를 뺀 전체), 보여 주는 송장은 최신순. 목록을 열 때마다 출력한 송장의 추적을 동기화한다.
export async function listInvoices(db: PrismaClient, ctx: TenantContext, q: InvoiceListQuery = {}) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const where = listWhere(ctx.sellerId, q);
  const cursor = typeof q.cursor === "string" && q.cursor ? decodeCursor(q.cursor) : null;
  const limit = q.limit === undefined || q.limit === null || q.limit === "" ? INVOICE_PAGE : Number(q.limit);
  if (!where || (typeof q.cursor === "string" && q.cursor && !cursor) || !Number.isInteger(limit) || limit < 1) return { ok: false as const, reason: "invalid_request" as const };
  const take = Math.min(limit, 100);
  await syncInvoiceTracking(db, ctx.sellerId);
  const now = await dbNow(db);
  const rows = await db.shipmentInvoice.findMany({
    where: cursor ? { AND: [where, { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] } : where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: listSelect,
  });
  const page = rows.slice(0, take);
  const grouped = await db.shipmentInvoice.groupBy({ by: ["status"], where: { sellerId: ctx.sellerId }, _count: { _all: true } });
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Partial<Record<InvoiceStatus, number>>;
  const last = page[page.length - 1];
  return {
    ok: true as const,
    invoices: page.map((r) => listView(r, now)),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
    counts,
    total: grouped.filter((g) => g.status !== "FAILED").reduce((n, g) => n + g._count._all, 0),
    // 화면이 「업체 연동 전 · 모의」 안내를 보일지(어댑터가 모의인지)
    mock: invoiceProvider().mock,
    // 출력하지 않은 송장 수(「출력 안 한 송장 N개 출력」)
    unprinted: counts.ISSUED ?? 0,
  };
}

// 추적 상세: 송장·묶인 주문·이벤트(최신순). 받는 분 정보는 개인정보 권한이 있을 때만.
export async function getInvoice(db: PrismaClient, ctx: TenantContext, id: string) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  if (!isUuid(id)) return null;
  await syncInvoiceTracking(db, ctx.sellerId, [id]);
  const now = await dbNow(db);
  const r = await db.shipmentInvoice.findFirst({
    where: { id, sellerId: ctx.sellerId },
    select: { ...listSelect, printFormat: true, events: { orderBy: [{ at: "desc" }, { createdAt: "desc" }], select: { kind: true, at: true, source: true, note: true } }, orders: { select: { order: { select: { id: true, orderNo: true, createdAt: true, broadcastNicknameSnapshot: true, items: itemSummarySelect, shippingAddress: { select: { recipientName: true, phone: true, zipCode: true, address1: true, address2: true } } } } }, orderBy: { createdAt: "asc" } } },
  });
  if (!r) return null;
  const pii = canViewCustomerPii(ctx);
  const first = r.orders[0]?.order.shippingAddress;
  if (pii && first) await writeAudit(db, { ...actorOf(ctx), action: "customer.pii.view", targetType: "ShipmentInvoice", targetId: id, reason: "invoice_detail", after: { count: 1 } });
  return {
    ...listView({ ...r, events: r.events.slice(0, 1) }, now),
    printFormat: r.printFormat,
    events: r.events,
    recipient: pii && first ? { name: first.recipientName, phone: first.phone, zipCode: first.zipCode, address1: first.address1, address2: first.address2 } : null,
  };
}

// 집하 요청 다시 보내기: 출력했지만 아직 집하되지 않은 송장만. 어댑터가 받으면 「집하 요청」 이벤트(시각)를 남긴다.
export async function requestInvoicePickup(db: PrismaClient, ctx: TenantContext, id: string) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  const inv = await db.shipmentInvoice.findFirst({ where: { id, sellerId: ctx.sellerId }, select: { id: true, courier: true, trackingNumber: true, status: true } });
  if (!inv) return { ok: false as const, reason: "not_found" as const };
  if (inv.status !== "PRINTED" || !inv.trackingNumber) return { ok: false as const, reason: "invalid_transition" as const };
  let res;
  try {
    res = await invoiceProvider().requestPickup({ courier: inv.courier, trackingNumber: inv.trackingNumber });
  } catch {
    res = { ok: false as const, reason: "provider_error" };
  }
  if (!res.ok) return { ok: false as const, reason: "provider_error" as const };
  await db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    await tx.shipmentInvoiceEvent.upsert({
      where: { invoiceId_kind: { invoiceId: id, kind: "PICKUP_REQUESTED" } },
      create: { sellerId: ctx.sellerId, invoiceId: id, kind: "PICKUP_REQUESTED", at: now, source: "SELLER", note: null },
      update: { at: now },
    });
    await writeAudit(tx, { ...actorOf(ctx), action: "invoice.pickup_request", targetType: "ShipmentInvoice", targetId: id });
  });
  return { ok: true as const };
}

// ───────────── 내려받기 ─────────────

const STATUS_TEXT: Record<InvoiceStatus, string> = { FAILED: "발급 실패", ISSUED: "발급됨", PRINTED: "출력됨", PICKED_UP: "집하됨", DELIVERED: "배송 완료" };
const KST_MS = 9 * 3_600_000;
const KST_TEXT = (d: Date | null) => {
  if (!d) return "";
  const k = new Date(d.getTime() + KST_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};

// 엑셀(CSV) 내려받기: 목록과 같은 조건(status·q), 최대 5,000건. 열: 택배사·송장번호·받는 분(닉네임)·주문 건수·상태·발급·출력·집하·배송 완료 시각·모의 여부. 받는 분 실명·주소는 넣지 않는다.
export async function exportInvoices(db: PrismaClient, ctx: TenantContext, q: InvoiceListQuery = {}) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const where = listWhere(ctx.sellerId, q);
  if (!where) return { ok: false as const };
  await syncInvoiceTracking(db, ctx.sellerId);
  const rows = await db.shipmentInvoice.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: INVOICE_EXPORT_MAX + 1, select: listSelect });
  const page = rows.slice(0, INVOICE_EXPORT_MAX);
  const csv = formatCsv([
    ["택배사", "송장번호", "받는 분(닉네임)", "주문 건수", "상태", "발급 시각", "출력 시각", "집하 시각", "배송 완료 시각", "모의 발급"],
    ...page.map((r) => [
      isCourier(r.courier) ? COURIERS[r.courier] : r.courier,
      r.trackingNumber ?? "",
      guardText(r.orders[0]?.order.broadcastNicknameSnapshot ?? ""),
      String(r.orders.length),
      STATUS_TEXT[r.status],
      KST_TEXT(r.issuedAt),
      KST_TEXT(r.printedAt),
      KST_TEXT(r.pickedUpAt),
      KST_TEXT(r.deliveredAt),
      r.mock ? "예" : "",
    ]),
  ]);
  await writeAudit(db, { ...actorOf(ctx), action: "invoice.export", targetType: "ShipmentInvoiceList", targetId: ctx.sellerId, after: { rows: page.length, truncated: rows.length > INVOICE_EXPORT_MAX, filters: Object.fromEntries(Object.entries(q).filter(([k, v]) => v && k !== "cursor" && k !== "limit")) } });
  return { ok: true as const, csv, rows: page.length };
}
