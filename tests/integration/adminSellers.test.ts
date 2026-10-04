import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "../../app/api/admin/sellers/[sellerId]/route";
import { POST as suspendRoute } from "../../app/api/admin/sellers/[sellerId]/suspend/route";
import { POST as unsuspendRoute } from "../../app/api/admin/sellers/[sellerId]/unsuspend/route";
import { GET as listRoute } from "../../app/api/admin/sellers/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession, resolveSellerSession } from "../../lib/server/auth/session";
import { PASSWORD, createAdmin, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 관리자 파트너스 목록·상세·이용 정지(MA-011·012·015)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function adminCookie(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const list = (cookie: string, qs = "") => listRoute(new Request(`http://localhost:3000/api/admin/sellers${qs}`, { headers: { ...H, cookie } }));
const detail = (cookie: string, id: string) =>
  detailRoute(new Request(`http://localhost:3000/api/admin/sellers/${id}`, { headers: { ...H, cookie } }), { params: Promise.resolve({ sellerId: id }) });
const post = (route: typeof suspendRoute, kind: string, cookie: string, id: string, body: unknown) =>
  route(new Request(`http://localhost:3000/api/admin/sellers/${id}/${kind}`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ sellerId: id }),
  });
const ids = async (r: Response) => ((await r.json()) as { sellers: { id: string }[] }).sellers.map((s) => s.id);

describe("파트너스 목록 GET /api/admin/sellers", () => {
  it("가입 시각 내림차순, 이름·주소 검색·상태·요금제 필터, (createdAt, id) 커서로 빠짐·겹침 없이 끝까지. 잘못된 값은 400", async () => {
    const plans = await seedPlans();
    const { cookie } = await adminCookie("READ_ONLY");
    const made: { id: string; slug: string }[] = [];
    for (let i = 0; i < 5; i++) made.push((await createSeller()).seller);
    const at = new Date("2026-10-01T00:00:00Z");
    // 같은 가입 시각 3개(커서 경계)
    for (const s of made.slice(0, 3)) await db.seller.update({ where: { id: s.id }, data: { createdAt: at } });
    await db.seller.update({ where: { id: made[3].id }, data: { status: "SUSPENDED", shopName: "포켓몬 카드샵", planId: plans.OVERLAY_ONLY.id } });
    await db.seller.update({ where: { id: made[4].id }, data: { planId: plans.INTEGRATED.id } });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await list(cookie, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { sellers: { id: string }[]; nextCursor: string | null };
      seen.push(...body.sellers.map((s) => s.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
    expect(seen.length).toBe(5);

    expect(await ids(await list(cookie, `?q=${encodeURIComponent("포켓몬")}`))).toEqual([made[3].id]);
    expect(await ids(await list(cookie, `?q=${made[1].slug}`))).toEqual([made[1].id]);
    expect(await ids(await list(cookie, "?status=SUSPENDED"))).toEqual([made[3].id]);
    expect(await ids(await list(cookie, "?plan=INTEGRATED"))).toEqual([made[4].id]);
    const first = ((await (await list(cookie)).json()) as { sellers: Record<string, unknown>[] }).sellers.find((s) => s.id === made[3].id)!;
    expect(first).toMatchObject({ status: "SUSPENDED", plan: { code: "OVERLAY_ONLY" }, subscription: null });
    for (const qs of ["?status=NOPE", "?plan=PRO", "?limit=0", "?limit=x", "?cursor=bad", `?q=${"가".repeat(51)}`]) expect((await list(cookie, qs)).status).toBe(400);
  });

  it("관리자 세션만: 로그인 없음 401, 파트너스(판매자) 세션 쿠키로는 401", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await list("")).status).toBe(401);
    expect((await list(`lo_seller=${login.token}`)).status).toBe(401);
    expect((await detail(`lo_seller=${login.token}`, seller.id)).status).toBe(401);
    expect((await post(suspendRoute, "suspend", `lo_seller=${login.token}`, seller.id, { reason: "x" })).status).toBe(401);
  });
});

