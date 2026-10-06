import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as profileGet, PUT as profilePut } from "../../app/api/seller/shop-profile/route";
import { loginSeller } from "../../lib/server/auth/login";
import { GET as publicGet } from "../../app/api/shop/[slug]/profile/route";
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
const EXTRA_DEFAULTS = { topNotice: null, homeBenefitBannerVisible: true, usageGuide: null, primaryAddress: "DEFAULT", primaryDomain: null };
const put = (body: unknown, cookie: string) => profilePut(new Request(URL_, { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
const get = (cookie: string) => profileGet(new Request(URL_, { headers: { ...H, cookie } }));

describe("쇼핑몰 정보 저장(SA-060)", () => {
  it("이름·한 줄 소개를 저장하고, 빼면 유지하며, 소개는 빈 값으로 지운다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const c = await cookieOf(owner.email);
    const r = await put({ shopName: "카드숍 별빛", shopTagline: "매일 밤 8시 라이브" }, c);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ profile: { ...EXTRA_DEFAULTS, shopName: "카드숍 별빛", shopTagline: "매일 밤 8시 라이브", operatingState: "OPEN" } });
    expect((await (await put({ shopTagline: "" }, c)).json()).profile).toEqual({ ...EXTRA_DEFAULTS, shopName: "카드숍 별빛", shopTagline: null, operatingState: "OPEN" });
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

  it("운영 상태: 기본 OPEN, 준비 중·일시 정지로 바꾸고 빼면 유지하며, 모르는 값은 400이다", async () => {
    const { seller } = await createSeller();
    const c = await cookieOf((await createSellerUser(seller.id, "OWNER")).email);
    expect((await (await get(c)).json()).profile.operatingState).toBe("OPEN");
    expect((await (await put({ operatingState: "PREPARING" }, c)).json()).profile).toMatchObject({ operatingState: "PREPARING" });
    expect((await (await put({ shopTagline: "소개" }, c)).json()).profile.operatingState).toBe("PREPARING");
    expect((await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).operatingState).toBe("PREPARING");
    for (const bad of ["CLOSED", "open", "", null, 1]) expect((await put({ operatingState: bad }, c)).status, String(bad)).toBe(400);
    expect((await put({ operatingState: "PAUSED" }, c)).status).toBe(200);
    expect(await db.auditLog.count({ where: { action: "shop.profile.update", sellerId: seller.id } })).toBe(3);
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

describe("쇼핑몰 정보 확장(SA-060 공지·이용안내·대표 주소)", () => {
  it("상단 공지·혜택 배너·이용안내를 저장하고 빈 값으로 지우며, 길이·형식 위반은 400이다", async () => {
    const { seller } = await createSeller();
    const c = await cookieOf((await createSellerUser(seller.id, "OWNER")).email);
    const r = await put({ topNotice: "금요일 밤 9시 라이브", homeBenefitBannerVisible: false, usageGuide: "개봉 전에는 취소할 수 있어요.\n개봉하면 환불이 안 돼요." }, c);
    expect(r.status).toBe(200);
    expect((await r.json()).profile).toMatchObject({ topNotice: "금요일 밤 9시 라이브", homeBenefitBannerVisible: false, usageGuide: "개봉 전에는 취소할 수 있어요.\n개봉하면 환불이 안 돼요." });
    expect((await (await put({ topNotice: "", usageGuide: null }, c)).json()).profile).toMatchObject({ topNotice: null, usageGuide: null, homeBenefitBannerVisible: false });
    for (const body of [{ topNotice: "가".repeat(61) }, { usageGuide: "가".repeat(1001) }, { homeBenefitBannerVisible: "false" }, { topNotice: 1 }, { primaryAddress: "OTHER" }]) {
      expect((await put(body, c)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await put({ topNotice: "가".repeat(60), usageGuide: "나".repeat(1000) }, c)).status).toBe(200);
    // 이용안내 글은 로그 추적에 글자 수만
    const log = await db.auditLog.findFirst({ where: { action: "shop.profile.update", sellerId: seller.id }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(log?.after)).toContain("1000자");
  });

  it("대표 주소 CUSTOM은 소유 확인된 내 도메인이 있어야 하고, 확인되지 않은·정지된 도메인은 인정하지 않는다", async () => {
    const { seller } = await createSeller();
    const c = await cookieOf((await createSellerUser(seller.id, "OWNER")).email);
    const bad = await put({ primaryAddress: "CUSTOM" }, c);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("no_verified_domain");
    await db.sellerDomain.create({ data: { sellerId: seller.id, hostname: "pending.example.com" } });
    await db.sellerDomain.create({ data: { sellerId: seller.id, hostname: "old.example.com", verifiedAt: new Date(), suspendedAt: new Date() } });
    expect((await put({ primaryAddress: "CUSTOM" }, c)).status).toBe(400);
    await db.sellerDomain.create({ data: { sellerId: seller.id, hostname: "shop.example.com", verifiedAt: new Date() } });
    const ok = await put({ primaryAddress: "CUSTOM" }, c);
    expect(ok.status).toBe(200);
    expect((await ok.json()).profile).toMatchObject({ primaryAddress: "CUSTOM", primaryDomain: "shop.example.com" });
    expect((await put({ primaryAddress: "DEFAULT" }, c)).status).toBe(200);
  });

  it("구매자 공개 정보: 승인된 쇼핑몰만, 내 도메인은 대표 주소가 CUSTOM일 때만 내려가고, 다른 쇼핑몰 값은 섞이지 않는다", async () => {
    const a = await createSeller();
    const other = await createSeller();
    const c = await cookieOf((await createSellerUser(a.seller.id, "OWNER")).email);
    await db.sellerDomain.create({ data: { sellerId: a.seller.id, hostname: "shop.example.com", verifiedAt: new Date() } });
    await put({ shopTagline: "소개", topNotice: "공지", usageGuide: "안내" }, c);
    const pub = (slug: string) => publicGet(new Request(`http://localhost:3000/api/shop/${slug}/profile`), { params: Promise.resolve({ slug }) });
    const r = await pub(a.seller.slug);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ shopName: expect.any(String), shopTagline: "소개", operatingState: "OPEN", topNotice: "공지", homeBenefitBannerVisible: true, usageGuide: "안내", primaryDomain: null });
    await put({ primaryAddress: "CUSTOM" }, c);
    expect((await (await pub(a.seller.slug)).json()).primaryDomain).toBe("shop.example.com");
    expect((await (await pub(other.seller.slug)).json()).topNotice).toBeNull();
    expect((await pub("no-such-shop")).status).toBe(404);
    await db.seller.update({ where: { id: a.seller.id }, data: { status: "SUSPENDED" } });
    expect((await pub(a.seller.slug)).status).toBe(404);
  });
});

