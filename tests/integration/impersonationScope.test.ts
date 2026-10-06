import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as activeRoute } from "../../app/api/admin/impersonation/route";
import { POST as startRoute } from "../../app/api/admin/sellers/[sellerId]/impersonate/route";
import { GET as membersRoute } from "../../app/api/seller/members/route";
import { GET as orderOne } from "../../app/api/seller/orders/[orderId]/route";
import { GET as ordersRoute } from "../../app/api/seller/orders/route";
import { GET as productsRoute } from "../../app/api/seller/products/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { createAdmin, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 마스터 대리 조회(MA-016) 1단계: 접근 사유 분류·관련 건·열람 범위·세션 시간 입력 검사, 범위 밖 403 out_of_scope, 구매자 연락처 가림.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const sid = (sellerId: string) => ({ params: Promise.resolve({ sellerId }) });
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function start(cookie: string, sellerId: string, body: Record<string, unknown>) {
  const res = await startRoute(req(`/api/admin/sellers/${sellerId}/impersonate`, cookie, "POST", { reason: "오버레이 끊김 확인", ...body }), sid(sellerId));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, imp: /lo_imp=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] };
}
async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const buyer = await createBuyer(seller.id, grade.id);
  const order = await db.order.create({ data: { sellerId: seller.id, orderNo: 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 10000 } });
  const inquiry = await db.platformInquiry.create({ data: { sellerId: seller.id, createdBySellerUserId: owner.id, category: "BILLING", title: "문의" } });
  return { seller, buyer, order, inquiry };
}

describe("대리 조회 시작 입력 검사", () => {
  it("분류·관련 건·범위·시간: 잘못된 값 400, 분류가 문의·장애면 관련 건 필수, 다른 쇼핑몰 건은 거부, 60분은 최고관리자만", async () => {
    const a = await shop();
    const b = await shop();
    const op = await admin("OPERATIONS");
    const su = await admin("SUPER_ADMIN");
    const ok = { category: "INQUIRY", relatedKind: "INQUIRY", relatedId: a.inquiry.id, scopes: ["ORDERS"] };
    expect((await start(op.cookie, a.seller.id, { ...ok, category: "X" })).body.error).toBe("category_invalid");
    expect((await start(op.cookie, a.seller.id, { ...ok, relatedKind: undefined, relatedId: undefined })).body.error).toBe("related_required");
    expect((await start(op.cookie, a.seller.id, { ...ok, category: "INCIDENT", relatedKind: undefined, relatedId: undefined })).body.error).toBe("related_required");
    expect((await start(op.cookie, a.seller.id, { ...ok, relatedId: b.inquiry.id })).body.error).toBe("related_invalid");
    expect((await start(op.cookie, a.seller.id, { ...ok, relatedId: "not-uuid" })).body.error).toBe("related_invalid");
    for (const scopes of [[], "ORDERS", ["NOPE"], [1]]) expect((await start(op.cookie, a.seller.id, { ...ok, scopes })).body.error).toBe("scopes_required");
    for (const durationMinutes of [10, "30", 45]) expect((await start(op.cookie, a.seller.id, { ...ok, durationMinutes })).body.error).toBe("duration_invalid");
    expect(await start(op.cookie, a.seller.id, { ...ok, durationMinutes: 60 })).toMatchObject({ status: 403, body: { error: "duration_not_allowed" } });
    // 분류가 정산·감사면 관련 건 없이도 열린다
    expect((await start(op.cookie, a.seller.id, { category: "FINANCE_CHECK", scopes: ["ORDERS"], durationMinutes: 15 })).status).toBe(200);

    const long = await start(su.cookie, a.seller.id, { ...ok, durationMinutes: 60 });
    expect(long.status).toBe(200);
    expect(long.body.scopes).toEqual(["ORDERS"]);
    const left = new Date(long.body.expiresAt as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(59 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000);

    const active = (await (await activeRoute(req("/api/admin/impersonation", su.cookie))).json()) as { active: Record<string, unknown> };
    expect(active.active).toMatchObject({ category: "INQUIRY", relatedKind: "INQUIRY", relatedId: a.inquiry.id, scopes: ["ORDERS"] });
    const log = await db.auditLog.findFirst({ where: { sellerId: a.seller.id, action: "admin.impersonate.view", actorId: su.id } });
    expect(log?.after).toMatchObject({ category: "INQUIRY", scopes: ["ORDERS"], minutes: 60 });
  });

  it("분류·범위·시간을 보내지 않으면 이전 방식(범위 주문·회원)으로 열린다", async () => {
    const a = await shop();
    const r = await start((await admin("CS")).cookie, a.seller.id, {});
    expect(r.status).toBe(200);
    expect(r.body.scopes).toEqual(["ORDERS", "MEMBERS"]);
  });
});

describe("열람 범위 강제", () => {
  it("고른 범위 밖 파트너스 API는 403 out_of_scope, 범위 안은 열린다", async () => {
    const a = await shop();
    const cs = await admin("CS");
    const onlyMembers = await start(cs.cookie, a.seller.id, { category: "AUDIT", scopes: ["MEMBERS"] });
    const c1 = `lo_imp=${onlyMembers.imp}`;
    expect((await membersRoute(req("/api/seller/members", c1))).status).toBe(200);
    const blocked = await ordersRoute(req("/api/seller/orders", c1));
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toBe("out_of_scope");
    expect((await productsRoute(req("/api/seller/products", c1))).status).toBe(403);

    const onlyOrders = await start(cs.cookie, a.seller.id, { category: "AUDIT", scopes: ["ORDERS"] });
    const c2 = `lo_imp=${onlyOrders.imp}`;
    expect((await ordersRoute(req("/api/seller/orders", c2))).status).toBe(200);
    expect((await productsRoute(req("/api/seller/products", c2))).status).toBe(200);
    expect(((await (await membersRoute(req("/api/seller/members", c2))).json()) as { error: string }).error).toBe("out_of_scope");
    // 아직 파트너스 API가 열리지 않은 범위만 고르면 지금 열린 화면은 모두 막힌다
    const onlyBroadcast = await start(cs.cookie, a.seller.id, { category: "AUDIT", scopes: ["BROADCAST"] });
    expect((await ordersRoute(req("/api/seller/orders", `lo_imp=${onlyBroadcast.imp}`))).status).toBe(403);
  });

  it("구매자 이름·연락처는 어떤 범위에서도 응답에 나오지 않는다", async () => {
    const a = await shop();
    const cs = await admin("CS");
    const r = await start(cs.cookie, a.seller.id, { category: "AUDIT", scopes: ["ORDERS", "MEMBERS"] });
    const res = await orderOne(req(`/api/seller/orders/${a.order.id}`, `lo_imp=${r.imp}`), { params: Promise.resolve({ orderId: a.order.id }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(a.buyer.phone);
    expect(text).not.toContain(a.buyer.name);
  });
});
