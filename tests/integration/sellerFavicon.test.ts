import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as faviconDelete, GET as faviconGet, PUT as faviconPut } from "../../app/api/seller/favicon/route";
import { GET as publicFavicon } from "../../app/api/shop/[slug]/favicon/[size]/route";
import { GET as shareGet } from "../../app/api/shop/[slug]/share/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { jpeg, png } from "../unit/shopContentFixtures";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쇼핑몰 파비콘(SA-060): 올리기 검사·권한·로그, 크기별 PNG(32·180·512), 로고에서 자동 생성, 공개 경로·캐시·잠긴 쇼핑몰, 공유 메타 연결, DB CHECK.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const put = (cookie: string, bytes: Buffer) => faviconPut(new Request(BASE + "/api/seller/favicon", { method: "PUT", headers: { ...H, cookie, "content-type": "image/png" }, body: new Uint8Array(bytes) }));
const del = (cookie: string) => faviconDelete(new Request(BASE + "/api/seller/favicon", { method: "DELETE", headers: { ...H, cookie } }));
const get = (cookie?: string) => faviconGet(new Request(BASE + "/api/seller/favicon", { headers: { ...H, ...(cookie ? { cookie } : {}) } }));
const pub = (slug: string, size: string, q = "", headers: Record<string, string> = {}) =>
  publicFavicon(new Request(`${BASE}/api/shop/${slug}/favicon/${size}${q}`, { headers }), { params: Promise.resolve({ slug, size }) });
const share = (slug: string) => shareGet(new Request(`${BASE}/api/shop/${slug}/share`), { params: Promise.resolve({ slug }) });

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const staff = await createSellerUser(seller.id, { permissions: ["SHOP_SETTINGS"] });
  const other = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  return { seller, owner: await cookieOf(owner.email), staff: await cookieOf(staff.email), noPerm: await cookieOf(other.email) };
}
const logs = (sellerId: string) => db.auditLog.findMany({ where: { sellerId, action: { startsWith: "shop.favicon." } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const json = async (r: Response) => (await r.json()) as { favicon: { source: string | null; version: string | null; urls: Record<string, string> | null; uploaded: { width: number; byteSize: number } | null }; error?: string };
// 단색 PNG를 만든다(8비트). 로고 시험은 512px 이상 정사각형이어야 한다
const solid = (side: number, rgb: [number, number, number] = [200, 30, 30]) => png(side, side, rgb);

describe("쇼핑몰 파비콘 올리기", () => {
  it("기본은 없음(source null)이고, 올리면 UPLOADED와 크기별 주소·원본 정보를 준다. 로그에는 크기·해시만 남는다", async () => {
    const s = await shop();
    const none = await json(await get(s.owner));
    expect(none.favicon).toMatchObject({ source: null, version: null, urls: null, uploaded: null });
    const bytes = solid(256);
    const r = await put(s.staff, bytes);
    expect(r.status).toBe(200);
    const f = (await json(r)).favicon;
    expect(f).toMatchObject({ source: "UPLOADED", uploaded: { width: 256, byteSize: bytes.length } });
    expect(Object.keys(f.urls!)).toEqual(["32", "180", "512"]);
    expect(f.urls!["32"]).toBe(`/api/shop/${s.seller.slug}/favicon/32?v=${f.version}`);
    const l = await logs(s.seller.id);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ action: "shop.favicon.update", before: null, after: { width: 256, byteSize: bytes.length } });
    expect(JSON.stringify(l[0].after)).not.toContain("data");
    await put(s.owner, solid(300));
    const l2 = await logs(s.seller.id);
    expect(l2).toHaveLength(2);
    expect(l2[1].before).toMatchObject({ width: 256 });
  });

  it("PNG가 아니거나 정사각형이 아니거나 크기 범위 밖·16비트·손상·빈 파일·256KB 초과는 거부하고 저장하지 않는다", async () => {
    const s = await shop();
    const good = solid(128);
    const cases: [string, Buffer, number, string][] = [
      ["jpeg", jpeg(128, 128), 400, "unsupported_image"],
      ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><script>1</script></svg>'), 400, "unsupported_image"],
      ["손상", good.subarray(0, good.length - 12), 400, "unsupported_image"],
      ["빈 파일", Buffer.alloc(0), 400, "empty_file"],
      ["직사각형", png(200, 100), 400, "not_square"],
      ["작음", solid(63), 400, "wrong_image_size"],
      ["큼", solid(1025), 400, "wrong_image_size"],
      ["16비트", png(128, 128, [1, 2, 3], { depth: 16 }), 400, "png_16bit"],
      ["256KB 초과", Buffer.concat([solid(128), Buffer.alloc(260 * 1024)]), 413, "file_too_large"],
    ];
    for (const [name, data, status, error] of cases) {
      const r = await put(s.owner, data);
      expect([name, r.status, ((await r.json()) as { error: string }).error]).toEqual([name, status, error]);
    }
    expect(await db.sellerFavicon.count()).toBe(0);
    expect((await logs(s.seller.id)).length).toBe(0);
    expect((await put(s.owner, solid(64))).status).toBe(200);
    expect((await put(s.owner, solid(1024))).status).toBe(200);
  });

  it("지우면 없음으로 돌아가고, 없는 파비콘을 지워도 성공(로그는 실제로 지웠을 때만)", async () => {
    const s = await shop();
    await put(s.owner, solid(128));
    expect((await json(await del(s.staff))).favicon.source).toBeNull();
    expect((await del(s.owner)).status).toBe(200);
    expect((await logs(s.seller.id)).map((x) => x.action)).toEqual(["shop.favicon.update", "shop.favicon.delete"]);
  });

  it("권한 없는 직원은 보기 403·바꾸기 403, 비로그인 401, 다른 쇼핑몰 파비콘은 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    expect((await put(a.noPerm, solid(128))).status).toBe(403);
    expect((await del(a.noPerm)).status).toBe(403);
    expect((await get(a.noPerm)).status).toBe(403);
    expect((await get()).status).toBe(401);
    await put(a.owner, solid(128));
    expect((await json(await get(b.owner))).favicon.source).toBeNull();
    expect((await pub(b.seller.slug, "32")).status).toBe(404);
    expect(await db.sellerFavicon.count()).toBe(1);
    expect((await logs(b.seller.id)).length).toBe(0);
  });

  it("DB CHECK: 범위 밖 크기는 직접 넣어도 거부된다", async () => {
    const s = await shop();
    const row = { sellerId: s.seller.id, data: new Uint8Array([1]), sha256: "x" };
    await expect(db.sellerFavicon.create({ data: { ...row, byteSize: 1, width: 63 } })).rejects.toThrow();
    await expect(db.sellerFavicon.create({ data: { ...row, byteSize: 262145, width: 128 } })).rejects.toThrow();
  });
});

