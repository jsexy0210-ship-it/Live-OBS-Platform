import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as sellerLogoImageGet } from "../../app/api/seller/shop-content/logo/image/route";
import { DELETE as logoDelete, GET as logoGet, PUT as logoPut } from "../../app/api/seller/shop-content/logo/route";
import { GET as publicLogoGet } from "../../app/api/shop/[slug]/shop-content/logo/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { jpeg, png } from "../unit/shopContentFixtures";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-060 쇼핑몰 로고: 권한(보기는 누구나·바꾸기는 대표자·SHOP_SETTINGS)·테넌트 격리·플랜 권한·로그 추적·공개 이미지·DB CHECK.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const put = (cookie: string, bytes: Buffer, origin = BASE) =>
  logoPut(new Request(BASE + "/api/seller/shop-content/logo", { method: "PUT", headers: { ...H, origin, cookie, "content-type": "image/png" }, body: new Uint8Array(bytes) }));
const del = (cookie: string) => logoDelete(new Request(BASE + "/api/seller/shop-content/logo", { method: "DELETE", headers: { ...H, cookie } }));
const get = (cookie?: string) => new Request(BASE + "/api/seller/shop-content/logo", { headers: { ...H, ...(cookie ? { cookie } : {}) } });
const pub = (slug: string, v = "") => publicLogoGet(new Request(`${BASE}/api/shop/${slug}/shop-content/logo${v}`), { params: Promise.resolve({ slug }) });

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

const logs = (sellerId: string) => db.auditLog.findMany({ where: { sellerId, action: { startsWith: "shop.logo." } }, orderBy: { createdAt: "asc" } });

