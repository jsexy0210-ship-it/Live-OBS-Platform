import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as seoGet, PUT as seoPut } from "../../app/api/seller/seo/route";
import { loginSeller } from "../../lib/server/auth/login";
import { readShopSeoOf } from "../../lib/server/seller-settings/shopSeo";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쇼핑몰 검색 노출(/api/seller/seo, SA-067). 기본값, 부분 변경, 검증, 권한, 판매자 격리, 로그 추적.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000" };
const URL_ = "http://localhost:3000/api/seller/seo";
const DEFAULT = {
  searchTitle: null,
  searchDescription: null,
  indexingEnabled: true,
  sitemapEnabled: true,
  productTitleTemplate: null,
  productDescriptionTemplate: null,
  googleVerification: null,
  naverVerification: null,
};

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, cookie: await cookieOf(owner.email) };
}
const get = async (cookie: string) => {
  const r = await seoGet(new Request(URL_, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
};
const put = async (cookie: string, body: unknown) => {
  const r = await seoPut(new Request(URL_, { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

describe("쇼핑몰 검색 노출", () => {
  it("행이 없으면 기본값(노출·사이트맵 켬)을 준다", async () => {
    const s = await shop();
    expect(await get(s.cookie)).toMatchObject({ status: 200, body: { seo: DEFAULT } });
    expect(await readShopSeoOf(db, s.seller.id)).toEqual(DEFAULT);
  });

  it("보낸 키만 바꾸고 나머지는 유지한다. 빈 값은 지운다. 바뀐 값만 로그 추적에 남는다", async () => {
    const s = await shop();
    const a = await put(s.cookie, { searchTitle: "카드 전문점", indexingEnabled: false, productTitleTemplate: "{상품명} | {쇼핑몰}", googleVerification: "abc_DEF-123" });
    expect(a.status).toBe(200);
    expect(a.body.seo).toEqual({ ...DEFAULT, searchTitle: "카드 전문점", indexingEnabled: false, productTitleTemplate: "{상품명} | {쇼핑몰}", googleVerification: "abc_DEF-123" });
    const b = await put(s.cookie, { searchDescription: "라이브로 파는 카드", searchTitle: "" });
    expect(b.body.seo).toMatchObject({ searchTitle: null, searchDescription: "라이브로 파는 카드", indexingEnabled: false, googleVerification: "abc_DEF-123" });
    expect((await get(s.cookie)).body.seo).toEqual(b.body.seo);
    await put(s.cookie, { indexingEnabled: false }); // 무변경
    const logs = await db.auditLog.findMany({ where: { action: "shop.seo.update", sellerId: s.seller.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ before: DEFAULT });
  });

  it("빈 본문·모르는 키·잘못된 값은 400이고 값이 바뀌지 않는다", async () => {
    const s = await shop();
    const bad: unknown[] = [
      {},
      [],
      null,
      { foo: 1 },
      { indexingEnabled: "false" },
      { sitemapEnabled: 0 },
      { searchTitle: "가".repeat(61) },
      { searchDescription: "가".repeat(161) },
      { searchTitle: 123 },
      { searchTitle: "a​b" },
      { productTitleTemplate: "{가격} 할인" },
      { productTitleTemplate: "{상품명" },
      { productDescriptionTemplate: "}{상품명}" },
      { googleVerification: "a b" },
      { naverVerification: "<script>" },
      { naverVerification: "a".repeat(101) },
      { searchTitle: "정상", indexingEnabled: "x" },
    ];
    for (const body of bad) expect((await put(s.cookie, body)).status, JSON.stringify(body)).toBe(400);
    expect((await get(s.cookie)).body.seo).toEqual(DEFAULT);
    expect(await db.auditLog.count({ where: { action: "shop.seo.update" } })).toBe(0);
  });

  it("다른 쇼핑몰 설정은 서로 영향이 없다", async () => {
    const a = await shop();
    const b = await shop();
    await put(a.cookie, { indexingEnabled: false, searchTitle: "A몰" });
    expect((await get(b.cookie)).body.seo).toEqual(DEFAULT);
    expect(await readShopSeoOf(db, b.seller.id)).toEqual(DEFAULT);
  });

  it("SHOP_SETTINGS 없는 직원은 403, 로그인하지 않으면 401", async () => {
    const s = await shop();
    const c = await cookieOf((await createSellerUser(s.seller.id, "BROADCASTER")).email);
    expect((await get(c)).status).toBe(403);
    expect((await put(c, { indexingEnabled: false })).status).toBe(403);
    expect((await get("")).status).toBe(401);
    const ok = await cookieOf((await createSellerUser(s.seller.id, { permissions: ["SHOP_SETTINGS"] })).email);
    expect((await put(ok, { indexingEnabled: false })).status).toBe(200);
  });
});
