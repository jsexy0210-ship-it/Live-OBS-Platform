import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminFile } from "../../app/api/admin/platform-inquiries/files/[fileId]/route";
import { GET as adminGetOne } from "../../app/api/admin/platform-inquiries/[inquiryId]/route";
import { POST as sellerMessage } from "../../app/api/seller/platform-inquiries/[inquiryId]/messages/route";
import { GET as sellerGetOne } from "../../app/api/seller/platform-inquiries/[inquiryId]/route";
import { GET as sellerFile } from "../../app/api/seller/platform-inquiries/files/[fileId]/route";
import { POST as fileUpload } from "../../app/api/seller/platform-inquiries/files/route";
import { POST as imageUpload } from "../../app/api/seller/platform-inquiries/images/route";
import { POST as sellerCreate } from "../../app/api/seller/platform-inquiries/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { FILE_MAX_BYTES } from "../../lib/server/platform-inquiries/files";
import { UNATTACHED_KEEP } from "../../lib/server/platform-inquiries/service";
import { jpeg } from "../unit/productImageFormatsFixtures";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 문의 첨부 파일(사진 외 .txt·.log·.zip): 올리기 검사·한도·붙이기·받기(attachment·nosniff)·권한
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 1)]);
const NEW = { category: "BROADCAST", title: "방송 로그 첨부", body: "OBS 로그를 첨부합니다." };

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
const jsonReq = (path: string, cookie: string, body: unknown) => new Request(BASE + path, { method: "POST", headers: { ...H, cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const getReq = (path: string, cookie: string) => new Request(BASE + path, { headers: { ...H, cookie } });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const up = async (cookie: string, name: string, bytes: Buffer) =>
  json(await fileUpload(new Request(`${BASE}/api/seller/platform-inquiries/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...H, cookie }, body: new Uint8Array(bytes) })));
const upImage = async (cookie: string, bytes: Buffer) => json(await imageUpload(new Request(`${BASE}/api/seller/platform-inquiries/images`, { method: "POST", headers: { ...H, cookie }, body: new Uint8Array(bytes) })));
const create = async (cookie: string, body: unknown) => json(await sellerCreate(jsonReq("/api/seller/platform-inquiries", cookie, body)));
const fid = (fileId: string) => ({ params: Promise.resolve({ fileId }) });
const iid = (inquiryId: string) => ({ params: Promise.resolve({ inquiryId }) });
const download = (cookie: string, id: string) => sellerFile(getReq(`/api/seller/platform-inquiries/files/${id}`, cookie), fid(id));
const adminCookie = async () => `lo_admin=${(await createAdminSession(db, (await createAdmin("CS")).id, {})).token}`;

describe("올리기", () => {
  it("txt·log·zip만 201, 사진·실행 형식·내용 불일치는 415, 5MB 초과는 413, 파일 이름은 정리해 저장한다", async () => {
    const s = await shop();
    const text = Buffer.from("[10:00] 연결 시작");
    const ok = await up(s.owner.cookie, "C:\\obs\\방송 로그.LOG", text);
    expect(ok).toMatchObject({ status: 201, body: { file: { name: "방송 로그.log", byteSize: text.length, url: expect.stringContaining("/api/seller/platform-inquiries/files/") } } });
    expect((await up(s.owner.cookie, "a.zip", zip)).status).toBe(201);
    for (const [name, bytes] of [["a.png", Buffer.from("x")], ["a.exe", Buffer.from("x")], ["a.txt", Buffer.from([0x4d, 0x5a, 0x00])], ["a.zip", Buffer.from("plain")], ["a.txt", Buffer.alloc(0)], ["noext", Buffer.from("x")]] as const) {
      expect(await up(s.owner.cookie, name, bytes)).toMatchObject({ status: 415, body: { error: "unsupported_file" } });
    }
    expect((await up(s.owner.cookie, "big.txt", Buffer.alloc(FILE_MAX_BYTES + 1, 97))).status).toBe(413);
    expect((await up(s.owner.cookie, "max.txt", Buffer.alloc(FILE_MAX_BYTES, 97))).status).toBe(201);
    expect(await db.platformInquiryFile.count({ where: { name: "방송 로그.log" } })).toBe(1);
  });

  it(`붙지 않은 파일은 계정당 ${UNATTACHED_KEEP}개까지만 남고 오래된 것부터 지워진다(다른 계정 것은 건드리지 않음)`, async () => {
    const s = await shop();
    const mine = [];
    for (let i = 0; i < UNATTACHED_KEEP + 2; i++) mine.push((await up(s.owner.cookie, `f${i}.txt`, Buffer.from(`log ${i}`))).body.file.id as string);
    await up(s.staff.cookie, "staff.txt", Buffer.from("staff"));
    expect(await db.platformInquiryFile.count({ where: { sellerUserId: s.owner.id } })).toBe(UNATTACHED_KEEP);
    expect(await db.platformInquiryFile.count({ where: { id: { in: mine.slice(0, 2) } } })).toBe(0);
    expect(await db.platformInquiryFile.count({ where: { sellerUserId: s.staff.id } })).toBe(1);
  });
});

describe("붙이기·받기", () => {
  it("보낼 때 fileIds로 붙고(상세 files), 받기는 attachment·nosniff·고정 content-type이며 마스터도 받는다. 한 번 붙은 파일은 다시 못 붙인다", async () => {
    const s = await shop();
    const admin = await adminCookie();
    const f = (await up(s.staff.cookie, "obs.log", Buffer.from("line1\nline2"))).body.file as { id: string };
    const made = await create(s.staff.cookie, { ...NEW, fileIds: [f.id] });
    expect(made.status).toBe(201);
    const id = made.body.inquiry.id as string;
    expect(made.body.inquiry.messages[0].files).toEqual([{ id: f.id, name: "obs.log", byteSize: 11, url: `/api/seller/platform-inquiries/files/${f.id}` }]);

    const res = await download(s.staff.cookie, f.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="obs\.log"/);
    expect(await res.text()).toBe("line1\nline2");

    // 대표자는 직원의 문의 첨부를 받을 수 있고, 다른 쇼핑몰은 404
    expect((await download(s.owner.cookie, f.id)).status).toBe(200);
    const other = await shop();
    expect((await download(other.owner.cookie, f.id)).status).toBe(404);
    // 마스터 상세에 files(관리자 주소)와 받기
    const detail = await json(await adminGetOne(getReq(`/api/admin/platform-inquiries/${id}`, admin), iid(id)));
    expect(detail.body.inquiry.messages[0].files).toEqual([{ id: f.id, name: "obs.log", byteSize: 11, url: `/api/admin/platform-inquiries/files/${f.id}` }]);
    const adminRes = await adminFile(getReq(`/api/admin/platform-inquiries/files/${f.id}`, admin), fid(f.id));
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers.get("content-disposition")).toMatch(/^attachment;/);
    // 한 번 붙은 파일은 다시 못 붙이고, 없는 파일·남의 파일도 400
    expect((await create(s.staff.cookie, { ...NEW, fileIds: [f.id] })).body.error).toBe("invalid_files");
    const theirs = (await up(other.owner.cookie, "x.txt", Buffer.from("x"))).body.file.id as string;
    expect((await create(s.owner.cookie, { ...NEW, fileIds: [theirs] })).body.error).toBe("invalid_files");
    expect((await create(s.owner.cookie, { ...NEW, fileIds: ["11111111-1111-4111-8111-111111111111"] })).body.error).toBe("invalid_files");
    expect((await create(s.owner.cookie, { ...NEW, fileIds: "x" })).body.error).toBe("invalid_files");
  });

  it("글당 사진과 합쳐 5개·합계 20MB를 넘으면 400 invalid_files, 추가 문의에도 붙는다", async () => {
    const s = await shop();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await up(s.owner.cookie, `f${i}.txt`, Buffer.from(`log ${i}`))).body.file.id as string);
    expect((await create(s.owner.cookie, { ...NEW, fileIds: ids })).body.error).toBe("invalid_files");
    // 파일 4 + 사진 2 = 6개 → 거부, 파일 4 + 사진 1 = 5개 → 통과
    const img = (await upImage(s.owner.cookie, jpeg(400, 300))).body.image.id as string;
    const img2 = (await upImage(s.owner.cookie, jpeg(400, 300))).body.image.id as string;
    expect((await create(s.owner.cookie, { ...NEW, fileIds: ids.slice(0, 4), imageIds: [img, img2] })).body.error).toBe("invalid_files");
    const ok = await create(s.owner.cookie, { ...NEW, fileIds: ids.slice(0, 4), imageIds: [img] });
    expect(ok.status).toBe(201);
    expect(ok.body.inquiry.messages[0]).toMatchObject({ files: expect.any(Array), images: expect.any(Array) });
    expect(ok.body.inquiry.messages[0].files).toHaveLength(4);

    // 합계 20MB: 5MB 파일 4개는 20MB로 통과, 거기에 사진이 더해져 넘으면 거부
    const big = [];
    for (let i = 0; i < 4; i++) big.push((await up(s.owner.cookie, `big${i}.txt`, Buffer.alloc(FILE_MAX_BYTES, 97 + i))).body.file.id as string);
    const imgOver = (await upImage(s.owner.cookie, jpeg(400, 300))).body.image.id as string;
    expect((await create(s.owner.cookie, { ...NEW, fileIds: big, imageIds: [imgOver] })).body.error).toBe("invalid_files");
    expect((await create(s.owner.cookie, { ...NEW, fileIds: big })).status).toBe(201);

    // 추가 문의에도 붙는다
    const base = (await create(s.owner.cookie, NEW)).body.inquiry.id as string;
    const extra = (await up(s.owner.cookie, "later.zip", zip)).body.file.id as string;
    const follow = await json(await sellerMessage(jsonReq(`/api/seller/platform-inquiries/${base}/messages`, s.owner.cookie, { body: "로그 추가", fileIds: [extra] }), iid(base)));
    expect(follow.status).toBe(201);
    const view = await json(await sellerGetOne(getReq(`/api/seller/platform-inquiries/${base}`, s.owner.cookie), iid(base)));
    expect(view.body.inquiry.messages[1].files).toMatchObject([{ id: extra, name: "later.zip" }]);
  });

  it("붙지 않은 파일은 올린 계정만 받고, 마스터는 붙지 않은 파일을 받지 못한다", async () => {
    const s = await shop();
    const admin = await adminCookie();
    const f = (await up(s.staff.cookie, "draft.txt", Buffer.from("임시"))).body.file.id as string;
    expect((await download(s.staff.cookie, f)).status).toBe(200);
    expect((await download(s.owner.cookie, f)).status).toBe(404);
    expect((await adminFile(getReq(`/api/admin/platform-inquiries/files/${f}`, admin), fid(f))).status).toBe(404);
    expect((await download(s.staff.cookie, "not-a-uuid")).status).toBe(404);
  });
});
