import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PATCH as patchRoute } from "../../app/api/admin/admins/[adminId]/route";
import { GET as listRoute, POST as createRoute } from "../../app/api/admin/admins/route";
import { GET as logRoute } from "../../app/api/admin/audit-logs/[logId]/route";
import { GET as logsRoute } from "../../app/api/admin/audit-logs/route";
import { GET as permissionsRoute } from "../../app/api/admin/permissions/route";
import { updateAdmin } from "../../lib/server/admin/accounts";
import { writeAudit } from "../../lib/server/audit/log";
import { loginAdmin, loginSeller } from "../../lib/server/auth/login";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { ADMIN_PERMISSIONS } from "../../lib/server/authz/permissions";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 마스터 관리자 계정(MA-061·062)·역할별 권한 표(MA-063)·로그 추적(MA-070·071)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
async function signedIn(role: Role) {
  const a = await createAdmin(role);
  const token = (await createAdminSession(db, a.id, {})).token;
  return { id: a.id, email: a.email, token, cookie: `lo_admin=${token}` };
}
const get = (route: (r: Request) => Promise<Response>, path: string, cookie: string) => route(new Request(`http://localhost:3000${path}`, { headers: { ...H, cookie } }));
const create = (cookie: string, body: unknown) => createRoute(new Request("http://localhost:3000/api/admin/admins", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }));
const patch = (cookie: string, id: string, body: unknown) =>
  patchRoute(new Request(`http://localhost:3000/api/admin/admins/${id}`, { method: "PATCH", headers: { ...H, cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ adminId: id }) });