describe("SA-060 쇼핑몰 로고", () => {
  it("대표자·설정 권한 직원은 올리고 지우고, 권한 없는 직원은 보기만(바꾸기 403, 아무것도 남지 않음)", async () => {
    const s = await shop();
    expect(((await (await logoGet(get(s.owner))).json()) as { logo: unknown }).logo).toBeNull();
    const up = await put(s.staff, png(600, 600));
    expect(up.status).toBe(200);
    const body = (await up.json()) as { logo: { url: string; size: number } };
    expect(body.logo.size).toBe(600);

    const seen = (await (await logoGet(get(s.noPerm))).json()) as { logo: { size: number } };
    expect(seen.logo.size).toBe(600);
    expect((await sellerLogoImageGet(new Request(BASE + body.logo.url, { headers: { ...H, cookie: s.noPerm } }))).status).toBe(200);
    expect((await put(s.noPerm, png(700, 700))).status).toBe(403);
    expect((await del(s.noPerm)).status).toBe(403);
    expect((await db.sellerLogo.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).width).toBe(600);

    expect((await del(s.owner)).status).toBe(200);
    expect(await db.sellerLogo.count()).toBe(0);
    // 없는 로고를 다시 지워도 아무것도 남기지 않는다
    expect((await del(s.owner)).status).toBe(200);
    const l = await logs(s.seller.id);
    expect(l.map((x) => x.action)).toEqual(["shop.logo.update", "shop.logo.delete"]);
    expect(l[0].after).toMatchObject({ width: 600 });
    expect(JSON.stringify(l[0].after)).not.toContain("data");
  });

  it("동시에 두 번 지워도 둘 다 성공하고 로그 추적은 1건, 동시 첫 올리기도 둘 다 성공한다(Codex 4176368659)", async () => {
    const s = await shop();
    expect((await put(s.owner, png(600, 600))).status).toBe(200);
    const dels = await Promise.all([del(s.owner), del(s.staff), del(s.owner)]);
    expect(dels.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await db.sellerLogo.count()).toBe(0);
    expect((await logs(s.seller.id)).filter((x) => x.action === "shop.logo.delete")).toHaveLength(1);
    const puts = await Promise.all([put(s.owner, png(600, 600)), put(s.staff, png(700, 700))]);
    expect(puts.map((r) => r.status)).toEqual([200, 200]);
    expect(await db.sellerLogo.count()).toBe(1);
  });

  it("로그인 없음 401, 다른 출처 403", async () => {
    const s = await shop();
    expect((await logoGet(get())).status).toBe(401);
    expect((await put(s.owner, png(600, 600), "https://evil.example")).status).toBe(403);
    expect(await db.sellerLogo.count()).toBe(0);
  });

  it("검사: PNG만, 정사각형 512~1440, 2MB 초과 413", async () => {
    const s = await shop();
    expect(await (await put(s.owner, jpeg(600, 600))).json()).toEqual({ error: "unsupported_image", message: "PNG 파일만 올릴 수 있습니다" });
    expect(((await (await put(s.owner, png(800, 600))).json()) as { error: string }).error).toBe("not_square");
    expect(((await (await put(s.owner, png(300, 300))).json()) as { error: string }).error).toBe("wrong_image_size");
    expect(await (await put(s.owner, png(1200, 1200, [1, 2, 3], { depth: 16, color: 6 }))).json()).toEqual({
      error: "png_16bit",
      message: "8비트(일반) PNG로 저장해 주십시오. 16비트 PNG는 올릴 수 없습니다",
    });
    expect((await put(s.owner, Buffer.alloc(2 * 1024 * 1024 + 1))).status).toBe(413);
    expect(await db.sellerLogo.count()).toBe(0);
    // DB도 정사각형이 아니거나 PNG가 아닌 로고를 막는다
    const bytes = png(600, 600);
    const row = { sellerId: s.seller.id, data: new Uint8Array(bytes), byteSize: bytes.length, sha256: "0".repeat(64) };
    await expect(db.sellerLogo.create({ data: { ...row, contentType: "image/png", width: 600, height: 500 } })).rejects.toThrow();
    await expect(db.sellerLogo.create({ data: { ...row, contentType: "image/jpeg", width: 600, height: 600 } })).rejects.toThrow();
  });

  it("구매자 화면: 로고가 있으면 PNG(nosniff·버전 주소 immutable), 없으면 404, 다른 쇼핑몰 로고는 섞이지 않음", async () => {
    const a = await shop();
    const b = await shop();
    expect((await pub(a.seller.slug)).status).toBe(404);
    await put(a.owner, png(512, 512, [255, 0, 0]));
    const res = await pub(a.seller.slug);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(png(512, 512, [255, 0, 0]))).toBe(true);
    // 버전 없는 주소(머리에서 씀)는 매번 다시 확인해 바꾸거나 지우면 바로 반영된다
    expect(res.headers.get("cache-control")).toBe("public, no-cache");
    const v = (await db.sellerLogo.findUniqueOrThrow({ where: { sellerId: a.seller.id } })).sha256.slice(0, 12);
    expect((await pub(a.seller.slug, `?v=${v}`)).headers.get("cache-control")).toContain("immutable");
    // B 쇼핑몰은 로고가 없고, B 계정으로는 A 로고를 볼 수도 지울 수도 없다
    expect((await pub(b.seller.slug)).status).toBe(404);
    expect(((await (await logoGet(get(b.owner))).json()) as { logo: unknown }).logo).toBeNull();
    await del(b.owner);
    expect(await db.sellerLogo.count({ where: { sellerId: a.seller.id } })).toBe(1);
  });

  it("오버레이 전용은 관리 API 403 plan_feature_required, 구매자 로고 404", async () => {
    const s = await shop();
    await put(s.owner, png(600, 600));
    const plan = await db.subscriptionPlan.upsert({ where: { code: "OVERLAY_ONLY" }, create: { code: "OVERLAY_ONLY", name: "OVERLAY_ONLY", listPrice: 99_000, salePrice: 69_000 }, update: {} });
    await db.sellerSubscription.create({ data: { sellerId: s.seller.id, planId: plan.id, status: "ACTIVE" } });
    for (const res of [await logoGet(get(s.owner)), await put(s.owner, png(700, 700)), await del(s.owner)]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("plan_feature_required");
    }
    expect((await pub(s.seller.slug)).status).toBe(404);
    expect((await db.sellerLogo.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).width).toBe(600);
  });
});
