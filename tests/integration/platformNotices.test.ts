import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as adminDelete, GET as adminGetOne, PUT as adminPut } from "../../app/api/admin/platform-notices/[noticeId]/route";
import { GET as adminList, POST as adminPost } from "../../app/api/admin/platform-notices/route";
import { GET as publicGetOne } from "../../app/api/notices/[noticeId]/route";
import { GET as publicList } from "../../app/api/notices/route";
import { GET as sellerGetOne } from "../../app/api/seller/platform-notices/[noticeId]/route";
import { GET as sellerList } from "../../app/api/seller/platform-notices/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { PAGE_SIZE } from "../../lib/server/platform-notices/service";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 플랫폼 공지(MA-053·054 · SA-111·112 · PF-005·006): 권한(작성은 최고관리자·CS), 임시 저장·게시·대상, 고정, 커서, version 충돌, 삭제, 로그 추적.
beforeEach(resetDb);
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
async function sellerCookie() {
  const { seller } = await createSeller();
  const staff = await createSellerUser(seller.id, { permissions: [] });
  const r = await loginSeller(db, { email: staff.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { seller, cookie: `lo_seller=${r.token}` };
}
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const id = (noticeId: string) => ({ params: Promise.resolve({ noticeId }) });
const draft = { title: "정기 점검 안내", body: "10월 10일 새벽 2시부터\n4시까지 점검합니다.", category: "MAINTENANCE", audience: "ALL" };
async function create(cookie: string, body: Record<string, unknown>) {
  const r = await adminPost(req("/api/admin/platform-notices", cookie, "POST", body));
  return { status: r.status, body: await r.json() };
}
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

describe("플랫폼 공지 쓰기·권한", () => {
  it("작성·수정·삭제는 최고관리자·CS만, 보기는 모든 역할. 바꿀 때마다 로그 추적에 남는다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const cs = await adminCookie("CS");
    const ops = await adminCookie("OPERATIONS");
    const ro = await adminCookie("READ_ONLY");
    for (const a of [ops, ro]) expect((await create(a.cookie, draft)).status).toBe(403);
    const made = await create(cs.cookie, draft);
    expect(made.status).toBe(201);
    expect(made.body.notice).toMatchObject({ title: "정기 점검 안내", status: "draft", publishedAt: null, channels: ["IN_APP"], version: 0, audience: "ALL" });
    const nid = made.body.notice.id;
    for (const a of [ops, ro]) {
      expect((await adminGetOne(req(`/api/admin/platform-notices/${nid}`, a.cookie), id(nid))).status).toBe(200);
      expect((await adminPut(req(`/api/admin/platform-notices/${nid}`, a.cookie, "PUT", { ...draft, expectedVersion: 0 }), id(nid))).status).toBe(403);
      expect((await adminDelete(req(`/api/admin/platform-notices/${nid}?expectedVersion=0`, a.cookie, "DELETE"), id(nid))).status).toBe(403);
    }
    const listed = await json(await adminList(req("/api/admin/platform-notices", ro.cookie)));
    expect(listed.body.items.map((n: { id: string }) => n.id)).toEqual([nid]);
    const upd = await json(await adminPut(req(`/api/admin/platform-notices/${nid}`, su.cookie, "PUT", { ...draft, title: "점검 시간 변경", publish: true, expectedVersion: 0 }), id(nid)));
    expect(upd.body.notice).toMatchObject({ title: "점검 시간 변경", status: "published", version: 1 });
    expect(await db.auditLog.findMany({ where: { targetType: "PlatformNotice", targetId: nid }, orderBy: { createdAt: "asc" }, select: { action: true, actorId: true } })).toEqual([
      { action: "platform.notice.create", actorId: cs.id },
      { action: "platform.notice.update", actorId: su.id },
    ]);
    // 로그인 안 한 요청은 401
    expect((await adminList(req("/api/admin/platform-notices", ""))).status).toBe(401);
  });

  it("입력이 틀리면 400(문구 포함), 다른 창에서 먼저 고쳤으면 409 currentVersion, 지우면 어디에도 안 보인다", async () => {
    const cs = await adminCookie("CS");
    for (const bad of [{ ...draft, title: "" }, { ...draft, body: "x".repeat(10_001) }, { ...draft, category: "NOPE" }, { ...draft, audience: "BUYERS" }]) {
      const r = await create(cs.cookie, bad);
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/주십시오$/);
    }
    const nid = (await create(cs.cookie, { ...draft, publish: true })).body.notice.id;
    expect((await adminPut(req(`/api/admin/platform-notices/${nid}`, cs.cookie, "PUT", { ...draft, publish: true, expectedVersion: 0 }), id(nid))).status).toBe(200);
    const stale = await json(await adminPut(req(`/api/admin/platform-notices/${nid}`, cs.cookie, "PUT", { ...draft, title: "덮어쓰기", publish: true, expectedVersion: 0 }), id(nid)));
    expect(stale).toEqual({ status: 409, body: { error: "version_conflict", message: expect.any(String), currentVersion: 1 } });
    expect((await adminDelete(req(`/api/admin/platform-notices/${nid}?expectedVersion=0`, cs.cookie, "DELETE"), id(nid))).status).toBe(409);
    expect((await adminDelete(req(`/api/admin/platform-notices/${nid}?expectedVersion=1`, cs.cookie, "DELETE"), id(nid))).status).toBe(200);
    expect((await adminGetOne(req(`/api/admin/platform-notices/${nid}`, cs.cookie), id(nid))).status).toBe(404);
    expect((await json(await adminList(req("/api/admin/platform-notices", cs.cookie)))).body.items).toEqual([]);
    expect((await publicGetOne(new Request(`${BASE}/api/notices/${nid}`), id(nid))).status).toBe(404);
    expect(await db.auditLog.count({ where: { action: "platform.notice.delete", targetId: nid } })).toBe(1);
  });

  it("동시에 같은 version으로 두 번 고치면 하나만 된다", async () => {
    const cs = await adminCookie("CS");
    const nid = (await create(cs.cookie, draft)).body.notice.id;
    const rs = await Promise.all(
      ["가", "나"].map((t) => adminPut(req(`/api/admin/platform-notices/${nid}`, cs.cookie, "PUT", { ...draft, title: t, expectedVersion: 0 }), id(nid))),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.platformNotice.findUniqueOrThrow({ where: { id: nid } })).version).toBe(1);
  });
});

