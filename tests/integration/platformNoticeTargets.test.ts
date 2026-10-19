import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as sellerGetOne } from "../../app/api/seller/platform-notices/[noticeId]/route";
import { POST as sellerRead } from "../../app/api/seller/platform-notices/[noticeId]/read/route";
import { GET as sellerList } from "../../app/api/seller/platform-notices/route";
import { GET as sellerFile } from "../../app/api/seller/platform-notices/[noticeId]/files/[fileId]/route";
import { requireSeller } from "../../lib/server/authz/guards";
import { loginSeller } from "../../lib/server/auth/login";
import { listSellerNotifications } from "../../lib/server/notifications/service";
import { createInquiry, getMyInquiry } from "../../lib/server/platform-inquiries/service";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { createPlatformNotice, getAdminNotice, listAdminNotices, sellerNoticeFile, TARGETS_MAX, updatePlatformNotice } from "../../lib/server/platform-notices/service";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 공지 대상 파트너스(MA-053·054): 명시 ALL/SPECIFIC, 빈 특정 초안과 기존 전체 공지의 호환을 구분한다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const get = (path: string, cookie: string) => new Request(BASE + path, { headers: { ...H, cookie } });
const post = (path: string, cookie: string) => new Request(BASE + path, { method: "POST", headers: { ...H, cookie, "content-type": "application/json" }, body: "{}" });
const idp = (noticeId: string) => ({ params: Promise.resolve({ noticeId }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

async function adminCtx(role: "SUPER_ADMIN" | "CS" | "OPERATIONS" = "CS") {
  const a = await createAdmin(role);
  const s = await createAdminSession(db, a.id, {});
  return (await resolveAdminSession(db, s.token))!;
}
async function shop() {
  const { seller } = await createSeller();
  const u = await createSellerUser(seller.id, "OWNER");
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { seller, cookie: `lo_seller=${r.token}` };
}
const input = (over: Record<string, unknown> = {}) => ({ title: "공지", body: "본문", category: "GENERAL", audience: "PARTNERS", publish: true, ...over });

describe("공지 대상 파트너스", () => {
  it("대상을 지정하면 그 파트너스만 목록·상세·읽음·미확인 수·첨부에서 보고, 대상이 없는 공지는 모두 본다", async () => {
    const admin = await adminCtx();
    const a = await shop();
    const b = await shop();
    const all = await createPlatformNotice(db, admin, input({ title: "전체 공지" }));
    const only = await createPlatformNotice(db, admin, input({ title: "A 전용", targetMode: "SPECIFIC", targetSellerIds: [a.seller.id.toUpperCase(), a.seller.id] }));
    if (!all.ok || !only.ok) throw new Error("create");
    expect(only.notice.targetSellerIds).toEqual([a.seller.id]);
    expect(only.notice.targetMode).toBe("SPECIFIC");
    expect(all.notice.targetSellerIds).toEqual([]);
    expect(all.notice.targetMode).toBe("ALL");
    const file = await db.platformNoticeFile.create({ data: { noticeId: only.notice.id, name: "a.pdf", data: Buffer.from("x"), contentType: "application/pdf", byteSize: 1, createdByAdminId: admin.admin.id } });

    const la = await json(await sellerList(get("/api/seller/platform-notices", a.cookie)));
    expect(la.body.items.map((x: { id: string }) => x.id).sort()).toEqual([all.notice.id, only.notice.id].sort());
    expect(la.body.unreadCount).toBe(2);
    const lb = await json(await sellerList(get("/api/seller/platform-notices", b.cookie)));
    expect(lb.body.items.map((x: { id: string }) => x.id)).toEqual([all.notice.id]);
    expect(lb.body.unreadCount).toBe(1);

    expect((await json(await sellerGetOne(get(`/api/seller/platform-notices/${only.notice.id}`, a.cookie), idp(only.notice.id)))).status).toBe(200);
    expect((await json(await sellerGetOne(get(`/api/seller/platform-notices/${only.notice.id}`, b.cookie), idp(only.notice.id)))).status).toBe(404);
    expect((await json(await sellerRead(post(`/api/seller/platform-notices/${only.notice.id}/read`, b.cookie), idp(only.notice.id)))).status).toBe(404);
    expect((await json(await sellerRead(post(`/api/seller/platform-notices/${only.notice.id}/read`, a.cookie), idp(only.notice.id)))).status).toBe(200);
    // 전체 공지의 이전/다음·관련에도 남의 전용 공지가 끼지 않는다
    const detailB = await json(await sellerGetOne(get(`/api/seller/platform-notices/${all.notice.id}`, b.cookie), idp(all.notice.id)));
    expect(JSON.stringify(detailB.body)).not.toContain(only.notice.id);
    expect(await sellerNoticeFile(db, a.seller.id, only.notice.id, file.id)).not.toBeNull();
    expect(await sellerNoticeFile(db, b.seller.id, only.notice.id, file.id)).toBeNull();
    const filePath = `/api/seller/platform-notices/${only.notice.id}/files/${file.id}`;
    const fileParams = { params: Promise.resolve({ noticeId: only.notice.id, fileId: file.id }) };
    expect((await sellerFile(get(filePath, a.cookie), fileParams)).status).toBe(200);
    expect((await sellerFile(get(filePath, b.cookie), fileParams)).status).toBe(404);
  });

  it("알림 목록에도 대상이 아닌 파트너스에게는 전용 공지가 나오지 않는다", async () => {
    const admin = await adminCtx();
    const a = await shop();
    const b = await shop();
    const only = await createPlatformNotice(db, admin, input({ title: "A 전용 알림", targetMode: "SPECIFIC", targetSellerIds: [a.seller.id] }));
    if (!only.ok) throw new Error("create");
    const titles = async (cookie: string) => {
      const ctx = await requireSeller(db, cookie.replace("lo_seller=", ""));
      const r = await listSellerNotifications(db, ctx);
      return JSON.stringify(r);
    };
    expect(await titles(a.cookie)).toContain("A 전용 알림");
    expect(await titles(b.cookie)).not.toContain("A 전용 알림");
  });

  it("빈 특정 초안은 전체 공지로 바뀌지 않고 게시를 막으며, 대상 필드가 없는 수정은 기존 대상을 유지한다", async () => {
    const admin = await adminCtx();
    const a = await shop();
    const draft = await createPlatformNotice(db, admin, input({ publish: false, targetMode: "SPECIFIC", targetSellerIds: [] }));
    if (!draft.ok) throw new Error("create");
    expect([draft.notice.targetMode, draft.notice.targetSellerIds, draft.notice.status]).toEqual(["SPECIFIC", [], "draft"]);
    expect(await updatePlatformNotice(db, admin, draft.notice.id, input({ expectedVersion: draft.notice.version }))).toMatchObject({ ok: false, reason: "invalid_targets" });
    const list = await json(await sellerList(get("/api/seller/platform-notices", a.cookie)));
    expect([list.body.items, list.body.unreadCount]).toEqual([[], 0]);
    const made = await createPlatformNotice(db, admin, input({ targetMode: "SPECIFIC", targetSellerIds: [a.seller.id] }));
    if (!made.ok) throw new Error("create");
    const edited = await updatePlatformNotice(db, admin, made.notice.id, input({ title: "대상 유지", expectedVersion: made.notice.version }));
    expect(edited.ok && [edited.notice.targetMode, edited.notice.targetSellerIds]).toEqual(["SPECIFIC", [a.seller.id]]);
    expect(await db.platformNoticeTarget.count({ where: { noticeId: made.notice.id, sellerId: a.seller.id } })).toBe(1);
  });

  it("문의에 연결하는 공지와 조회하는 공지 제목도 현재 파트너스 대상만 허용한다", async () => {
    const admin = await adminCtx();
    const a = await shop();
    const b = await shop();
    const notice = await createPlatformNotice(db, admin, input({ targetMode: "SPECIFIC", targetSellerIds: [a.seller.id] }));
    if (!notice.ok) throw new Error("create");
    const ctxA = await requireSeller(db, a.cookie.replace("lo_seller=", ""));
    const ctxB = await requireSeller(db, b.cookie.replace("lo_seller=", ""));
    const inquiry = { category: "OTHER", title: "공지 문의", body: "공지에 대해 문의합니다", noticeId: notice.notice.id, includeDiagnostics: false };
    expect(await createInquiry(db, ctxB, inquiry)).toMatchObject({ ok: false, reason: "invalid_notice" });
    const created = await createInquiry(db, ctxA, inquiry);
    if (!created.ok) throw new Error("inquiry");
    expect((await getMyInquiry(db, ctxA, created.inquiry.id))?.notice).toEqual({ id: notice.notice.id, title: notice.notice.title });
    expect((await updatePlatformNotice(db, admin, notice.notice.id, input({ targetMode: "SPECIFIC", targetSellerIds: [b.seller.id], expectedVersion: notice.notice.version }))).ok).toBe(true);
    expect((await getMyInquiry(db, ctxA, created.inquiry.id))?.notice).toBeNull();
  });

  it("명시 대상을 바꾸고 ALL 선택으로만 전체로 전환하며, 마스터 관리자 목록·상세에 대상이 나오며 로그 추적에 개수가 남는다", async () => {
    const admin = await adminCtx();
    const a = await shop();
    const b = await shop();
    const made = await createPlatformNotice(db, admin, input({ targetMode: "SPECIFIC", targetSellerIds: [a.seller.id] }));
    if (!made.ok) throw new Error("create");
    const upd = await updatePlatformNotice(db, admin, made.notice.id, input({ targetMode: "SPECIFIC", targetSellerIds: [b.seller.id], expectedVersion: made.notice.version }));
    expect(upd.ok && upd.notice.targetSellerIds).toEqual([b.seller.id]);
    expect((await json(await sellerGetOne(get(`/api/seller/platform-notices/${made.notice.id}`, a.cookie), idp(made.notice.id)))).status).toBe(404);
    expect((await json(await sellerGetOne(get(`/api/seller/platform-notices/${made.notice.id}`, b.cookie), idp(made.notice.id)))).status).toBe(200);
    const detail = await getAdminNotice(db, admin, made.notice.id);
    expect(detail.targetSellerIds).toEqual([b.seller.id]);
    expect(detail.targetSellers).toEqual([{ id: b.seller.id, shopName: b.seller.shopName, slug: b.seller.slug }]);
    const list = await listAdminNotices(db, admin, {});
    expect(list.ok && list.items[0].targetSellerIds).toEqual([b.seller.id]);
    const log = await db.auditLog.findFirst({ where: { action: "platform.notice.update", targetId: made.notice.id } });
    expect(log?.before).toMatchObject({ targetCount: 1 });
    expect(log?.after).toMatchObject({ targetCount: 1 });

    const cleared = await updatePlatformNotice(db, admin, made.notice.id, input({ targetMode: "ALL", targetSellerIds: [], expectedVersion: upd.ok ? upd.notice.version : -1 }));
    expect(cleared.ok && cleared.notice.targetSellerIds).toEqual([]);
    expect(await db.platformNoticeTarget.count({ where: { noticeId: made.notice.id } })).toBe(0);
    expect((await json(await sellerGetOne(get(`/api/seller/platform-notices/${made.notice.id}`, a.cookie), idp(made.notice.id)))).status).toBe(200);
    // 옛 version으로 고치면 대상도 바뀌지 않는다
    const stale = await updatePlatformNotice(db, admin, made.notice.id, input({ targetMode: "SPECIFIC", targetSellerIds: [a.seller.id], expectedVersion: made.notice.version }));
    expect(stale).toMatchObject({ ok: false, reason: "version_conflict" });
    expect(await db.platformNoticeTarget.count({ where: { noticeId: made.notice.id } })).toBe(0);
  });

  it("검사: 보는 곳이 PARTNERS가 아니면 대상 지정 불가, 없는 파트너스·uuid 아님·배열 아님·너무 많음은 invalid_targets, 아무것도 만들지 않는다", async () => {
    const admin = await adminCtx();
    const a = await shop();
    const ghost = "123e4567-e89b-42d3-a456-426614174000";
    const bad = async (over: Record<string, unknown>) => {
      const r = await createPlatformNotice(db, admin, input(over));
      return r.ok ? "ok" : r.reason;
    };
    expect(await bad({ audience: "PUBLIC", targetMode: "SPECIFIC", targetSellerIds: [a.seller.id] })).toBe("invalid_targets");
    expect(await bad({ audience: "ALL", targetMode: "SPECIFIC", targetSellerIds: [a.seller.id] })).toBe("invalid_targets");
    expect(await bad({ targetMode: "SPECIFIC", targetSellerIds: [ghost] })).toBe("invalid_targets");
    expect(await bad({ targetMode: "SPECIFIC", targetSellerIds: [a.seller.id, "not-uuid"] })).toBe("invalid_targets");
    expect(await bad({ targetMode: "SPECIFIC", targetSellerIds: a.seller.id })).toBe("invalid_targets");
    expect(await bad({ targetMode: "SPECIFIC", targetSellerIds: Array.from({ length: TARGETS_MAX + 1 }, () => ghost) })).toBe("invalid_targets");
    expect(await db.platformNotice.count()).toBe(0);
    // 공개·전체 공지는 빈 배열이면 문제없다
    expect(await bad({ audience: "PUBLIC", targetMode: "ALL", targetSellerIds: [] })).toBe("ok");
    expect(await bad({ audience: "ALL" })).toBe("ok");
  });
});