describe("파트너스 상세 GET /api/admin/sellers/{id}", () => {
  it("기본 정보·대표자·구독·최근 30일 주문 요약(결제 금액은 환불액 뺌), 없는 id·형식 오류는 404", async () => {
    const plans = await seedPlans();
    const { cookie } = await adminCookie("CS");
    const { seller, grade } = await createSeller();
    await db.seller.update({ where: { id: seller.id }, data: { planId: plans.INTEGRATED.id } });
    await createSellerUser(seller.id, "OWNER", "owner@example.com");
    await db.sellerSubscription.create({
      data: { sellerId: seller.id, planId: plans.INTEGRATED.id, status: "ACTIVE", cardLabel: "카드", subscribedAt: new Date(), currentPeriodEnd: new Date(Date.now() + 86400_000) },
    });
    const buyer = await createBuyer(seller.id, grade.id);
    const a = await createPaidOrderItem(seller.id, buyer.id);
    const b = await createPaidOrderItem(seller.id, buyer.id);
    await db.order.updateMany({ where: { id: { in: [a.order.id, b.order.id] } }, data: { paidAt: new Date() } });
    await db.order.update({ where: { id: b.order.id }, data: { status: "REFUNDED", refundAmount: 2000 } });
    // 30일보다 오래된 주문은 세지 않는다
    const old = await createPaidOrderItem(seller.id, buyer.id);
    await db.order.update({ where: { id: old.order.id }, data: { createdAt: new Date(Date.now() - 40 * 86400_000), paidAt: new Date(Date.now() - 40 * 86400_000) } });

    const r = await detail(cookie, seller.id);
    expect(r.status).toBe(200);
    const { seller: body } = (await r.json()) as { seller: Record<string, unknown> };
    expect(body).toMatchObject({
      id: seller.id,
      status: "ACTIVE",
      plan: { code: "INTEGRATED" },
      owner: { email: "owner@example.com" },
      subscription: { status: "ACTIVE", planCode: "INTEGRATED", pendingPlanCode: null, cardLabel: "카드" },
      orders30d: { created: 2, paid: 2, paidAmount: 8000 },
    });
    expect((await detail(cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await detail(cookie, "nope")).status).toBe(404);
  });
});

describe("이용 정지·해제 POST /api/admin/sellers/{id}/suspend·unsuspend", () => {
  it("정지하면 파트너스 세션·로그인이 바로 막히고 사유·로그 추적이 남는다. 해제하면 다시 열린다. 상태가 맞지 않으면 409, 사유 없으면 400", async () => {
    const { id: adminId, cookie } = await adminCookie("OPERATIONS");
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect(await resolveSellerSession(db, login.token)).not.toBeNull();

    for (const reason of [undefined, " ", "가".repeat(201)]) expect((await post(suspendRoute, "suspend", cookie, seller.id, { reason })).status).toBe(400);
    expect((await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).status).toBe("ACTIVE");
    expect((await post(unsuspendRoute, "unsuspend", cookie, seller.id, {})).status).toBe(409);

    const r = await post(suspendRoute, "suspend", cookie, seller.id, { reason: " 이용약관 위반 " });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, status: "SUSPENDED" });
    expect(await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).toMatchObject({ status: "SUSPENDED", suspendedReason: "이용약관 위반" });
    expect(await resolveSellerSession(db, login.token)).toBeNull();
    expect(await loginSeller(db, { email: owner.email, password: PASSWORD }, {})).toMatchObject({ ok: false, reason: "seller_suspended" });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "admin.seller.suspend", targetId: seller.id } })).toMatchObject({
      actorType: "PLATFORM_ADMIN",
      actorId: adminId,
      reason: "이용약관 위반",
      before: { status: "ACTIVE" },
      after: { status: "SUSPENDED" },
    });
    expect((await post(suspendRoute, "suspend", cookie, seller.id, { reason: "다시" })).status).toBe(409);

    expect(await (await post(unsuspendRoute, "unsuspend", cookie, seller.id, {})).json()).toEqual({ ok: true, status: "ACTIVE" });
    expect(await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).toMatchObject({ status: "ACTIVE", suspendedReason: null });
    expect(await db.auditLog.count({ where: { action: "admin.seller.unsuspend", targetId: seller.id } })).toBe(1);
    expect(await loginSeller(db, { email: owner.email, password: PASSWORD }, {})).toMatchObject({ ok: true });

    // 승인 대기·반려 쇼핑몰은 정지할 수 없다, 없는 쇼핑몰은 404
    const pending = (await createSeller()).seller;
    await db.seller.update({ where: { id: pending.id }, data: { status: "PENDING" } });
    expect((await post(suspendRoute, "suspend", cookie, pending.id, { reason: "x" })).status).toBe(409);
    expect((await post(suspendRoute, "suspend", cookie, "00000000-0000-4000-8000-000000000000", { reason: "x" })).status).toBe(404);
  });

  it("역할 권한: 조회 전용·CS는 목록·상세는 되지만 정지·해제는 403이고 아무것도 바뀌지 않는다. 최고관리자는 된다", async () => {
    const { seller } = await createSeller();
    for (const role of ["READ_ONLY", "CS"] as const) {
      const { cookie } = await adminCookie(role);
      expect((await list(cookie)).status).toBe(200);
      expect((await detail(cookie, seller.id)).status).toBe(200);
      expect((await post(suspendRoute, "suspend", cookie, seller.id, { reason: "x" })).status).toBe(403);
      expect((await post(unsuspendRoute, "unsuspend", cookie, seller.id, {})).status).toBe(403);
    }
    expect((await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).status).toBe("ACTIVE");
    expect(await db.auditLog.count({ where: { action: { startsWith: "admin.seller." } } })).toBe(0);
    const { cookie } = await adminCookie("SUPER_ADMIN");
    expect((await post(suspendRoute, "suspend", cookie, seller.id, { reason: "x" })).status).toBe(200);
  });
});
