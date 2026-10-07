import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { Prisma, type OrderStatus } from "@prisma/client";
import { GET } from "../../app/api/admin/ops/live-broadcasts/route";
import { listLiveBroadcasts } from "../../lib/server/admin/ops";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import * as billingClock from "../../lib/server/billing/subscription";
import { prisma } from "../../lib/server/db";
import { createAdmin, createBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db.$disconnect(); await prisma.$disconnect(); });
const at = new Date("2026-10-06T15:00:10.000Z"); // KST 자정 직후, 최근 60초는 전날까지 포함
const before = (ms: number) => new Date(at.getTime() - ms);
async function viewer(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "READ_ONLY") {
  const a = await createAdmin(role);
  const session = await createAdminSession(db, a.id, {});
  const ctx = await resolveAdminSession(db, session.token);
  if (!ctx) throw new Error("missing admin");
  return { ctx, cookie: `lo_admin=${session.token}` };
}
async function shop() {
  const s = await createSeller();
  return { ...s, buyer: await createBuyer(s.seller.id, s.grade.id) };
}
let orderNo = 0;
function order(s: Awaited<ReturnType<typeof shop>>, createdAt: Date, status: OrderStatus = "PENDING_PAYMENT") {
  return db.order.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderNo: ++orderNo,
    broadcastNicknameSnapshot: "PRIVATE-NICKNAME", totalAmount: 5000, createdAt, status } });
}

it("DB 기준 최근 60초의 시작 포함·끝 제외, 상태 무관 생성·판매자/방송 시작 범위를 지키고 조회로 변경하지 않는다", async () => {
  const a = await shop(), b = await shop(), outside = await shop();
  const live = await db.broadcastSession.create({ data: { sellerId: a.seller.id, startedAt: before(3600_000) } });
  const short = await db.broadcastSession.create({ data: { sellerId: b.seller.id, startedAt: before(10_000) } });
  await order(a, before(60_001));
  await order(a, before(60_000));
  await order(a, before(59_999), "CANCELLED");
  await order(a, before(1), "REFUNDED");
  await order(a, at);
  await order(a, new Date(at.getTime() + 1));
  await order(b, before(10_001));
  await order(b, before(10_000));
  await order(outside, before(1));
  const v = await viewer();
  vi.spyOn(billingClock, "dbNow").mockResolvedValue(at);
  const snapshots = await db.order.findMany({ orderBy: { id: "asc" } });
  const result = await listLiveBroadcasts(db, v.ctx);
  expect(result.at).toEqual(at);
  expect(result.orderRate).toEqual({ source: "INTERNAL_ORDER_CREATED_DURING_LIVE_SESSION", association: "SELLER_AND_TIME_WINDOW",
    externalOrders: "NOT_MEASURED", scope: "ALL_LIVE_SESSIONS",
    windowSeconds: 60, from: before(60_000), to: at, total: 4 });
  expect(result.items.find((r) => r.broadcastId === live.id)).toMatchObject({ orders: 0, ordersLast60Seconds: 3 });
  expect(result.items.find((r) => r.broadcastId === short.id)).toMatchObject({ orders: 0, ordersLast60Seconds: 1 });
  expect(await db.order.findMany({ orderBy: { id: "asc" } })).toEqual(snapshots);
  for (const secret of ["PRIVATE-NICKNAME", a.buyer.id, "buyerMemberId", "orderId"]) expect(JSON.stringify(result)).not.toContain(secret);
});

it("표시 200건 밖 방송도 전체에 포함하고 기존 LIVE 중복 방지 제약을 보존하며 조회 비용을 관찰한다", async () => {
  const hidden = await shop();
  await db.broadcastSession.create({ data: { sellerId: hidden.seller.id, startedAt: before(3600_000) } });
  await expect(db.broadcastSession.create({ data: { sellerId: hidden.seller.id, startedAt: before(1000) } })).rejects.toMatchObject({ code: "P2002" });
  await order(hidden, before(1));
  await order(hidden, before(2));
  await db.order.createMany({ data: Array.from({ length: 5000 }, () => ({ sellerId: hidden.seller.id, buyerMemberId: hidden.buyer.id,
    orderNo: ++orderNo, broadcastNicknameSnapshot: "PRIVATE-NICKNAME", totalAmount: 5000, createdAt: before(86_400_000) })) });
  const ids = Array.from({ length: 200 }, () => randomUUID());
  await db.seller.createMany({ data: ids.map((id, i) => ({ id, slug: `rate-${i}`, shopName: `조회 시험 ${i}`, status: "ACTIVE" })) });
  await db.broadcastSession.createMany({ data: ids.map((sellerId) => ({ sellerId, startedAt: before(10_000) })) });
  await db.$executeRaw`ANALYZE "Order", "BroadcastSession"`;
  const v = await viewer();
  vi.spyOn(billingClock, "dbNow").mockResolvedValue(at);
  const queries = vi.fn(db.$queryRaw.bind(db));
  const readDb = new Proxy(db, { get: (target, key) => key === "$queryRaw" ? queries : Reflect.get(target, key) });
  const result = await listLiveBroadcasts(readDb, v.ctx);
  expect(result.items).toHaveLength(200);
  expect(result.items.every((r) => r.sellerId !== hidden.seller.id && r.ordersLast60Seconds === 0)).toBe(true);
  expect(result.orderRate.total).toBe(2);
  expect(queries).toHaveBeenCalledTimes(1);
  const [strings, ...values] = queries.mock.calls[0];
  const sql = Prisma.sql(strings as TemplateStringsArray, ...values);
  type Node = { "Node Type": string; "Index Name"?: string; Plans?: Node[] };
  const plan = await db.$queryRaw<{ "QUERY PLAN": [{ "Execution Time": number; Plan: Node }] }[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
  const nodes = (n: Node): Node[] => [n, ...(n.Plans ?? []).flatMap(nodes)];
  console.info("MA041 fixture EXPLAIN", { orders: 5002, liveSessions: 201, executionMs: plan[0]["QUERY PLAN"][0]["Execution Time"],
    indexes: nodes(plan[0]["QUERY PLAN"][0].Plan).flatMap((n) => n["Index Name"] ? [n["Index Name"]] : []) });
});

it("모든 관리자 조회 권한·401·no-store 및 LIVE가 없는 0건을 유지한다", async () => {
  const s = await shop();
  await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", startedAt: before(60_000), endedAt: at } });
  await order(s, before(1));
  vi.spyOn(billingClock, "dbNow").mockResolvedValue(at);
  for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
    const v = await viewer(role);
    const response = await GET(new Request("http://localhost:3000/api/admin/ops/live-broadcasts", { headers: { cookie: v.cookie } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ at: at.toISOString(), items: [], orderRate: { total: 0 } });
  }
  const denied = await GET(new Request("http://localhost:3000/api/admin/ops/live-broadcasts"));
  expect(denied.status).toBe(401);
  expect(denied.headers.get("cache-control")).toContain("no-store");
});
