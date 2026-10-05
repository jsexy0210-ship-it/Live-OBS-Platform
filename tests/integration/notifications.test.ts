import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminGet } from "../../app/api/admin/notifications/route";
import { GET as sellerGet } from "../../app/api/seller/notifications/route";
import { POST as sellerRead } from "../../app/api/seller/notifications/read/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 알림 센터(SA-130 · MA-002): 파트너스는 새 공지(파트너스·전체 대상 게시분 최근 14일)와 문의 답변을 처리 화면 링크와 함께 받고,
// 다른 쇼핑몰·직원의 남의 문의는 보지 못한다. 공지는 알림 센터를 열면 읽음, 문의 답변은 문의를 열어야 읽음. 마스터는 답변 대기 문의를 본다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const req = (path: string, cookie: string, method = "GET") => new Request(BASE + path, { method, headers: { ...H, cookie } });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
async function login(sellerId: string, kind: "OWNER" | "STAFF") {
  const u = await createSellerUser(sellerId, kind === "OWNER" ? "OWNER" : { permissions: [] });
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { id: u.id, cookie: `lo_seller=${r.token}` };
}
async function adminCookie(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const feed = async (cookie: string) => json(await sellerGet(req("/api/seller/notifications", cookie)));
const DAY = 86_400_000;

async function notice(adminId: string, o: { title: string; audience?: "PARTNERS" | "PUBLIC" | "ALL"; publishedAt?: Date | null; deletedAt?: Date | null }) {
  return db.platformNotice.create({
    data: {
      title: o.title,
      body: "본문",
      category: "GENERAL",
      audience: o.audience ?? "PARTNERS",
      publishedAt: o.publishedAt === undefined ? new Date() : o.publishedAt,
      deletedAt: o.deletedAt ?? null,
      createdByAdminId: adminId,
      updatedByAdminId: adminId,
    },
  });
}
async function inquiry(sellerId: string, userId: string, o: { title: string; status?: "OPEN" | "ANSWERED"; adminAt?: Date | null; readAt?: Date | null }) {
  return db.platformInquiry.create({
    data: {
      sellerId,
      createdBySellerUserId: userId,
      category: "BILLING",
      title: o.title,
      status: o.status ?? "OPEN",
      lastAdminMessageAt: o.adminAt ?? null,
      sellerReadAt: o.readAt ?? null,
    },
  });
}

describe("파트너스 알림 센터", () => {
  it("로그인 없이는 401. 공지는 대상이 맞고 게시된 최근 14일 것만, 처리 화면 링크가 붙는다", async () => {
    const { seller } = await createSeller();
    const owner = await login(seller.id, "OWNER");
    const su = await adminCookie("SUPER_ADMIN");
    expect((await feed("")).status).toBe(401);
    const n1 = await notice(su.id, { title: "새 기능 안내" });
    await notice(su.id, { title: "전체 대상", audience: "ALL" });
    await notice(su.id, { title: "공개만", audience: "PUBLIC" });
    await notice(su.id, { title: "임시 저장", publishedAt: null });
    await notice(su.id, { title: "지운 공지", deletedAt: new Date() });
    await notice(su.id, { title: "오래된 공지", publishedAt: new Date(Date.now() - 15 * DAY) });
    const r = await feed(owner.cookie);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { title: string }) => i.title).sort()).toEqual(["새 기능 안내", "전체 대상"]);
    expect(r.body.items.find((i: { id: string }) => i.id === `notice:${n1.id}`)).toMatchObject({ kind: "NOTICE", href: `/seller/notices/${n1.id}`, unread: true });
    expect(r.body.unreadCount).toBe(2);
  });

  it("알림 센터를 열었다고 남기면 공지는 읽음, 그 뒤 새 공지는 안 읽음", async () => {
    const { seller } = await createSeller();
    const owner = await login(seller.id, "OWNER");
    const su = await adminCookie("SUPER_ADMIN");
    await notice(su.id, { title: "이전 공지", publishedAt: new Date(Date.now() - 1000) });
    expect((await json(await sellerRead(req("/api/seller/notifications/read", owner.cookie, "POST")))).status).toBe(200);
    expect((await feed(owner.cookie)).body).toMatchObject({ unreadCount: 0 });
    await notice(su.id, { title: "새 공지", publishedAt: new Date(Date.now() + 5000) });
    const r = await feed(owner.cookie);
    expect(r.body.unreadCount).toBe(1);
    expect(r.body.items[0]).toMatchObject({ title: "새 공지", unread: true });
    expect(await db.sellerNotificationSeen.count()).toBe(1);
  });

  it("문의 답변은 열기 전까지 안 읽음이고, 답변 없는 문의는 나오지 않는다. 대표자는 쇼핑몰 전체, 직원은 자기 문의만, 다른 쇼핑몰은 안 보인다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const owner = await login(a.seller.id, "OWNER");
    const staff = await login(a.seller.id, "STAFF");
    const other = await login(b.seller.id, "OWNER");
    const t = new Date(Date.now() - 60_000);
    const mine = await inquiry(a.seller.id, staff.id, { title: "직원 문의", status: "ANSWERED", adminAt: t });
    const ownerOwn = await inquiry(a.seller.id, owner.id, { title: "대표 문의", status: "ANSWERED", adminAt: t, readAt: new Date() });
    await inquiry(a.seller.id, owner.id, { title: "답변 전", status: "OPEN" });
    await inquiry(b.seller.id, other.id, { title: "남의 쇼핑몰 문의", status: "ANSWERED", adminAt: t });
    const o = await feed(owner.cookie);
    expect(o.body.items.map((i: { title: string }) => i.title).sort()).toEqual(["대표 문의", "직원 문의"]);
    expect(o.body.items.find((i: { id: string }) => i.id === `inquiry:${mine.id}`)).toMatchObject({ kind: "INQUIRY_REPLY", href: `/seller/inquiries/${mine.id}`, unread: true });
    expect(o.body.items.find((i: { id: string }) => i.id === `inquiry:${ownerOwn.id}`)).toMatchObject({ unread: false });
    expect(o.body.unreadCount).toBe(1);
    const s = await feed(staff.cookie);
    expect(s.body.items.map((i: { title: string }) => i.title)).toEqual(["직원 문의"]);
    expect((await feed(other.cookie)).body.items.map((i: { title: string }) => i.title)).toEqual(["남의 쇼핑몰 문의"]);
  });
});