describe("관리자 계정 MA-061·062", () => {
  it("최고관리자가 추가(비밀번호는 응답·로그 추적에 없음, 새 계정으로 로그인됨)·목록·이름·역할 변경. 중복 이메일 409, 잘못된 값 400", async () => {
    const su = await signedIn("SUPER_ADMIN");
    const r = await create(su.cookie, { email: " New@Example.com ", name: "운영 담당", role: "OPERATIONS", password: "long-enough-pw" });
    expect(r.status).toBe(201);
    const { admin } = (await r.json()) as { admin: Record<string, unknown> };
    expect(admin).toMatchObject({ email: "new@example.com", name: "운영 담당", role: "OPERATIONS", status: "ACTIVE" });
    expect(Object.keys(admin)).not.toContain("passwordHash");
    expect(await loginAdmin(db, { email: "new@example.com", password: "long-enough-pw" }, {})).toMatchObject({ ok: true });
    const log = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "admin.account.create", targetId: admin.id as string } });
    expect(log).toMatchObject({ actorId: su.id, after: { email: "new@example.com", role: "OPERATIONS" } });
    expect(JSON.stringify(log)).not.toContain("long-enough-pw");

    expect((await create(su.cookie, { email: "new@example.com", name: "또", role: "CS", password: "long-enough-pw" })).status).toBe(409);
    for (const body of [
      { email: "bad", name: "x", role: "CS", password: "long-enough-pw" },
      { email: "a@b.co", name: "", role: "CS", password: "long-enough-pw" },
      { email: "a@b.co", name: "x", role: "OWNER", password: "long-enough-pw" },
    ]) expect(await (await create(su.cookie, body)).json()).toEqual({ error: "invalid_input" });
    expect(await (await create(su.cookie, { email: "a@b.co", name: "x", role: "CS", password: "short" })).json()).toEqual({ error: "weak_password" });

    const listed = (await (await get(listRoute, "/api/admin/admins", su.cookie)).json()) as { admins: { id: string; email: string }[] };
    expect(listed.admins.map((a) => a.id)).toEqual([su.id, admin.id]);
    const changed = await patch(su.cookie, admin.id as string, { name: "CS 담당", role: "CS" });
    expect(await changed.json()).toMatchObject({ admin: { name: "CS 담당", role: "CS" } });
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "admin.account.update", targetId: admin.id as string } })).toMatchObject({
      before: { role: "OPERATIONS" },
      after: { role: "CS" },
    });
    for (const body of [{}, { role: "OWNER" }, { status: "DELETED" }, { name: " " }]) expect((await patch(su.cookie, admin.id as string, body)).status).toBe(400);
    expect((await patch(su.cookie, "00000000-0000-4000-8000-000000000000", { role: "CS" })).status).toBe(404);
  });

  it("정지하면 그 계정 세션이 바로 끝나고 로그인도 안 된다. 다시 ACTIVE로 되돌릴 수 있다", async () => {
    const su = await signedIn("SUPER_ADMIN");
    const ops = await signedIn("OPERATIONS");
    expect(await resolveAdminSession(db, ops.token)).not.toBeNull();
    expect(await (await patch(su.cookie, ops.id, { status: "SUSPENDED" })).json()).toMatchObject({ admin: { status: "SUSPENDED" } });
    expect(await resolveAdminSession(db, ops.token)).toBeNull();
    expect(await db.adminSession.count({ where: { adminId: ops.id, revokedAt: null } })).toBe(0);
    expect(await loginAdmin(db, { email: ops.email, password: PASSWORD }, {})).toMatchObject({ ok: false });
    expect((await patch(su.cookie, ops.id, { status: "ACTIVE" })).status).toBe(200);
    expect(await loginAdmin(db, { email: ops.email, password: PASSWORD }, {})).toMatchObject({ ok: true });
  });

  it("최고관리자는 누구도(본인 포함) 정지·역할 변경할 수 없고(409 super_admin_protected) 이름만 바뀐다. 최고관리자 역할은 추가·수정으로 줄 수 없다(400)", async () => {
    // 대표님 지시(2026-10-04): 「최고관리자는 유일신이다. 정지·강등 넣지 마라.」 최고관리자는 시드로만 만든다
    const su = await signedIn("SUPER_ADMIN");
    const ops = await signedIn("OPERATIONS");
    const audits = async () => db.auditLog.count({ where: { action: { startsWith: "admin.account." } } });
    for (const body of [{ status: "SUSPENDED" }, { role: "OPERATIONS" }, { role: "SUPER_ADMIN" }, { status: "ACTIVE" }, { name: "새 이름", status: "SUSPENDED" }]) {
      const r = await patch(su.cookie, su.id, body);
      expect(r.status, JSON.stringify(body)).toBe(body.role === "SUPER_ADMIN" ? 400 : 409);
    }
    expect(await (await patch(su.cookie, su.id, { role: "CS" })).json()).toEqual({ error: "super_admin_protected" });
    expect(await db.platformAdmin.findUniqueOrThrow({ where: { id: su.id } })).toMatchObject({ role: "SUPER_ADMIN", status: "ACTIVE", name: "관리자" });
    expect(await resolveAdminSession(db, su.token)).not.toBeNull();
    expect(await audits()).toBe(0);

    // 최고관리자 역할 부여 거부(추가·수정 모두), 아무것도 바뀌지 않는다
    const created = await create(su.cookie, { email: "second@example.com", name: "두 번째", role: "SUPER_ADMIN", password: "long-enough-pw" });
    expect(created.status).toBe(400);
    expect(await created.json()).toEqual({ error: "super_admin_not_assignable" });
    expect(await db.platformAdmin.count({ where: { email: "second@example.com" } })).toBe(0);
    expect(await (await patch(su.cookie, ops.id, { role: "SUPER_ADMIN" })).json()).toEqual({ error: "super_admin_not_assignable" });
    expect((await db.platformAdmin.findUniqueOrThrow({ where: { id: ops.id } })).role).toBe("OPERATIONS");
    expect(await updateAdmin(db, (await resolveAdminSession(db, su.token))!, ops.id, { role: "SUPER_ADMIN" })).toEqual({ ok: false, reason: "super_admin_not_assignable" });
    expect(await audits()).toBe(0);

    // 이름은 바꿀 수 있다
    expect(await (await patch(su.cookie, su.id, { name: "대표" })).json()).toMatchObject({ admin: { name: "대표", role: "SUPER_ADMIN", status: "ACTIVE" } });
    expect(await audits()).toBe(1);
  });

  it("최고관리자가 아니면 계정·권한 표 모두 403이고 아무것도 바뀌지 않는다. 파트너스 세션은 401", async () => {
    const target = await signedIn("READ_ONLY");
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) {
      const a = await signedIn(role);
      expect((await get(listRoute, "/api/admin/admins", a.cookie)).status, role).toBe(403);
      expect((await get(permissionsRoute, "/api/admin/permissions", a.cookie)).status, role).toBe(403);
      expect((await create(a.cookie, { email: `x-${role}@b.co`, name: "x", role: "SUPER_ADMIN", password: "long-enough-pw" })).status, role).toBe(403);
      expect((await patch(a.cookie, target.id, { role: "SUPER_ADMIN" })).status, role).toBe(403);
    }
    expect((await db.platformAdmin.findUniqueOrThrow({ where: { id: target.id } })).role).toBe("READ_ONLY");
    expect(await db.platformAdmin.count({ where: { email: { startsWith: "x-" } } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: { startsWith: "admin.account." } } })).toBe(0);
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await get(listRoute, "/api/admin/admins", `lo_seller=${login.token}`)).status).toBe(401);
  });
});

describe("역할별 권한 표 MA-063", () => {
  it("permissions.ts 표 그대로: 권한별 역할, 역할별 권한(구독 가격 변경은 최고관리자만)", async () => {
    const su = await signedIn("SUPER_ADMIN");
    const body = (await (await get(permissionsRoute, "/api/admin/permissions", su.cookie)).json()) as {
      roles: string[];
      permissions: { permission: string; roles: string[] }[];
      byRole: Record<string, string[]>;
    };
    expect(body.roles).toEqual(["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"]);
    expect(Object.fromEntries(body.permissions.map((p) => [p.permission, p.roles]))).toEqual(JSON.parse(JSON.stringify(ADMIN_PERMISSIONS)));
    expect(body.byRole.SUPER_ADMIN).toContain("billing.price");
    expect(body.byRole.OPERATIONS).not.toContain("billing.price");
    expect(body.byRole.READ_ONLY).toEqual(["platform.read", "audit.read"]);
  });
});

