import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminGet, PUT as adminPut } from "../../app/api/admin/settings/maintenance/route";
import { POST as cancelRoute } from "../../app/api/admin/settings/maintenance/windows/[windowId]/cancel/route";
import { POST as endRoute } from "../../app/api/admin/settings/maintenance/windows/[windowId]/end/route";
import { GET as listRoute, POST as createRoute } from "../../app/api/admin/settings/maintenance/windows/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { clearMaintenanceCache } from "../../lib/server/maintenance/service";
import { createAdmin, createSeller, db, resetDb } from "./helpers";

// 점검 예약·이력(MA-083): 예약 여러 건·즉시 켜기·예약 취소·점검 종료·이력, 권한(보기 전 역할·바꾸기 최고관리자), 사유 필수, 방송 자동 종료 없음, 지금 상태 사본과의 정합.
beforeEach(async () => {
  await resetDb();
  clearMaintenanceCache();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function adminCookie(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });
const W = "/api/admin/settings/maintenance/windows";
const list = async (cookie: string, qs = "") => json(await listRoute(req(W + qs, cookie)));
const create = async (cookie: string, body: Record<string, unknown>) => json(await createRoute(req(W, cookie, "POST", { message: "서버 점검입니다", reason: "서버 증설", ...body })));
const act = async (route: typeof cancelRoute, kind: string, cookie: string, id: string) => json(await route(req(`${W}/${id}/${kind}`, cookie, "POST"), { params: Promise.resolve({ windowId: id }) }));
const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const mirror = () => db.platformMaintenance.findUnique({ where: { id: 1 } });

describe("점검 예약 목록·이력", () => {
  it("보기는 모든 역할, 예약·취소·종료는 최고관리자만. 비로그인 401", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const made = await create(su.cookie, { startsAt: at(1) });
    expect(made.status).toBe(201);
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) {
      const a = await adminCookie(role);
      expect((await list(a.cookie)).status).toBe(200);
      expect((await create(a.cookie, { startsAt: at(2) })).status).toBe(403);
      expect((await act(cancelRoute, "cancel", a.cookie, made.body.window.id)).status).toBe(403);
      expect((await act(endRoute, "end", a.cookie, made.body.window.id)).status).toBe(403);
    }
    expect((await list("")).status).toBe(401);
  });

  it("입력 검사: 안내 문구·사유 필수, 시작은 지금보다 뒤, 종료 예정은 시작보다 뒤, 잘못된 목록 조건 400", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    for (const [body, error] of [
      [{ message: "" }, "invalid_message"],
      [{ message: "가".repeat(501) }, "invalid_message"],
      [{ reason: "" }, "reason_required"],
      [{ reason: "  " }, "reason_required"],
      [{ reason: "가".repeat(201) }, "reason_required"],
      [{ startsAt: at(-1) }, "invalid_time"],
      [{ startsAt: "x" }, "invalid_time"],
      [{ startsAt: at(2), endsAt: at(1) }, "invalid_time"],
    ] as const) expect(await create(su.cookie, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { error } });
    for (const qs of ["?limit=0", "?limit=x", "?cursor=bad"]) expect((await list(su.cookie, qs)).status).toBe(400);
    expect((await db.platformMaintenanceWindow.count())).toBe(0);
  });

  it("예약 여러 건은 시작 이른 순. 지금 상태 사본은 가장 이른 예약을 따르고, 취소하면 다음 예약으로 옮겨 간다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const late = await create(su.cookie, { startsAt: at(5), endsAt: at(6), message: "늦은 점검" });
    const early = await create(su.cookie, { startsAt: at(2), endsAt: at(3), message: "이른 점검" });
    const l = await list(su.cookie);
    expect(l.body.upcoming.map((w: { id: string }) => w.id)).toEqual([early.body.window.id, late.body.window.id]);
    expect(l.body.upcoming[0]).toMatchObject({ phase: "SCHEDULED", kind: "SCHEDULED", reason: "서버 증설", message: "이른 점검" });
    expect(await mirror()).toMatchObject({ enabled: true, message: "이른 점검" });
    expect((await adminGet(req("/api/admin/settings/maintenance", su.cookie)).then(json)).body.maintenance).toMatchObject({ enabled: true, active: false, scheduled: true });

    expect((await act(cancelRoute, "cancel", su.cookie, early.body.window.id)).body.window).toMatchObject({ phase: "CANCELED", affectedBroadcasts: null });
    expect(await mirror()).toMatchObject({ enabled: true, message: "늦은 점검" });
    expect((await act(cancelRoute, "cancel", su.cookie, early.body.window.id)).status).toBe(409);
    expect((await act(cancelRoute, "cancel", su.cookie, late.body.window.id)).status).toBe(200);
    expect(await mirror()).toMatchObject({ enabled: false, message: "" });
    expect((await list(su.cookie)).body).toMatchObject({ upcoming: [], history: [{ phase: "CANCELED" }, { phase: "CANCELED" }] });
    expect((await act(cancelRoute, "cancel", su.cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await act(cancelRoute, "cancel", su.cookie, "bad")).status).toBe(404);
  });

  it("즉시 켜기 → 점검 중. 중복 즉시 켜기 409, 진행 중은 취소가 아니라 종료. 종료하면 겹친 방송 수가 이력에 남고 방송은 끊기지 않는다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const a = await createSeller();
    const b = await createSeller();
    const live = await db.broadcastSession.create({ data: { sellerId: a.seller.id, status: "LIVE", startedAt: new Date(Date.now() - 600_000) } });
    await db.broadcastSession.create({ data: { sellerId: b.seller.id, status: "ENDED", startedAt: new Date(Date.now() - 7200_000), endedAt: new Date(Date.now() - 3600_000) } });
    expect((await list(su.cookie)).body.live).toMatchObject({ broadcasts: 1, waitingOrders: 0 });

    const on = await create(su.cookie, {});
    expect(on).toMatchObject({ status: 201, body: { window: { phase: "ACTIVE", kind: "IMMEDIATE" } } });
    expect(await mirror()).toMatchObject({ enabled: true });
    expect((await create(su.cookie, {})).body.error).toBe("already_active");
    expect((await act(cancelRoute, "cancel", su.cookie, on.body.window.id)).body.error).toBe("not_open");
    // 방송은 자동으로 끝나지 않는다
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("LIVE");

    const off = await act(endRoute, "end", su.cookie, on.body.window.id);
    expect(off).toMatchObject({ status: 200, body: { window: { phase: "ENDED", affectedBroadcasts: 1 } } });
    expect(off.body.window.endedAt).toBeTruthy();
    expect(await mirror()).toMatchObject({ enabled: false });
    expect((await act(endRoute, "end", su.cookie, on.body.window.id)).body.error).toBe("not_open");
    const h = (await list(su.cookie)).body.history;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ kind: "IMMEDIATE", affectedBroadcasts: 1, endedByName: expect.any(String) });
    const actions = (await db.auditLog.findMany({ where: { action: { startsWith: "platform.maintenance.window." } }, orderBy: { createdAt: "asc" } })).map((x) => x.action);
    expect(actions).toEqual(["platform.maintenance.window.create", "platform.maintenance.window.end"]);
  });

  it("시작 전 예약은 종료가 아니라 취소로만 닫힌다. 열려 있는 점검은 20건까지", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const w = await create(su.cookie, { startsAt: at(1) });
    expect((await act(endRoute, "end", su.cookie, w.body.window.id)).body.error).toBe("not_open");
    await db.platformMaintenanceWindow.createMany({ data: Array.from({ length: 19 }, (_, i) => ({ message: "m", reason: "r", startsAt: new Date(Date.now() + (i + 2) * 3600_000) })) });
    expect(await create(su.cookie, { startsAt: at(100) })).toMatchObject({ status: 409, body: { error: "too_many" } });
  });

  it("이력은 최근 종료 순 쪽 나누기(cursor)로 빠짐·겹침 없이 끝까지", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const base = Date.now() - 10 * 86_400_000;
    await db.platformMaintenanceWindow.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({ message: "m", reason: "r", startsAt: new Date(base + i * 3600_000), status: "ENDED" as const, endedAt: new Date(base + i * 3600_000 + 1800_000), affectedBroadcasts: i })),
    });
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const r = await list(su.cookie, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.body.history.map((x: { affectedBroadcasts: number }) => x.affectedBroadcasts));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([4, 3, 2, 1, 0]);
  });

  it("이전 방식 PUT도 같은 창으로 남는다: 켜면 창 1건, 다시 켜면 이전 창은 종료, 끄면 종료", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const put = async (body: unknown) => json(await adminPut(req("/api/admin/settings/maintenance", su.cookie, "PUT", body)));
    expect((await put({ enabled: true, message: "점검합니다", expectedVersion: 0 })).status).toBe(200);
    expect((await list(su.cookie)).body.upcoming).toMatchObject([{ phase: "ACTIVE", kind: "IMMEDIATE", message: "점검합니다" }]);
    const v = (await mirror())!.version;
    expect((await put({ enabled: true, message: "문구 수정", expectedVersion: v })).status).toBe(200);
    const l = (await list(su.cookie)).body;
    expect(l.upcoming).toMatchObject([{ message: "문구 수정" }]);
    expect(l.history).toHaveLength(1);
    expect((await put({ enabled: false, message: "", expectedVersion: (await mirror())!.version })).status).toBe(200);
    const done = (await list(su.cookie)).body;
    expect(done.upcoming).toEqual([]);
    expect(done.history).toHaveLength(2);
    expect(await mirror()).toMatchObject({ enabled: false });
  });
});
