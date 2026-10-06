import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as alertList } from "../../app/api/admin/alerts/route";
import { POST as alertReadAll } from "../../app/api/admin/alerts/read-all/route";
import { POST as alertRead } from "../../app/api/admin/alerts/[alertId]/read/route";
import { POST as alertStatus } from "../../app/api/admin/alerts/[alertId]/status/route";
import { POST as sellerCreate } from "../../app/api/seller/platform-inquiries/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { createAdminAlert } from "../../lib/server/admin-alerts/service";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 마스터 관리자 알림 센터(MA-002) 저장형 알림: 만들기 도우미·목록·읽음·상태 변경, 긴급 문의가 첫 사용처
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctxOf = (alertId: string) => ({ params: Promise.resolve({ alertId }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const list = async (cookie: string, qs = "") => json(await alertList(req(`/api/admin/alerts${qs}`, cookie)));
const read = async (cookie: string, id: string) => json(await alertRead(req(`/api/admin/alerts/${id}/read`, cookie, "POST", {}), ctxOf(id)));
const readAll = async (cookie: string) => json(await alertReadAll(req("/api/admin/alerts/read-all", cookie, "POST", {})));
const setStatus = async (cookie: string, id: string, body: unknown) => json(await alertStatus(req(`/api/admin/alerts/${id}/status`, cookie, "POST", body), ctxOf(id)));

describe("createAdminAlert 도우미", () => {
  it("값 검사: 유형·링크·제목·역할이 틀리면 던지고, 같은 dedupeKey는 한 번만 만든다", async () => {
    const ok = { kind: "TEST_KIND", severity: "INFO" as const, title: "제목", linkPath: "/admin/support/inquiries" };
    for (const bad of [{ kind: "lower" }, { kind: "A" }, { title: "   " }, { linkPath: "https://evil.example/x" }, { linkPath: "/seller/x" }, { linkPath: "/admin/../x" }, { targetRoles: [] }]) {
      await expect(createAdminAlert(db, { ...ok, ...bad })).rejects.toThrow("invalid admin alert");
    }
    const a = await createAdminAlert(db, { ...ok, dedupeKey: "k1" });
    const b = await createAdminAlert(db, { ...ok, dedupeKey: "k1" });
    expect(a.created).toBe(true);
    expect(b).toEqual({ created: false, id: a.id });
    expect(await db.adminAlert.count()).toBe(1);
    // 키가 없으면 매번 만든다
    await createAdminAlert(db, ok);
    await createAdminAlert(db, ok);
    expect(await db.adminAlert.count()).toBe(3);
  });
});

describe("목록·읽음·상태", () => {
  it("보는 역할만 보고(다른 역할은 목록·읽음 모두 못 봄), 읽음은 관리자마다, 필터·건수·미읽음 수가 맞다", async () => {
    const cs = await admin("CS");
    const ops = await admin("OPERATIONS");
    const viewer = await admin("READ_ONLY");
    const s = await createSeller();
    const urgent = (await createAdminAlert(db, { kind: "BROADCAST_DOWN", severity: "URGENT", title: "방송 화면 끊김", linkPath: "/admin/sellers", sellerId: s.seller.id, targetRoles: ["SUPER_ADMIN", "OPERATIONS", "CS"], occurredAt: new Date("2026-10-06T05:00:00Z") })).id!;
    const info = (await createAdminAlert(db, { kind: "SIGNUP_LATE", severity: "INFO", title: "가입 심사 지연", linkPath: "/admin/sellers", occurredAt: new Date("2026-10-06T04:00:00Z") })).id!;

    const csList = await list(cs.cookie);
    expect(csList.body.items.map((x: { id: string }) => x.id)).toEqual([urgent, info]);
    expect(csList.body).toMatchObject({ counts: { OPEN: 2, IN_PROGRESS: 0, RESOLVED: 0 }, unreadCount: 2, nextCursor: null });
    expect(csList.body.items[0]).toMatchObject({ severity: "URGENT", shopName: s.seller.shopName, assignee: null, unread: true });
    expect(JSON.stringify(csList.body)).not.toMatch(/targetRoles|dedupeKey/);
    // 읽기 전용은 전 역할 알림만 본다
    expect((await list(viewer.cookie)).body.items.map((x: { id: string }) => x.id)).toEqual([info]);
    expect((await read(viewer.cookie, urgent)).status).toBe(404);
    expect((await setStatus(viewer.cookie, info, { status: "RESOLVED" })).status).toBe(403);

    expect((await read(cs.cookie, urgent)).status).toBe(200);
    expect((await read(cs.cookie, urgent)).status).toBe(200);
    expect((await list(cs.cookie)).body.unreadCount).toBe(1);
    expect((await list(ops.cookie)).body.unreadCount).toBe(2);
    expect((await readAll(ops.cookie)).body.marked).toBe(2);
    expect((await readAll(ops.cookie)).body.marked).toBe(0);
    expect((await list(ops.cookie)).body.unreadCount).toBe(0);
    expect((await list(cs.cookie, "?severity=INFO")).body.items.map((x: { id: string }) => x.id)).toEqual([info]);
    expect((await list(cs.cookie, "?kind=BROADCAST_DOWN")).body.items.map((x: { id: string }) => x.id)).toEqual([urgent]);
    for (const [qs, error] of [["?status=X", "invalid_status"], ["?severity=X", "invalid_severity"], ["?assignee=x", "invalid_assignee"], ["?cursor=bad", "invalid_cursor"]] as const) {
      expect((await list(cs.cookie, qs)).body.error).toBe(error);
    }
  });

  it("상태 변경: 운영·CS·최고관리자만, 처리 중이면 담당 없을 때 바꾼 사람이 담당, 해결됨은 시각을 남기고 되돌리면 지운다, 로그 추적, 같은 상태는 로그 없음", async () => {
    const cs = await admin("CS");
    const ops = await admin("OPERATIONS");
    const id = (await createAdminAlert(db, { kind: "REWARD_FAIL", severity: "WARNING", title: "지급 실패", linkPath: "/admin/payments" })).id!;

    expect((await setStatus(cs.cookie, id, { status: "DONE" })).body.error).toBe("invalid_status_change");
    expect((await setStatus(cs.cookie, "11111111-1111-4111-8111-111111111111", { status: "RESOLVED" })).status).toBe(404);
    expect((await setStatus(cs.cookie, id, { status: "IN_PROGRESS" })).status).toBe(200);
    expect((await list(cs.cookie, "?assignee=me")).body.items[0]).toMatchObject({ id, status: "IN_PROGRESS", assignee: { id: cs.id } });
    // 이미 담당이 있으면 다른 사람이 처리 중으로 바꿔도 담당은 그대로
    await setStatus(ops.cookie, id, { status: "OPEN" });
    await setStatus(ops.cookie, id, { status: "IN_PROGRESS" });
    expect((await list(cs.cookie)).body.items[0].assignee.id).toBe(cs.id);
    expect((await setStatus(ops.cookie, id, { status: "RESOLVED" })).status).toBe(200);
    expect((await db.adminAlert.findUniqueOrThrow({ where: { id } })).resolvedAt).not.toBeNull();
    expect((await list(cs.cookie, "?status=RESOLVED")).body.counts).toEqual({ OPEN: 0, IN_PROGRESS: 0, RESOLVED: 1 });
    const before = await db.auditLog.count({ where: { action: "admin_alert.status", targetId: id } });
    expect((await setStatus(ops.cookie, id, { status: "RESOLVED" })).status).toBe(200);
    expect(await db.auditLog.count({ where: { action: "admin_alert.status", targetId: id } })).toBe(before);
    await setStatus(ops.cookie, id, { status: "OPEN" });
    expect((await db.adminAlert.findUniqueOrThrow({ where: { id } })).resolvedAt).toBeNull();
  });

  it("50건씩 커서로 빠짐·겹침 없이 이어진다", async () => {
    const cs = await admin("CS");
    for (let i = 0; i < 53; i++) await createAdminAlert(db, { kind: "BULK", severity: "INFO", title: `알림 ${i}`, linkPath: "/admin", occurredAt: new Date(Date.UTC(2026, 9, 1, 0, i)) });
    const p1 = await list(cs.cookie);
    expect(p1.body.items).toHaveLength(50);
    const p2 = await list(cs.cookie, `?cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items).toHaveLength(3);
    expect(p2.body.nextCursor).toBeNull();
    expect(new Set([...p1.body.items, ...p2.body.items].map((x: { id: string }) => x.id)).size).toBe(53);
  });
});

describe("긴급 문의 → 알림", () => {
  it("긴급 문의를 보내면 최고관리자·운영·CS에게만 알림이 한 건 생기고(링크는 문의 상세), 긴급이 아니면 없다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const cookie = `lo_seller=${login.token}`;
    const NEW = { category: "BROADCAST", title: "방송 화면이 안 뜹니다", body: "OBS에 주문대기가 안 뜹니다." };
    const post = async (body: unknown) => json(await sellerCreate(req("/api/seller/platform-inquiries", cookie, "POST", body)));

    expect((await post(NEW)).status).toBe(201);
    expect(await db.adminAlert.count()).toBe(0);
    const made = await post({ ...NEW, urgent: true });
    expect(made.status).toBe(201);
    const alerts = await db.adminAlert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "INQUIRY_URGENT", severity: "URGENT", sellerId: seller.id, status: "OPEN", linkPath: `/admin/support/inquiries/${made.body.inquiry.id}`, title: "[긴급] 방송 화면이 안 뜹니다" });
    expect([...alerts[0].targetRoles].sort()).toEqual(["CS", "OPERATIONS", "SUPER_ADMIN"]);
    const viewer = await admin("READ_ONLY");
    expect((await list(viewer.cookie)).body.items).toEqual([]);
    const cs = await admin("CS");
    expect((await list(cs.cookie)).body.items[0]).toMatchObject({ kind: "INQUIRY_URGENT", severity: "URGENT", shopName: seller.shopName });
  });
});
