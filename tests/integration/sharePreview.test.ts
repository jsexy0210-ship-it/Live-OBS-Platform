import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as previewGet, PUT as previewPut } from "../../app/api/seller/share-preview/route";
import { GET as ogGet } from "../../app/api/shop/[slug]/og.png/route";
import { GET as shareGet } from "../../app/api/shop/[slug]/share/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { splitsFor } from "../../lib/server/shop/ogCard";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { "content-type": "application/json", host: "localhost:3000", origin: BASE };
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const cookieFor = async (email: string) => {
  const login = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!login.ok) throw new Error(login.reason);
  return `lo_seller=${login.token}`;
};
const put = (body: unknown, cookie: string) => previewPut(new Request(`${BASE}/api/seller/share-preview`, { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
const get = (cookie: string) => previewGet(new Request(`${BASE}/api/seller/share-preview`, { headers: { ...H, cookie } }));
const share = (slug: string, q = "") => shareGet(new Request(`${BASE}/api/shop/${slug}/share${q}`), ctx(slug));

describe("쇼핑몰 공유 미리보기 설정(SA-060)", () => {
  it("대표자와 「쇼핑몰 설정」 권한 직원만 바꾸고, 그 밖 직원은 403이며 값이 바뀌지 않는다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const settings = await createSellerUser(seller.id, { permissions: ["SHOP_SETTINGS"] });
    const manager = await createSellerUser(seller.id, "MANAGER");
    const r = await put({ title: "망고 카드 라이브", description: "매일 밤 9시 라이브 🔥" }, await cookieFor(owner.email));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ preview: { title: "망고 카드 라이브", description: "매일 밤 9시 라이브 🔥" } });
    expect((await put({ title: "설정 직원", description: null }, await cookieFor(settings.email))).status).toBe(200);
    const managerCookie = await cookieFor(manager.email);
    expect((await put({ title: "권한 없음", description: null }, managerCookie)).status).toBe(403);
    expect((await get(managerCookie)).status).toBe(403);
    expect(await (await get(await cookieFor(owner.email))).json()).toEqual({ preview: { title: "설정 직원", description: null } });
    expect(await db.auditLog.count({ where: { action: "shop.share_preview.update", sellerId: seller.id } })).toBe(2);
  });

  it("제목 60자·설명 160자 초과, 보이지 않는 문자, 문자열이 아닌 값은 400이고 저장하지 않는다. 빈 값은 기본값으로 지운다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const cookie = await cookieFor(owner.email);
    expect((await put({ title: "처음 제목", description: "처음 설명" }, cookie)).status).toBe(200);
    for (const body of [
      { title: "가".repeat(61), description: null },
      { title: null, description: "나".repeat(161) },
      { title: "‮제목", description: null },
      { title: "   ", description: null },
      { title: 123, description: null },
      { description: "제목 빠짐" },
    ]) {
      const r = await put(body, cookie);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("invalid_share_preview");
    }
    expect(await db.seller.findUniqueOrThrow({ where: { id: seller.id }, select: { shareTitle: true, shareDescription: true } })).toEqual({ shareTitle: "처음 제목", shareDescription: "처음 설명" });
    expect((await put({ title: "가".repeat(60), description: "" }, cookie)).status).toBe(200);
    expect((await put({ title: "", description: null }, cookie)).status).toBe(200);
    expect(await db.seller.findUniqueOrThrow({ where: { id: seller.id }, select: { shareTitle: true, shareDescription: true } })).toEqual({ shareTitle: null, shareDescription: null });
  });
});

describe("공개 공유 미리보기 값·기본 카드", () => {
  it("기본값은 쇼핑몰 이름이고, 설정하면 그 값, 상품 상세는 판매 중·품절 상품 이름이 우선한다(숨김·임시·다른 쇼핑몰 상품은 무시)", async () => {
    const { seller } = await createSeller();
    const other = (await createSeller()).seller;
    const meta = await (await share(seller.slug)).json();
    expect(meta).toMatchObject({ title: seller.shopName, description: null, favicon: null, image: { width: 1200, height: 630 } });
    expect(meta.image.url).toMatch(new RegExp(`^/api/shop/${seller.slug}/og\\.png\\?v=[0-9a-f]{12}$`));
    await db.seller.update({ where: { id: seller.id }, data: { shareTitle: "라이브 제목", shareDescription: "설명" } });
    expect(await (await share(seller.slug)).json()).toMatchObject({ title: "라이브 제목", description: "설명" });
    const onSale = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
    const hidden = await db.product.create({ data: { sellerId: seller.id, name: "숨긴 상품", price: 5000, status: "HIDDEN" } });
    const foreign = await db.product.create({ data: { sellerId: other.id, name: "남의 상품", price: 5000, status: "ON_SALE" } });
    expect((await (await share(seller.slug, `?productId=${onSale.id}`)).json()).title).toBe("부스터 팩");
    expect((await (await share(seller.slug, `?productId=${hidden.id}`)).json()).title).toBe("라이브 제목");
    expect((await (await share(seller.slug, `?productId=${foreign.id}`)).json()).title).toBe("라이브 제목");
    expect((await (await share(seller.slug, "?productId=not-a-uuid")).json()).title).toBe("라이브 제목");
  });

  it("운영 중이 아니거나 체험이 끝나 잠긴 쇼핑몰, 없는 쇼핑몰은 공유 값·카드 모두 404", async () => {
    const { seller } = await createSeller();
    const og = (slug: string) => ogGet(new Request(`${BASE}/api/shop/${slug}/og.png`), ctx(slug));
    expect((await share("no-such-shop")).status).toBe(404);
    expect((await og("no-such-shop")).status).toBe(404);
    await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
    expect((await share(seller.slug)).status).toBe(404);
    expect((await og(seller.slug)).status).toBe(404);
    await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: new Date("2999-12-31T00:00:00Z"), status: "SUSPENDED" } });
    expect((await share(seller.slug)).status).toBe(404);
  });

  it("기본 카드는 1200×630 PNG이고 한글 쇼핑몰 이름 글자가 그려진다. 이름을 바꾸면 카드 주소(v)가 바뀐다", async () => {
    const { seller } = await createSeller();
    await db.seller.update({ where: { id: seller.id }, data: { shopName: "망고 카드샵" } });
    const { image } = await (await share(seller.slug)).json();
    const res = await ogGet(new Request(`${BASE}${image.url}`), ctx(seller.slug));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const png = Buffer.from(await res.arrayBuffer());
    const { width, height } = await sharp(png).metadata();
    expect([width, height]).toEqual([1200, 630]);
    // 이름 자리(왼쪽 위)에 밝은 글자 픽셀이 있다(서체가 없으면 빈 카드가 된다)
    const { data } = await sharp(png).extract({ left: 96, top: 88, width: 600, height: 140 }).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(data.filter((v) => v > 200).length).toBeGreaterThan(500);
    // 한글 글자는 기본 라틴 밖의 서체 파일에서 온다
    expect(splitsFor("망고 카드샵").length).toBeGreaterThan(1);
    await db.seller.update({ where: { id: seller.id }, data: { shopName: "새 이름" } });
    expect((await (await share(seller.slug)).json()).image.url).not.toBe(image.url);
    // 옛 주소(v가 지금 이름과 다름)는 짧게만 캐시한다
    expect((await ogGet(new Request(`${BASE}${image.url}`), ctx(seller.slug))).headers.get("cache-control")).toBe("public, max-age=300");
  });
});