describe("파트너스·공개 공지", () => {
  it("게시된 공지만 대상에 맞게 보인다: 파트너스는 PARTNERS·ALL, 공개는 PUBLIC·ALL. 임시 저장은 어디에도 없다", async () => {
    const cs = await adminCookie("CS");
    const p = await sellerCookie();
    const mk = async (title: string, audience: string, publish = true) => (await create(cs.cookie, { ...draft, title, audience, publish })).body.notice.id as string;
    const forPartners = await mk("파트너스 공지", "PARTNERS");
    const forPublic = await mk("공개 공지", "PUBLIC");
    const forAll = await mk("전체 공지", "ALL");
    const hidden = await mk("임시 공지", "ALL", false);
    const sl = await json(await sellerList(req("/api/seller/platform-notices", p.cookie)));
    expect(sl.status).toBe(200);
    expect(sl.body.items.map((n: { title: string }) => n.title)).toEqual(["전체 공지", "파트너스 공지"]);
    expect(sl.body.items[0]).not.toHaveProperty("body");
    expect(sl.body.items[0]).not.toHaveProperty("audience");
    const pl = await json(await publicList(new Request(`${BASE}/api/notices`)));
    expect(pl.body.items.map((n: { title: string }) => n.title)).toEqual(["전체 공지", "공개 공지"]);
    const one = await json(await sellerGetOne(req(`/api/seller/platform-notices/${forAll}`, p.cookie), id(forAll)));
    expect(one.body.notice).toMatchObject({ title: "전체 공지", body: draft.body, category: "MAINTENANCE", channels: ["IN_APP"] });
    expect(one.body.notice).not.toHaveProperty("createdByAdminId");
    expect((await sellerGetOne(req(`/api/seller/platform-notices/${forPublic}`, p.cookie), id(forPublic))).status).toBe(404);
    expect((await sellerGetOne(req(`/api/seller/platform-notices/${hidden}`, p.cookie), id(hidden))).status).toBe(404);
    expect((await publicGetOne(new Request(`${BASE}/api/notices/${forPartners}`), id(forPartners))).status).toBe(404);
    expect((await publicGetOne(new Request(`${BASE}/api/notices/${hidden}`), id(hidden))).status).toBe(404);
    expect((await publicGetOne(new Request(`${BASE}/api/notices/not-a-uuid`), id("not-a-uuid"))).status).toBe(404);
    // 파트너스 로그인 없이는 401
    expect((await sellerList(req("/api/seller/platform-notices", ""))).status).toBe(401);
  });

  it("이용 정지·구독 잠김 중인 파트너스도 공지를 본다", async () => {
    const cs = await adminCookie("CS");
    await create(cs.cookie, { ...draft, publish: true });
    const p = await sellerCookie();
    await db.seller.update({ where: { id: p.seller.id }, data: { status: "SUSPENDED", trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
    const r = await json(await sellerList(req("/api/seller/platform-notices", p.cookie)));
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
  });

  it("고정 공지는 첫 쪽에 따로, 나머지는 게시일 최신순 20건씩 커서로 이어진다. 처음 게시일은 고쳐도 그대로", async () => {
    const cs = await adminCookie("CS");
    const base = Date.now() - 100_000;
    for (let i = 0; i < PAGE_SIZE + 3; i++) {
      await db.platformNotice.create({
        data: { ...draft, category: "GENERAL", audience: "ALL", title: `공지 ${i}`, publishedAt: new Date(base + i * 1000), createdByAdminId: cs.id, updatedByAdminId: cs.id },
      } as never);
    }
    const pin = (await create(cs.cookie, { ...draft, title: "고정", isPinned: true, publish: true })).body.notice;
    const first = await json(await publicList(new Request(`${BASE}/api/notices`)));
    expect(first.body.pinned.map((n: { title: string }) => n.title)).toEqual(["고정"]);
    expect(first.body.items).toHaveLength(PAGE_SIZE);
    expect(first.body.items[0].title).toBe(`공지 ${PAGE_SIZE + 2}`);
    const second = await json(await publicList(new Request(`${BASE}/api/notices?cursor=${encodeURIComponent(first.body.nextCursor)}`)));
    expect(second.body.pinned).toEqual([]);
    expect(second.body.items.map((n: { title: string }) => n.title)).toEqual(["공지 2", "공지 1", "공지 0"]);
    expect(second.body.nextCursor).toBeNull();
    expect((await publicList(new Request(`${BASE}/api/notices?cursor=bad`))).status).toBe(400);
    const upd = await json(await adminPut(req(`/api/admin/platform-notices/${pin.id}`, cs.cookie, "PUT", { ...draft, title: "고정(수정)", isPinned: true, publish: true, expectedVersion: 0 }), id(pin.id)));
    expect(upd.body.notice.publishedAt).toBe(pin.publishedAt);
  });

  it("공개 번호 페이지는 고정을 한 번만 분리하고 분류별 공개 일반 공지 수를 계산한다", async () => {
    const cs = await adminCookie("CS");
    const now = Date.now() - 100_000;
    const add = (title: string, options: { category?: string; audience?: string; isPinned?: boolean; publishedAt?: Date | null; deletedAt?: Date | null } = {}) =>
      db.platformNotice.create({
        data: {
          ...draft,
          title,
          category: options.category ?? "MAINTENANCE",
          audience: options.audience ?? "PUBLIC",
          isPinned: options.isPinned ?? false,
          publishedAt: options.publishedAt === undefined ? new Date(now) : options.publishedAt,
          deletedAt: options.deletedAt ?? null,
          createdByAdminId: cs.id,
          updatedByAdminId: cs.id,
        } as never,
      });

    for (let i = 0; i < 6; i++) await add(`점검 ${i}`, { publishedAt: new Date(now + i * 1000) });
    for (let i = 0; i < 2; i++) await add(`정책 ${i}`, { category: "POLICY", publishedAt: new Date(now + 10_000 + i * 1000) });
    const pinned = await add("고정 점검", { isPinned: true, publishedAt: new Date(now + 20_000) });
    const partnerOnly = await add("파트너스 전용", { audience: "PARTNERS", publishedAt: new Date(now + 30_000) });
    const draftNotice = await add("임시 저장", { publishedAt: null });
    const deleted = await add("삭제된 공지", { publishedAt: new Date(now + 40_000), deletedAt: new Date() });
    const future = await add("예약 기간 전 공지", { publishedAt: new Date(Date.now() + 86_400_000) });

    const first = await json(await publicList(new Request(`${BASE}/api/notices?page=1&pageSize=5`)));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 5, total: 8, pageCount: 2 });
    expect(first.body.items).toHaveLength(5);
    expect(first.body.pinned.map((n: { title: string }) => n.title)).toEqual(["고정 점검"]);
    expect(first.body.items.map((n: { id: string }) => n.id)).not.toContain(pinned.id);

    const second = await json(await publicList(new Request(`${BASE}/api/notices?page=2&pageSize=5`)));
    expect(second.body).toMatchObject({ page: 2, pageSize: 5, total: 8, pageCount: 2, pinned: [] });
    expect(second.body.items).toHaveLength(3);

    const maintenance = await json(await publicList(new Request(`${BASE}/api/notices?page=1&category=MAINTENANCE`)));
    expect(maintenance.body).toMatchObject({ page: 1, pageSize: 5, total: 6, pageCount: 2 });
    expect(maintenance.body.items).toHaveLength(5);
    expect(maintenance.body.pinned.map((n: { id: string }) => n.id)).toEqual([pinned.id]);
    const maintenanceSecond = await json(await publicList(new Request(`${BASE}/api/notices?page=2&category=MAINTENANCE`)));
    expect(maintenanceSecond.body).toMatchObject({ page: 2, total: 6, pageCount: 2, pinned: [] });
    expect(maintenanceSecond.body.items).toHaveLength(1);

    expect((await publicList(new Request(`${BASE}/api/notices?page=0`))).status).toBe(400);
    for (const hidden of [partnerOnly, draftNotice, deleted, future]) {
      expect((await publicGetOne(new Request(`${BASE}/api/notices/${hidden.id}`), id(hidden.id))).status).toBe(404);
    }
  });

  it("공개 상세는 정본 작성자와 공개 가능한 이전·다음 제목만 주고 본문 원문을 보존한다", async () => {
    const cs = await adminCookie("CS");
    const now = Date.now() - 100_000;
    const add = (title: string, publishedAt: Date | null, options: { audience?: string; deletedAt?: Date | null; body?: string } = {}) =>
      db.platformNotice.create({
        data: {
          ...draft,
          title,
          body: options.body ?? "본문",
          audience: options.audience ?? "PUBLIC",
          publishedAt,
          deletedAt: options.deletedAt ?? null,
          createdByAdminId: cs.id,
          updatedByAdminId: cs.id,
        } as never,
      });
    const older = await add("이전 공개 공지", new Date(now));
    const rawBody = "첫 줄\n둘째 <b>원문</b> & 그대로";
    const current = await add("제목 원문", new Date(now + 20_000), { body: rawBody });
    const newer = await add("다음 공개 공지", new Date(now + 40_000));
    const partner = await add("파트너 전용 최신 공지", new Date(now + 50_000), { audience: "PARTNERS" });
    const deleted = await add("삭제된 최신 공지", new Date(now + 60_000), { deletedAt: new Date() });
    const future = await add("게시 기간 전", new Date(Date.now() + 86_400_000));

    const result = await json(await publicGetOne(new Request(`${BASE}/api/notices/${current.id}`), id(current.id)));
    expect(result.status).toBe(200);
    expect(result.body.notice).toMatchObject({
      id: current.id,
      title: "제목 원문",
      body: rawBody,
      author: "ONQ 운영팀",
      prev: { id: newer.id, title: "다음 공개 공지" },
      next: { id: older.id, title: "이전 공개 공지" },
    });
    expect(result.body.notice).not.toHaveProperty("createdByAdminId");
    expect(result.body.notice).not.toHaveProperty("audience");
    for (const hidden of [partner, deleted, future]) {
      expect(result.body.notice.prev.id).not.toBe(hidden.id);
      expect(result.body.notice.next.id).not.toBe(hidden.id);
    }
  });
});
