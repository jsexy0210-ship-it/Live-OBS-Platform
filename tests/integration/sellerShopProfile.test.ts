import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as profileGet, PUT as profilePut } from "../../app/api/seller/shop-profile/route";
import { loginSeller } from "../../lib/server/auth/login";
import { shopShareMeta } from "../../lib/server/shop/sharePreview";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쇼핑몰 이름·한 줄 소개(/api/seller/shop-profile, SA-060). 부분 변경, 검증, 권한, 판매자 격리, 로그 추적.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const URL_ = "http://localhost:3000/api/seller/shop-profile";
async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
const put = (body: unknown, cookie: string) => profilePut(new Request(URL_, { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
const get = (cookie: string) => profileGet(new Request(URL_, { headers: { ...H, cookie } }));

describe("쇼핑몰 정보 저장(SA-060)", () => {
  it("이름·한 줄 소개를 저장하고, 빼면 유지하며, 소개는 빈 값으로 지운다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const c = await cookieOf(owner.email);
    const r = await put({ shopName: "카드숍 별빛", shopTagline: "매일 밤 8시 라이브" }, c);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ profile: { shopName: "카드숍 별빛", shopTagline: "매일 밤 8시 라이브" } });
    expect((await (await put({ shopTagline: "" }, c)).json()).profile).toEqual({ shopName: "카드숍 별빛", shopTagline: null });
    expect((await (await get(c)).json()).profile.shopName).toBe("카드숍 별빛");
    expect(await db.auditLog.count({ where: { action: "shop.profile.update", sellerId: seller.id } })).toBe(2);
    await put({ shopName: "카드숍 별빛" }, c);
    expect(await db.auditLog.count({ where: { action: "shop.profile.update", sellerId: seller.id } })).toBe(2);
  });

  it("이름 비움·20자 초과, 소개 40자 초과, 모르는 키, 빈 본문, 문자열 아닌 값은 400이고 저장하지 않는다", async () => {
    const { seller } = await createSeller();
    const c = await cookieOf((await createSellerUser(seller.id, "OWNER")).email);
    const before = await db.seller.findUniqueOrThrow({ where: { id: seller.id }, select: { shopName: true, shopTagline: true } });
    for (const body of [{ shopName: "" }, { shopName: null }, { shopName: "가".repeat(21) }, { shopTagline: "가".repeat(41) }, { slug: "x" }, {}, { shopName: 1 }, [], { shopName: "ㅤ" }]) {
      const r = await put(body, c);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await r.json()).error).toBe("invalid_shop_profile");
    }
    expect((await put({ shopName: "가".repeat(20), shopTagline: "나".repeat(40) }, c)).status).toBe(200);
    expect(before.shopName).not.toBe("가".repeat(20));
  });

  it("대표자와 「쇼핑몰 설정」 권한 직원만 바꾸고 그 밖 직원은 403이다", async () => {
    const { seller } = await createSeller();
    const settings = await createSellerUser(seller.id, { permissions: ["SHOP_SETTINGS"] });
    const manager = await createSellerUser(seller.id, "MANAGER");
    expect((await put({ shopName: "설정 직원" }, await cookieOf(settings.email))).status).toBe(200);
    const mc = await cookieOf(manager.email);
    expect((await put({ shopName: "권한 없음" }, mc)).status).toBe(403);
    expect((await get(mc)).status).toBe(403);
    expect((await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).shopName).toBe("설정 직원");
    expect((await put({ shopName: "비로그인" }, "")).status).toBe(401);
  });

  it("다른 쇼핑몰 값은 바뀌지 않고, 공유 설명이 비면 한 줄 소개를 쓴다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const ca = await cookieOf((await createSellerUser(a.seller.id, "OWNER")).email);
    const bBefore = await db.seller.findUniqueOrThrow({ where: { id: b.seller.id } });
    await put({ shopName: "A몰", shopTagline: "A 소개" }, ca);
    const bAfter = await db.seller.findUniqueOrThrow({ where: { id: b.seller.id } });
    expect([bAfter.shopName, bAfter.shopTagline]).toEqual([bBefore.shopName, bBefore.shopTagline]);
    const meta = await shopShareMeta(db, a.seller.slug);
    expect(meta?.description).toBe("A 소개");
  });
});