describe("크기별 PNG와 공개 경로", () => {
  it("올린 파비콘은 32·180·512 정사각형 PNG로 그려지고 여백 없이 가득 찬다", async () => {
    const s = await shop();
    await put(s.owner, solid(300, [0, 85, 255]));
    const v = (await json(await get(s.owner))).favicon.version!;
    for (const side of [32, 180, 512]) {
      const r = await pub(s.seller.slug, String(side), `?v=${v}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      const buf = Buffer.from(await r.arrayBuffer());
      const meta = await sharp(buf).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([side, side, "png"]);
      const raw = await sharp(buf).ensureAlpha().raw().toBuffer();
      const px = (x: number, y: number) => [...raw.subarray((y * side + x) * 4, (y * side + x) * 4 + 4)];
      expect(px(Math.floor(side / 2), Math.floor(side / 2))).toEqual([0, 85, 255, 255]);
      expect(px(1, 1)[3]).toBe(255); // 모서리까지 채움
    }
  });

  it("파비콘이 없으면 로고에서 자동으로 만든다(가운데 맞춤·가장자리 여백은 투명). 올린 파비콘이 로고보다 우선하고, 지우면 로고로 돌아간다", async () => {
    const s = await shop();
    const logo = solid(600, [20, 120, 20]);
    await db.sellerLogo.create({ data: { sellerId: s.seller.id, data: new Uint8Array(logo), contentType: "image/png", byteSize: logo.length, width: 600, height: 600, sha256: createHash("sha256").update(logo).digest("hex") } });
    expect((await json(await get(s.owner))).favicon.source).toBe("LOGO");
    const r = await pub(s.seller.slug, "180");
    expect(r.status).toBe(200);
    const raw = await sharp(Buffer.from(await r.arrayBuffer())).ensureAlpha().raw().toBuffer();
    const px = (x: number, y: number) => [...raw.subarray((y * 180 + x) * 4, (y * 180 + x) * 4 + 4)];
    expect(px(90, 90)).toEqual([20, 120, 20, 255]);
    expect(px(2, 2)[3]).toBe(0); // 여백
    const logoV = (await json(await get(s.owner))).favicon.version;
    await put(s.owner, solid(128, [200, 30, 30]));
    const f = (await json(await get(s.owner))).favicon;
    expect(f.source).toBe("UPLOADED");
    expect(f.version).not.toBe(logoV);
    const up = await sharp(Buffer.from(await (await pub(s.seller.slug, "180")).arrayBuffer())).ensureAlpha().raw().toBuffer();
    expect([...up.subarray(0, 4)]).toEqual([200, 30, 30, 255]);
    await del(s.owner);
    expect((await json(await get(s.owner))).favicon.source).toBe("LOGO");
  });

  it("공개 경로: 모르는 크기·쇼핑몰, 파비콘도 로고도 없는 쇼핑몰, 잠긴 쇼핑몰은 404. 버전이 다르면 짧게 캐시하고 ETag로 304", async () => {
    const s = await shop();
    expect((await pub(s.seller.slug, "32")).status).toBe(404); // 둘 다 없음
    await put(s.owner, solid(128));
    for (const size of ["16", "64", "0", "abc", "32.5", "-32", "032x"]) expect((await pub(s.seller.slug, size)).status, size).toBe(404);
    expect((await pub("no-such-shop", "32")).status).toBe(404);
    const stale = await pub(s.seller.slug, "32", "?v=old");
    expect(stale.headers.get("cache-control")).toBe("public, max-age=300");
    const etag = stale.headers.get("etag")!;
    expect((await pub(s.seller.slug, "32", "?v=old", { "if-none-match": etag })).status).toBe(304);
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
    expect((await pub(s.seller.slug, "32")).status).toBe(404);
  });

  it("공유 메타의 favicon에 크기별 주소가 들어가고, 없으면 null이다", async () => {
    const s = await shop();
    expect(((await (await share(s.seller.slug)).json()) as { favicon: unknown }).favicon).toBeNull();
    await put(s.owner, solid(128));
    const v = (await json(await get(s.owner))).favicon.version;
    const meta = (await (await share(s.seller.slug)).json()) as { favicon: { url: string; appleUrl: string; largeUrl: string; type: string } };
    expect(meta.favicon).toEqual({
      url: `/api/shop/${s.seller.slug}/favicon/32?v=${v}`,
      appleUrl: `/api/shop/${s.seller.slug}/favicon/180?v=${v}`,
      largeUrl: `/api/shop/${s.seller.slug}/favicon/512?v=${v}`,
      type: "image/png",
    });
  });
});