describe("로그 추적 MA-070·071", () => {
  it("기록 시각 내림차순, action 정확·접두어·행위자·쇼핑몰·대상·KST 날짜 필터, 커서, 목록엔 바뀐 값 없음, 상세엔 before·after·관리자 이름", async () => {
    const ops = await signedIn("OPERATIONS");
    const { seller } = await createSeller();
    const at = (iso: string) => new Date(iso);
    const mk = async (action: string, createdAt: Date, extra: Record<string, unknown> = {}) => {
      await writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId: ops.id, action, targetType: "Seller", targetId: seller.id, sellerId: seller.id, before: { a: 1 }, after: { a: 2 }, ...extra });
      const row = await db.auditLog.findFirstOrThrow({ where: { action }, orderBy: { createdAt: "desc" } });
      await db.auditLog.update({ where: { id: row.id }, data: { createdAt } });
      return row.id;
    };
    const l1 = await mk("admin.seller.suspend", at("2026-10-04T15:00:00.000Z")); // KST 10/5 0시
    const l2 = await mk("admin.seller.unsuspend", at("2026-10-05T14:59:59.999Z")); // KST 10/5 끝
    await writeAudit(db, { actorType: "SYSTEM", action: "subscription.canceled", targetType: "SellerSubscription", targetId: "s1" });
    const l3 = (await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "subscription.canceled" } })).id;
    await db.auditLog.update({ where: { id: l3 }, data: { createdAt: at("2026-10-05T15:00:00.000Z") } });

    const ids = async (qs: string) => {
      const res = await get(logsRoute, `/api/admin/audit-logs${qs}`, ops.cookie);
      expect(res.status, qs).toBe(200);
      const body = (await res.json()) as { logs: Record<string, unknown>[]; nextCursor: string | null };
      return body.logs.map((l) => l.id);
    };
    expect(await ids("")).toEqual([l3, l2, l1]);
    expect(await ids("?action=admin.seller.suspend")).toEqual([l1]);
    expect(await ids("?action=admin.seller.")).toEqual([l2, l1]);
    expect(await ids("?actorType=SYSTEM")).toEqual([l3]);
    expect(await ids(`?actorId=${ops.id}`)).toEqual([l2, l1]);
    expect(await ids(`?sellerId=${seller.id}`)).toEqual([l2, l1]);
    expect(await ids("?targetId=s1")).toEqual([l3]);
    expect(await ids("?from=2026-10-05&to=2026-10-05")).toEqual([l2, l1]);
    const first = (await (await get(logsRoute, "/api/admin/audit-logs?limit=2", ops.cookie)).json()) as { logs: Record<string, unknown>[]; nextCursor: string };
    expect(first.logs.map((l) => l.id)).toEqual([l3, l2]);
    expect(Object.keys(first.logs[0])).not.toContain("before");
    expect(await ids(`?limit=2&cursor=${first.nextCursor}`)).toEqual([l1]);
    for (const qs of ["?action=Bad Action", "?actorType=ROBOT", "?actorId=x", "?sellerId=x", "?from=2026-13-01", "?limit=0", "?cursor=x"]) {
      expect((await get(logsRoute, `/api/admin/audit-logs${qs}`, ops.cookie)).status, qs).toBe(400);
    }

    const detail = (id: string, cookie = ops.cookie) =>
      logRoute(new Request(`http://localhost:3000/api/admin/audit-logs/${id}`, { headers: { ...H, cookie } }), { params: Promise.resolve({ logId: id }) });
    expect(((await (await detail(l1)).json()) as { log: unknown }).log).toMatchObject({
      id: l1,
      before: { a: 1 },
      after: { a: 2 },
      seller: { id: seller.id },
      actorAdmin: { email: ops.email, role: "OPERATIONS" },
    });
    expect((await detail("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("최고관리자·운영·조회 전용은 보고, CS는 403(audit.read). 파트너스 세션은 401", async () => {
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "READ_ONLY"] as const) expect((await get(logsRoute, "/api/admin/audit-logs", (await signedIn(role)).cookie)).status, role).toBe(200);
    const cs = await signedIn("CS");
    expect((await get(logsRoute, "/api/admin/audit-logs", cs.cookie)).status).toBe(403);
    expect(
      (await logRoute(new Request("http://localhost:3000/api/admin/audit-logs/00000000-0000-4000-8000-000000000000", { headers: { ...H, cookie: cs.cookie } }), { params: Promise.resolve({ logId: "00000000-0000-4000-8000-000000000000" }) })).status,
    ).toBe(403);
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await get(logsRoute, "/api/admin/audit-logs", `lo_seller=${login.token}`)).status).toBe(401);
  });
});