describe("마스터 알림 센터", () => {
  it("전 역할이 보고 로그인 없이는 401. 답변 대기(OPEN) 문의만 처리 화면 링크와 함께 나온다", async () => {
    const { seller } = await createSeller();
    const owner = await login(seller.id, "OWNER");
    const waiting = await inquiry(seller.id, owner.id, { title: "답변 부탁드립니다", status: "OPEN" });
    await inquiry(seller.id, owner.id, { title: "답변 끝", status: "ANSWERED", adminAt: new Date() });
    expect((await json(await adminGet(req("/api/admin/notifications", "")))).status).toBe(401);
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      const a = await adminCookie(role);
      const r = await json(await adminGet(req("/api/admin/notifications", a.cookie)));
      expect(r.status).toBe(200);
      expect(r.body.unreadCount).toBe(1);
      expect(r.body.items).toEqual([expect.objectContaining({ id: `inquiry:${waiting.id}`, kind: "INQUIRY_WAITING", href: `/admin/support/inquiries/${waiting.id}`, unread: true })]);
    }
  });

  it("파트너스 로그인으로는 마스터 알림을 볼 수 없다", async () => {
    const { seller } = await createSeller();
    const owner = await login(seller.id, "OWNER");
    expect([401, 403]).toContain((await json(await adminGet(req("/api/admin/notifications", owner.cookie)))).status);
  });
});
