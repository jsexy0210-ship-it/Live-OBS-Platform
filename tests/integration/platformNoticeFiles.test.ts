import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as adminFileDelete, GET as adminFileGet } from "../../app/api/admin/platform-notices/[noticeId]/files/[fileId]/route";
import { POST as adminFileUpload } from "../../app/api/admin/platform-notices/[noticeId]/files/route";
import { GET as adminNoticeGet } from "../../app/api/admin/platform-notices/[noticeId]/route";
import { GET as sellerFileGet } from "../../app/api/seller/platform-notices/[noticeId]/files/[fileId]/route";
import { GET as sellerNoticeGet } from "../../app/api/seller/platform-notices/[noticeId]/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { NOTICE_FILE_MAX_BYTES, NOTICE_FILES_PER_NOTICE } from "../../lib/server/platform-notices/files";
import { jpeg, webp } from "../unit/productImageFormatsFixtures";
import { png } from "../unit/shopContentFixtures";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 공지 첨부(MA-053·054): 작성 권한자만 올리고(.png·.jpg·.pdf, 5MB·공지당 5개), 파트너스는 게시된 공지에서 받기만
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 32), Buffer.from("\n%%EOF")]);
const ctxOf = (noticeId: string, fileId = "") => ({ params: Promise.resolve({ noticeId, fileId }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
async function seller() {
  const { seller } = await createSeller();
  const u = await createSellerUser(seller.id, "OWNER");
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { seller, cookie: `lo_seller=${r.token}` };
}
async function notice(over: Record<string, unknown> = {}) {
  const a = await createAdmin("CS");
  return db.platformNotice.create({
    data: { title: "점검 안내", body: "본문", category: "GENERAL", audience: "PARTNERS", isPinned: false, publishedAt: new Date("2026-10-01T00:00:00Z"), createdByAdminId: a.id, updatedByAdminId: a.id, ...over },
  });
}
const upload = async (cookie: string, noticeId: string, name: string, bytes: Buffer) =>
  json(await adminFileUpload(new Request(`${BASE}/api/admin/platform-notices/${noticeId}/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...H, cookie }, body: new Uint8Array(bytes) }), ctxOf(noticeId)));
const sellerDownload = (cookie: string, noticeId: string, fileId: string) => sellerFileGet(new Request(`${BASE}/api/seller/platform-notices/${noticeId}/files/${fileId}`, { headers: { ...H, cookie } }), ctxOf(noticeId, fileId));
const adminDownload = (cookie: string, noticeId: string, fileId: string) => adminFileGet(new Request(`${BASE}/api/admin/platform-notices/${noticeId}/files/${fileId}`, { headers: { ...H, cookie } }), ctxOf(noticeId, fileId));
const remove = async (cookie: string, noticeId: string, fileId: string) =>
  json(await adminFileDelete(new Request(`${BASE}/api/admin/platform-notices/${noticeId}/files/${fileId}`, { method: "DELETE", headers: { ...H, cookie } }), ctxOf(noticeId, fileId)));

describe("공지 첨부 올리기·지우기(작성 권한자)", () => {
  it("최고관리자·CS만(운영·조회 전용 403), png·jpg·pdf만 201, 그 밖은 415, 5MB 초과 413, 공지당 5개", async () => {
    const cs = await admin("CS");
    const ops = await admin("OPERATIONS");
    const viewer = await admin("READ_ONLY");
    const n = await notice();
    expect((await upload(ops.cookie, n.id, "a.pdf", pdf)).status).toBe(403);
    expect((await upload(viewer.cookie, n.id, "a.pdf", pdf)).status).toBe(403);

    const p = await upload(cs.cookie, n.id, "C:\\공지\\점검 안내.PDF", pdf);
    expect(p).toMatchObject({ status: 201, body: { file: { name: "점검 안내.pdf", byteSize: pdf.length, url: expect.stringContaining(`/api/admin/platform-notices/${n.id}/files/`) } } });
    expect((await upload(cs.cookie, n.id, "pic.png", png(400, 300))).body.file.name).toBe("pic.png");
    expect((await upload(cs.cookie, n.id, "photo.jpeg", jpeg(400, 300))).body.file.name).toBe("photo.jpeg");
    // 확장자가 실제 그림과 다르면 이름을 실제 종류에 맞춘다
    expect((await upload(cs.cookie, n.id, "fake.png", jpeg(400, 300))).body.file.name).toBe("fake.jpg");
    for (const [name, bytes] of [["a.exe", pdf], ["a.html", Buffer.from("<script>")], ["a.svg", Buffer.from("<svg/>")], ["a.zip", Buffer.from([0x50, 0x4b, 3, 4])], ["a.pdf", Buffer.from("not a pdf")], ["a.png", Buffer.from("not an image")], ["a.png", webp(400, 300)], ["a.pdf", Buffer.alloc(0)], ["noext", pdf]] as const) {
      expect(await upload(cs.cookie, n.id, name, bytes)).toMatchObject({ status: 415, body: { error: "unsupported_file" } });
    }
    expect((await upload(cs.cookie, n.id, "big.pdf", Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(NOTICE_FILE_MAX_BYTES)]))).status).toBe(413);
    expect((await upload(cs.cookie, n.id, "fifth.pdf", pdf)).status).toBe(201);
    expect((await upload(cs.cookie, n.id, "sixth.pdf", pdf))).toMatchObject({ status: 400, body: { error: "too_many_files" } });
    expect(await db.platformNoticeFile.count({ where: { noticeId: n.id } })).toBe(NOTICE_FILES_PER_NOTICE);
    // 공지 version은 올리지 않는다
    expect((await db.platformNotice.findUniqueOrThrow({ where: { id: n.id } })).version).toBe(0);
    expect(await db.auditLog.count({ where: { action: "platform.notice.file_upload", targetId: n.id } })).toBe(5);
  });

  it("없거나 지운 공지는 404, 지우기는 작성 권한자만이고 지우면 5개 한도에 다시 자리가 난다. 다른 공지의 파일은 지울 수 없다", async () => {
    const cs = await admin("CS");
    const ops = await admin("OPERATIONS");
    const a = await notice();
    const b = await notice({ title: "다른 공지" });
    expect((await upload(cs.cookie, "11111111-1111-4111-8111-111111111111", "a.pdf", pdf)).status).toBe(404);
    const fa = (await upload(cs.cookie, a.id, "a.pdf", pdf)).body.file.id as string;
    expect((await remove(ops.cookie, a.id, fa)).status).toBe(403);
    expect((await remove(cs.cookie, b.id, fa)).status).toBe(404);
    expect((await remove(cs.cookie, a.id, fa)).status).toBe(200);
    expect((await remove(cs.cookie, a.id, fa)).status).toBe(404);
    expect(await db.auditLog.count({ where: { action: "platform.notice.file_delete", targetId: a.id } })).toBe(1);
    await db.platformNotice.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    expect((await upload(cs.cookie, a.id, "late.pdf", pdf)).status).toBe(404);
  });
});

describe("받기·목록(파트너스는 받기만)", () => {
  it("게시된 공지의 파일만 파트너스가 받고(attachment·nosniff·고정 content-type), 상세에 files가 나온다. 임시 저장·공개 전용·지운 공지는 404", async () => {
    const cs = await admin("CS");
    const s = await seller();
    const pub = await notice();
    const f = (await upload(cs.cookie, pub.id, "안내문.pdf", pdf)).body.file as { id: string };
    const img = (await upload(cs.cookie, pub.id, "배너.png", png(400, 300))).body.file as { id: string };

    const res = await sellerDownload(s.cookie, pub.id, f.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="/);
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true);
    expect((await sellerDownload(s.cookie, pub.id, img.id)).headers.get("content-type")).toBe("image/png");

    const detail = await json(await sellerNoticeGet(new Request(`${BASE}/api/seller/platform-notices/${pub.id}`, { headers: { ...H, cookie: s.cookie } }), ctxOf(pub.id)));
    expect(detail.body.notice.files).toEqual([
      { id: f.id, name: "안내문.pdf", byteSize: pdf.length, url: `/api/seller/platform-notices/${pub.id}/files/${f.id}` },
      { id: img.id, name: "배너.png", byteSize: expect.any(Number), url: `/api/seller/platform-notices/${pub.id}/files/${img.id}` },
    ]);

    // 임시 저장·공개 전용·지운 공지의 파일은 404, 다른 공지 id로도 못 받음
    const draft = await notice({ publishedAt: null });
    const publicOnly = await notice({ audience: "PUBLIC" });
    const gone = await notice();
    const fd = (await upload(cs.cookie, draft.id, "d.pdf", pdf)).body.file.id as string;
    const fp = (await upload(cs.cookie, publicOnly.id, "p.pdf", pdf)).body.file.id as string;
    const fg = (await upload(cs.cookie, gone.id, "g.pdf", pdf)).body.file.id as string;
    await db.platformNotice.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    for (const [nid, fid] of [[draft.id, fd], [publicOnly.id, fp], [gone.id, fg], [pub.id, fd], [pub.id, "not-a-uuid"]] as const) {
      expect((await sellerDownload(s.cookie, nid, fid)).status).toBe(404);
    }
    // 로그인하지 않으면 못 받는다
    await expect(sellerDownload("", pub.id, f.id)).resolves.toMatchObject({ status: 401 });
  });

  it("마스터는 전 역할이 받고(임시 저장 공지도), 상세 files에 관리자 주소가 나오며, 지운 공지의 파일은 404", async () => {
    const cs = await admin("CS");
    const viewer = await admin("READ_ONLY");
    const draft = await notice({ publishedAt: null });
    const f = (await upload(cs.cookie, draft.id, "초안.pdf", pdf)).body.file.id as string;
    const res = await adminDownload(viewer.cookie, draft.id, f);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    const detail = await json(await adminNoticeGet(new Request(`${BASE}/api/admin/platform-notices/${draft.id}`, { headers: { ...H, cookie: viewer.cookie } }), ctxOf(draft.id)));
    expect(detail.body.notice.files).toEqual([{ id: f, name: "초안.pdf", byteSize: pdf.length, url: `/api/admin/platform-notices/${draft.id}/files/${f}` }]);
    await db.platformNotice.update({ where: { id: draft.id }, data: { deletedAt: new Date() } });
    expect((await adminDownload(viewer.cookie, draft.id, f)).status).toBe(404);
  });
});
