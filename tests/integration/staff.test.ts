import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as sellerOrder } from "../../app/api/seller/orders/[orderId]/route";
import { GET as staffList, POST as staffCreate } from "../../app/api/seller/staff/route";
import { POST as sellerLogin } from "../../app/api/seller/auth/login/route";
import { loginSeller } from "../../lib/server/auth/login";
import { requireSeller } from "../../lib/server/authz/guards";
import { prisma } from "../../lib/server/db";
import { getOrder } from "../../lib/server/orders/read";
import { createStaff, disableStaff, listStaff, updateStaffPermissions } from "../../lib/server/sellers/staff";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function ctxOf(email: string, password = PASSWORD): Promise<TenantContext> {
  const r = await loginSeller(db, { email, password }, {});
  if (!r.ok) throw new Error(`login failed: ${r.reason}`);
  return requireSeller(db, r.token);
}

describe("직원 관리 (대표자 전용)", () => {
  it("대표자가 직원 계정을 만들면 그 권한으로 로그인되고, 생성 감사 로그가 남는다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const ctx = await ctxOf(owner.email);
    const r = await createStaff(db, ctx, { email: "New@Staff.com", name: "방송 직원", password: "staff-pass-1", permissions: ["BROADCAST_RUN", "OVERLAY_EDIT"] });
    expect(r.ok).toBe(true);
    const staffCtx = await ctxOf("new@staff.com", "staff-pass-1");
    expect(staffCtx).toMatchObject({ isOwner: false, permissions: ["BROADCAST_RUN", "OVERLAY_EDIT"] });
    const log = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "seller.staff.create" } });
    expect(log).toMatchObject({ actorId: owner.id, sellerId: seller.id });
    expect(log.after).toMatchObject({ email: "new@staff.com", permissions: ["BROADCAST_RUN", "OVERLAY_EDIT"] });
    expect(JSON.stringify(log.after)).not.toContain("staff-pass-1");
  });

  it("없는 권한 항목이나 대표자 전용 기능은 줄 수 없다", async () => {
    const { seller } = await createSeller();
    const ctx = await ctxOf((await createSellerUser(seller.id, "OWNER")).email);
    for (const permissions of [["STAFF_MANAGE"], ["PG_MANAGE"], ["NOPE"], "BROADCAST_RUN"]) {
      expect(await createStaff(db, ctx, { email: "a@b.c", name: "직원", password: "staff-pass-1", permissions })).toEqual({
        ok: false,
        reason: "invalid_permissions",
      });
    }
  });

  it("같은 쇼핑몰에 같은 이메일 직원은 만들 수 없다", async () => {
    const { seller } = await createSeller();
    const ctx = await ctxOf((await createSellerUser(seller.id, "OWNER")).email);
    const input = { email: "dup@b.c", name: "직원", password: "staff-pass-1", permissions: [] };
    expect((await createStaff(db, ctx, input)).ok).toBe(true);
    expect(await createStaff(db, ctx, input)).toEqual({ ok: false, reason: "email_taken" });
  });

  it("권한 변경은 바로 적용되고 전·후가 감사 로그에 남는다", async () => {
    const { seller } = await createSeller();
    const ownerCtx = await ctxOf((await createSellerUser(seller.id, "OWNER")).email);
    const staff = await createSellerUser(seller.id, "BROADCASTER");
    expect(await updateStaffPermissions(db, ownerCtx, { staffUserId: staff.id, permissions: ["SALES_VIEW", "BROADCAST_RUN"] })).toEqual({
      ok: true,
      value: { permissions: ["BROADCAST_RUN", "SALES_VIEW"] },
    });
    expect((await ctxOf(staff.email)).permissions).toEqual(["BROADCAST_RUN", "SALES_VIEW"]);
    const log = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "seller.staff.permissions" } });
    expect(log).toMatchObject({ actorId: ownerCtx.actorId, targetId: staff.id });
    expect(log.before).toEqual({ permissions: ["BROADCAST_RUN", "OVERLAY_EDIT"] });
    expect(log.after).toEqual({ permissions: ["BROADCAST_RUN", "SALES_VIEW"] });
  });

  it("비활성화하면 로그인할 수 없고 기존 로그인도 끊긴다", async () => {
    const { seller } = await createSeller();
    const ownerCtx = await ctxOf((await createSellerUser(seller.id, "OWNER")).email);
    const staff = await createSellerUser(seller.id, "MANAGER");
    const before = await loginSeller(db, { email: staff.email, password: PASSWORD }, {});
    if (!before.ok) throw new Error();
    await disableStaff(db, ownerCtx, { staffUserId: staff.id });
    await expect(requireSeller(db, before.token)).rejects.toMatchObject({ status: 401 });
    expect(await loginSeller(db, { email: staff.email, password: PASSWORD }, {})).toEqual({ ok: false, reason: "account_disabled" });
    expect(await db.auditLog.count({ where: { action: "seller.staff.disable", targetId: staff.id } })).toBe(1);
  });

  it("직원은 권한 항목을 모두 가져도 직원 관리 API를 쓸 수 없다 (403)", async () => {
    const { seller } = await createSeller();
    const allPerms = await createSellerUser(seller.id, {
      permissions: ["BROADCAST_RUN", "OVERLAY_EDIT", "PRODUCT_MANAGE", "ORDER_SHIPPING", "CUSTOMER_PII_VIEW", "MEMBER_POINTS", "INQUIRY_REPLY", "RECEIPT_TAX", "SALES_VIEW", "SHOP_SETTINGS"],
    });
    const other = await createSellerUser(seller.id, "BROADCASTER");
    const ctx = await ctxOf(allPerms.email);
    await expect(listStaff(db, ctx)).rejects.toMatchObject({ status: 403 });
    await expect(createStaff(db, ctx, { email: "x@y.z", name: "x", password: "staff-pass-1", permissions: [] })).rejects.toMatchObject({ status: 403 });
    await expect(updateStaffPermissions(db, ctx, { staffUserId: other.id, permissions: [] })).rejects.toMatchObject({ status: 403 });
    await expect(disableStaff(db, ctx, { staffUserId: other.id })).rejects.toMatchObject({ status: 403 });
  });

  it("다른 쇼핑몰 직원은 없음(404), 대표자 계정은 대상이 아님(403)", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const ownerA = await createSellerUser(a.seller.id, "OWNER");
    const staffB = await createSellerUser(b.seller.id, "MANAGER");
    const ctx = await ctxOf(ownerA.email);
    await expect(updateStaffPermissions(db, ctx, { staffUserId: staffB.id, permissions: [] })).rejects.toMatchObject({ status: 404 });
    await expect(disableStaff(db, ctx, { staffUserId: staffB.id })).rejects.toMatchObject({ status: 404 });
    await expect(updateStaffPermissions(db, ctx, { staffUserId: ownerA.id, permissions: [] })).rejects.toMatchObject({ status: 403 });
    expect((await listStaff(db, ctx)).map((s) => s.id)).toEqual([]);
  });
});

