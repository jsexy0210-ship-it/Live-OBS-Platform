import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as adminClose } from "../../app/api/admin/platform-inquiries/[inquiryId]/close/route";
import { POST as adminReply } from "../../app/api/admin/platform-inquiries/[inquiryId]/reply/route";
import { GET as adminGetOne } from "../../app/api/admin/platform-inquiries/[inquiryId]/route";
import { GET as adminImage } from "../../app/api/admin/platform-inquiries/images/[imageId]/route";
import { GET as adminList } from "../../app/api/admin/platform-inquiries/route";
import { POST as sellerMessage } from "../../app/api/seller/platform-inquiries/[inquiryId]/messages/route";
import { GET as sellerGetOne } from "../../app/api/seller/platform-inquiries/[inquiryId]/route";
import { GET as sellerImage } from "../../app/api/seller/platform-inquiries/images/[imageId]/route";
import { POST as sellerUpload } from "../../app/api/seller/platform-inquiries/images/route";
import { GET as sellerList, POST as sellerCreate } from "../../app/api/seller/platform-inquiries/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { DAILY_LIMIT, UNATTACHED_KEEP } from "../../lib/server/platform-inquiries/service";
import { hasImageMetadata } from "../../lib/server/product-reviews/image";
import { jpeg } from "../unit/productImageFormatsFixtures";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 플랫폼 문의(SA-113·114·115 · MA-051·052): 파트너스 작성·추가 문의·보는 범위(대표자 전부, 직원 자기 것), 쇼핑몰 격리,
// 마스터 권한(보기 전 역할, 답변·종료 최고관리자·CS), 상태 흐름, version 충돌, 종료 뒤 막힘, 첨부 사진, 하루 한도(동시 포함), 잠김·정지 중 사용, 로그 추적.
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
  return { id: a.id, name: a.name, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
async function login(sellerId: string, kind: "OWNER" | "STAFF") {
  const u = await createSellerUser(sellerId, kind === "OWNER" ? "OWNER" : { permissions: [] });
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { id: u.id, cookie: `lo_seller=${r.token}` };
}
async function shop() {
  const { seller } = await createSeller();
  return { seller, owner: await login(seller.id, "OWNER"), staff: await login(seller.id, "STAFF") };
}
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const iq = (inquiryId: string) => ({ params: Promise.resolve({ inquiryId }) });
const im = (imageId: string) => ({ params: Promise.resolve({ imageId }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const NEW = { category: "SUBSCRIPTION_FEE", title: "청구 금액 문의", body: "이번 달 청구가\n두 번 나왔습니다." };

const create = async (cookie: string, body: unknown = NEW) => json(await sellerCreate(req("/api/seller/platform-inquiries", cookie, "POST", body)));
const list = async (cookie: string) => json(await sellerList(req("/api/seller/platform-inquiries", cookie)));
const detail = async (cookie: string, id: string) => json(await sellerGetOne(req(`/api/seller/platform-inquiries/${id}`, cookie), iq(id)));
const follow = async (cookie: string, id: string, body: unknown) => json(await sellerMessage(req(`/api/seller/platform-inquiries/${id}/messages`, cookie, "POST", body), iq(id)));
const reply = async (cookie: string, id: string, body: unknown) => json(await adminReply(req(`/api/admin/platform-inquiries/${id}/reply`, cookie, "POST", body), iq(id)));
const close = async (cookie: string, id: string, body: unknown) => json(await adminClose(req(`/api/admin/platform-inquiries/${id}/close`, cookie, "POST", body), iq(id)));
const upload = async (cookie: string, bytes: Buffer) =>
  json(await sellerUpload(new Request(BASE + "/api/seller/platform-inquiries/images", { method: "POST", headers: { ...H, cookie }, body: new Uint8Array(bytes) })));

describe("파트너스 문의 보내기·보는 범위", () => {
  it("직원이 보내면 답변 대기로 생기고, 대표자는 쇼핑몰 문의 전부, 다른 직원은 남의 문의를 볼 수 없다. 다른 쇼핑몰은 404", async () => {
    const a = await shop();
    const b = await shop();
    const other = await login(a.seller.id, "STAFF");
    const made = await create(a.staff.cookie);
    expect(made.status).toBe(201);
    expect(made.body.inquiry).toMatchObject({ category: "SUBSCRIPTION_FEE", title: "청구 금액 문의", status: "OPEN", notice: null, messages: [{ author: "PARTNER", authorName: "직원", body: NEW.body, images: [] }] });
    const id = made.body.inquiry.id;
    expect((await list(a.owner.cookie)).body.items).toMatchObject([{ id, status: "OPEN", hasNewReply: false }]);
    expect((await detail(a.owner.cookie, id)).status).toBe(200);
    expect((await list(other.cookie)).body.items).toEqual([]);
    expect((await detail(other.cookie, id)).status).toBe(404);
    expect((await follow(other.cookie, id, { body: "x" })).status).toBe(404);
    expect((await detail(b.owner.cookie, id)).status).toBe(404);
    expect((await follow(b.owner.cookie, id, { body: "x" })).status).toBe(404);
    expect((await list(b.owner.cookie)).body.items).toEqual([]);
    expect(await db.auditLog.count({ where: { action: "platform_inquiry.create", targetId: id, actorId: a.staff.id, sellerId: a.seller.id } })).toBe(1);
  });

  it("유형·제목·내용을 검사한다. 관련 공지는 파트너스에 게시된 공지만", async () => {
    const a = await shop();
    expect((await create(a.owner.cookie, { ...NEW, category: "REFUND" })).body.error).toBe("invalid_category");
    expect((await create(a.owner.cookie, { ...NEW, title: " " })).body.error).toBe("invalid_title");
    expect((await create(a.owner.cookie, { ...NEW, title: "가".repeat(101) })).body.error).toBe("invalid_title");
    expect((await create(a.owner.cookie, { ...NEW, body: "" })).body.error).toBe("invalid_body");
    expect((await create(a.owner.cookie, { ...NEW, body: "가".repeat(5001) })).body.error).toBe("invalid_body");
    const admin = await createAdmin("SUPER_ADMIN");
    const base = { body: "본문", category: "MAINTENANCE" as const, createdByAdminId: admin.id, updatedByAdminId: admin.id };
    const live = await db.platformNotice.create({ data: { ...base, title: "점검", audience: "PARTNERS", publishedAt: new Date() } });
    const draft = await db.platformNotice.create({ data: { ...base, title: "임시", audience: "PARTNERS" } });
    const pub = await db.platformNotice.create({ data: { ...base, title: "공개만", audience: "PUBLIC", publishedAt: new Date() } });
    for (const n of [draft.id, pub.id, crypto.randomUUID(), "x"]) expect((await create(a.owner.cookie, { ...NEW, noticeId: n })).body.error).toBe("invalid_notice");
    expect((await create(a.owner.cookie, { ...NEW, noticeId: live.id })).body.inquiry.notice).toEqual({ id: live.id, title: "점검" });
    expect(await db.platformInquiry.count()).toBe(1);
  });

  it("구독이 잠기거나 이용 정지 중에도 문의를 보내고 본다", async () => {
    const a = await shop();
    await db.seller.update({ where: { id: a.seller.id }, data: { trialEndsAt: new Date(Date.now() - 86_400_000), status: "SUSPENDED" } });
    const made = await create(a.owner.cookie);
    expect(made.status).toBe(201);
    expect((await list(a.owner.cookie)).status).toBe(200);
  });

  it(`하루(24시간) 쇼핑몰당 ${DAILY_LIMIT}건. 동시에 보내도 넘지 않는다. 다른 쇼핑몰은 따로 센다`, async () => {
    const a = await shop();
    const b = await shop();
    const rs = await Promise.all(Array.from({ length: DAILY_LIMIT + 5 }, (_, i) => create(i % 2 ? a.owner.cookie : a.staff.cookie)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(DAILY_LIMIT);
    expect(rs.filter((r) => r.status === 429).map((r) => r.body.error)).toEqual(Array(5).fill("too_many_inquiries"));
    expect(await db.platformInquiry.count({ where: { sellerId: a.seller.id } })).toBe(DAILY_LIMIT);
    expect((await create(b.owner.cookie)).status).toBe(201);
    await db.platformInquiry.updateMany({ where: { sellerId: a.seller.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    expect((await create(a.owner.cookie)).status).toBe(201);
  });
});

describe("마스터 답변·종료", () => {
  it("보기는 모든 역할, 답변·종료는 최고관리자·CS만(운영·조회 전용 403). 목록에 쇼핑몰·쓴 사람·상태별 수", async () => {
    const a = await shop();
    const id = (await create(a.staff.cookie)).body.inquiry.id;
    const cs = await adminCookie("CS");
    for (const role of ["OPERATIONS", "READ_ONLY"] as const) {
      const x = await adminCookie(role);
      const l = await json(await adminList(req("/api/admin/platform-inquiries", x.cookie)));
      expect(l.status).toBe(200);
      expect(l.body).toMatchObject({ items: [{ id, sellerId: a.seller.id, shopName: a.seller.shopName, slug: a.seller.slug, authorName: "직원", status: "OPEN", version: 0 }], counts: { OPEN: 1, ANSWERED: 0, CLOSED: 0 }, nextCursor: null });
      expect((await adminGetOne(req(`/api/admin/platform-inquiries/${id}`, x.cookie), iq(id))).status).toBe(200);
      expect((await reply(x.cookie, id, { body: "답", expectedVersion: 0 })).status).toBe(403);
      expect((await close(x.cookie, id, { expectedVersion: 0 })).status).toBe(403);
    }
    expect((await json(await adminList(req("/api/admin/platform-inquiries", "")))).status).toBe(401);
    expect((await reply(cs.cookie, id, { body: "", expectedVersion: 0 })).body.error).toBe("invalid_body");
    expect((await reply(cs.cookie, crypto.randomUUID(), { body: "답", expectedVersion: 0 })).status).toBe(404);
    expect((await json(await adminList(req("/api/admin/platform-inquiries?status=DONE", cs.cookie)))).body.error).toBe("invalid_status");
    expect((await json(await adminList(req("/api/admin/platform-inquiries?cursor=bad", cs.cookie)))).body.error).toBe("invalid_cursor");
    expect(await db.platformInquiryMessage.count({ where: { authorType: "ADMIN" } })).toBe(0);
  });

  it("답변 → 답변 완료·새 답변 표시(열면 사라짐). 파트너스 화면에는 관리자 이름·id가 없다. 추가 문의 → 답변 대기, 옛 version 답변은 409", async () => {
    const a = await shop();
    const cs = await adminCookie("CS");
    const id = (await create(a.staff.cookie)).body.inquiry.id;
    const r1 = await reply(cs.cookie, id, { body: "확인했습니다.\n중복 청구는 취소됩니다.", expectedVersion: 0 });
    expect(r1.status).toBe(200);
    expect(r1.body.inquiry).toMatchObject({ status: "ANSWERED", version: 1, messages: [{ author: "PARTNER" }, { author: "PLATFORM", authorName: cs.name, adminId: cs.id }] });
    expect((await list(a.staff.cookie)).body.items[0]).toMatchObject({ status: "ANSWERED", hasNewReply: true });
    const d = await detail(a.staff.cookie, id);
    expect(d.body.inquiry.messages[1]).toEqual({ id: expect.any(String), author: "PLATFORM", authorName: null, body: "확인했습니다.\n중복 청구는 취소됩니다.", createdAt: expect.any(String), images: [] });
    expect(JSON.stringify(d.body)).not.toContain(cs.id);
    expect(JSON.stringify(d.body)).not.toContain(cs.name);
    expect((await list(a.staff.cookie)).body.items[0].hasNewReply).toBe(false);

    const f = await follow(a.staff.cookie, id, { body: "언제 취소되나요?" });
    expect(f.status).toBe(201);
    expect(f.body.inquiry).toMatchObject({ status: "OPEN" });
    expect(await reply(cs.cookie, id, { body: "늦은 답", expectedVersion: 1 })).toMatchObject({ status: 409, body: { error: "version_conflict", currentVersion: 2 } });
    expect(await close(cs.cookie, id, { expectedVersion: 1 })).toMatchObject({ status: 409, body: { error: "version_conflict", currentVersion: 2 } });
    expect((await reply(cs.cookie, id, { body: "3일 안에 취소됩니다.", expectedVersion: 2 })).body.inquiry).toMatchObject({ status: "ANSWERED", version: 3 });
    const actions = (await db.auditLog.findMany({ where: { targetType: "PlatformInquiry", targetId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((x) => x.action);
    // 첫 답변은 담당 자동 배정 로그가 함께 남는다(두 번째 답변은 이미 담당이 있어 없음)
    expect(actions.filter((a) => a !== "platform_inquiry.assign")).toEqual(["platform_inquiry.create", "platform_inquiry.reply", "platform_inquiry.message", "platform_inquiry.reply"]);
    expect(actions.filter((a) => a === "platform_inquiry.assign")).toHaveLength(1);
  });

  it("종료하면 파트너스 추가 문의·마스터 답변·다시 종료가 409 inquiry_closed. 종료한 관리자가 남는다", async () => {
    const a = await shop();
    const su = await adminCookie("SUPER_ADMIN");
    const id = (await create(a.owner.cookie)).body.inquiry.id;
    const c = await close(su.cookie, id, { expectedVersion: 0 });
    expect(c.body.inquiry).toMatchObject({ status: "CLOSED", closedAt: expect.any(String), closedByAdminName: su.name, version: 1 });
    expect(await follow(a.owner.cookie, id, { body: "하나 더" })).toMatchObject({ status: 409, body: { error: "inquiry_closed" } });
    expect((await reply(su.cookie, id, { body: "답", expectedVersion: 1 })).body.error).toBe("inquiry_closed");
    expect((await close(su.cookie, id, { expectedVersion: 1 })).body.error).toBe("inquiry_closed");
    expect((await detail(a.owner.cookie, id)).body.inquiry).toMatchObject({ status: "CLOSED", messages: [{ author: "PARTNER" }] });
    expect(await db.auditLog.count({ where: { action: "platform_inquiry.close", targetId: id, actorId: su.id } })).toBe(1);
  });

  it("같은 version으로 동시에 두 번 답변하면 하나만 된다", async () => {
    const a = await shop();
    const cs = await adminCookie("CS");
    const id = (await create(a.owner.cookie)).body.inquiry.id;
    const rs = await Promise.all([reply(cs.cookie, id, { body: "답 1", expectedVersion: 0 }), reply(cs.cookie, id, { body: "답 2", expectedVersion: 0 })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.platformInquiryMessage.count({ where: { inquiryId: id, authorType: "ADMIN" } })).toBe(1);
  });
});

describe("첨부 사진", () => {
  it("올린 뒤 보낼 때 붙인다(위치 정보 제거). 파트너스·마스터 모두 본다. 다른 쇼핑몰·다른 직원·붙지 않은 사진은 마스터도 못 본다", async () => {
    const a = await shop();
    const b = await shop();
    const admin = await adminCookie("READ_ONLY");
    const up = await upload(a.staff.cookie, jpeg(400, 300, { exif: true }));
    expect(up).toMatchObject({ status: 201, body: { image: { width: 400, height: 300, url: expect.stringContaining("/api/seller/platform-inquiries/images/") } } });
    const imageId = up.body.image.id;
    expect((await adminImage(req("/x", admin.cookie), im(imageId))).status).toBe(404);
    // 다른 계정은 남이 올린 사진을 붙일 수 없다
    expect((await create(a.owner.cookie, { ...NEW, imageIds: [imageId] })).body.error).toBe("invalid_images");
    expect((await create(a.staff.cookie, { ...NEW, imageIds: [imageId, imageId] })).body.error).toBe("invalid_images");
    expect(await db.platformInquiry.count()).toBe(0);
    const made = await create(a.staff.cookie, { ...NEW, imageIds: [imageId] });
    expect(made.body.inquiry.messages[0].images).toEqual([{ id: imageId, width: 400, height: 300, url: `/api/seller/platform-inquiries/images/${imageId}` }]);
    for (const cookie of [a.staff.cookie, a.owner.cookie]) {
      const r = await sellerImage(req("/x", cookie), im(imageId));
      expect(r.status).toBe(200);
      expect(hasImageMetadata(Buffer.from(await r.arrayBuffer()))).toBe(false);
    }
    expect((await sellerImage(req("/x", b.owner.cookie), im(imageId))).status).toBe(404);
    const other = await login(a.seller.id, "STAFF");
    expect((await sellerImage(req("/x", other.cookie), im(imageId))).status).toBe(404);
    expect((await adminImage(req("/x", admin.cookie), im(imageId))).status).toBe(200);
    // 이미 붙은 사진은 다시 붙일 수 없다
    expect((await follow(a.staff.cookie, made.body.inquiry.id, { body: "x", imageIds: [imageId] })).body.error).toBe("invalid_images");
    expect(await db.platformInquiryMessage.count()).toBe(1);
  });

  it(`사진이 아니면 400, 붙지 않은 사진은 계정당 ${UNATTACHED_KEEP}장까지 남고 글 하나에 5장까지`, async () => {
    const a = await shop();
    expect((await upload(a.owner.cookie, Buffer.from("not an image"))).body.error).toBe("unsupported_image");
    const ids: string[] = [];
    for (let i = 0; i < UNATTACHED_KEEP + 2; i++) ids.push((await upload(a.owner.cookie, jpeg(400 + i, 300))).body.image.id);
    const left = await db.platformInquiryImage.findMany({ where: { sellerId: a.seller.id }, select: { id: true } });
    expect(left.map((x) => x.id).sort()).toEqual(ids.slice(2).sort());
    expect((await create(a.owner.cookie, { ...NEW, imageIds: ids.slice(2, 8) })).body.error).toBe("invalid_images");
    expect((await create(a.owner.cookie, { ...NEW, imageIds: ids.slice(2, 7) })).body.inquiry.messages[0].images.map((x: { id: string }) => x.id)).toEqual(ids.slice(2, 7));
  });
});