describe("구매자 개인정보 (CUSTOMER_PII_VIEW)", () => {
  async function orderSetup() {
    const { seller, grade } = await createSeller();
    const buyer = await createBuyer(seller.id, grade.id, "01055556666");
    const { order } = await createPaidOrderItem(seller.id, buyer.id);
    return { seller, buyer, order };
  }

  it("권한이 없으면 응답에 이름·연락처가 없고, 있으면 들어가며 열람 기록이 남는다", async () => {
    const { seller, buyer, order } = await orderSetup();
    const noPii = await createSellerUser(seller.id, { permissions: ["ORDER_SHIPPING"] });
    const withPii = await createSellerUser(seller.id, { permissions: ["ORDER_SHIPPING", "CUSTOMER_PII_VIEW"] });

    const hidden = await getOrder(db, await ctxOf(noPii.email), order.id);
    expect(hidden.buyer).toEqual({ id: buyer.id, broadcastNickname: buyer.broadcastNickname });
    expect(JSON.stringify(hidden)).not.toContain("01055556666");
    expect(JSON.stringify(hidden)).not.toContain(buyer.name);
    expect(await db.auditLog.count({ where: { action: "customer.pii.view" } })).toBe(0);

    const shown = await getOrder(db, await ctxOf(withPii.email), order.id);
    expect(shown.buyer).toMatchObject({ name: buyer.name, phone: "01055556666" });
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "customer.pii.view" } })).toMatchObject({ actorId: withPii.id, targetId: order.id });
  });

  it("주문 권한이 없으면 403 (방송 진행만 있는 직원)", async () => {
    const { seller, order } = await orderSetup();
    const caster = await createSellerUser(seller.id, "BROADCASTER");
    await expect(getOrder(db, await ctxOf(caster.email), order.id)).rejects.toMatchObject({ status: 403 });
  });

  it("HTTP: 연락처 권한이 없는 직원의 주문 응답에는 연락처가 없다", async () => {
    const { seller, order } = await orderSetup();
    const noPii = await createSellerUser(seller.id, { permissions: ["ORDER_SHIPPING"] });
    const BASE = "http://localhost:3000";
    const login = await sellerLogin(
      new Request(BASE + "/api/seller/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", origin: BASE },
        body: JSON.stringify({ email: noPii.email, password: PASSWORD }),
      }),
    );
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const res = await sellerOrder(new Request(`${BASE}/api/seller/orders/${order.id}`, { headers: { cookie, host: "localhost:3000" } }), {
      params: Promise.resolve({ orderId: order.id }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("01055556666");
    expect(text).not.toContain('"phone"');
  });
});

describe("HTTP: 직원 관리 API", () => {
  const BASE = "http://localhost:3000";
  const loginCookie = async (email: string) => {
    const res = await sellerLogin(
      new Request(BASE + "/api/seller/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", origin: BASE },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    return res.headers.get("set-cookie")!.split(";")[0];
  };

  it("대표자는 직원을 만들고(201) 목록을 보고, 직원은 403", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const staff = await createSellerUser(seller.id, "MANAGER");
    const ownerCookie = await loginCookie(owner.email);
    const created = await staffCreate(
      new Request(BASE + "/api/seller/staff", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", origin: BASE, cookie: ownerCookie },
        body: JSON.stringify({ email: "c@d.e", name: "새 직원", password: "staff-pass-1", permissions: ["SALES_VIEW"] }),
      }),
    );
    expect(created.status).toBe(201);
    const list = await staffList(new Request(BASE + "/api/seller/staff", { headers: { cookie: ownerCookie, host: "localhost:3000" } }));
    expect((await list.json()).staff.map((s: { email: string }) => s.email).sort()).toEqual(["c@d.e", staff.email].sort());
    const staffCookie = await loginCookie(staff.email);
    expect((await staffList(new Request(BASE + "/api/seller/staff", { headers: { cookie: staffCookie, host: "localhost:3000" } }))).status).toBe(403);
  });
});
