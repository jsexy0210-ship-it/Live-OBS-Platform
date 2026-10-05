import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as colorGet, PUT as colorPut } from "../../app/api/seller/brand-color/route";
import { loginSeller } from "../../lib/server/auth/login";
import { contrastOnWhite, readBrandColorOf } from "../../lib/server/seller-settings/brandColor";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쇼핑몰 대표 색상(/api/seller/brand-color, SA-060). 형식·대비 검사, 지우기, 무변경, 로그 추적, 권한, 판매자 격리.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000" };
const URL_ = "http://localhost:3000/api/seller/brand-color";

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
  const r = await colorGet(new Request(URL_, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
};
const put = async (cookie: string, body: unknown) => {
  const r = await colorPut(new Request(URL_, { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const logs = (sellerId: string) => db.auditLog.findMany({ where: { action: "shop.brand_color.update", sellerId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("대표 색상", () => {
  it("흰 바탕 대비 계산이 기준값과 맞는다", () => {
    expect(contrastOnWhite("#FFFFFF")).toBe(1);
    expect(contrastOnWhite("#000000")).toBe(21);
    expect(contrastOnWhite("#767676")).toBeCloseTo(4.54, 1);
    expect(contrastOnWhite("#999999")).toBeLessThan(3);
    expect(contrastOnWhite("#888888")).toBeGreaterThanOrEqual(3);
  });

  it("기본은 null이고, 저장하면 대문자로 남고 대비 값을 함께 준다. 지우면 다시 null", async () => {
    const s = await shop();
    expect((await get(s.cookie)).body.brandColor).toEqual({ color: null, contrastOnWhite: null });
    const r = await put(s.cookie, { color: " #0055ff " });
    expect(r.status).toBe(200);
    expect(r.body.brandColor.color).toBe("#0055FF");
    expect(r.body.brandColor.contrastOnWhite).toBeGreaterThan(3);
    expect((await get(s.cookie)).body.brandColor.color).toBe("#0055FF");
    expect(await readBrandColorOf(db, s.seller.id)).toBe("#0055FF");
    expect((await put(s.cookie, { color: null })).body.brandColor).toEqual({ color: null, contrastOnWhite: null });
    expect(await db.sellerBrandColor.count()).toBe(0);
    expect((await put(s.cookie, { color: "" })).status).toBe(200);
    const l = await logs(s.seller.id);
    expect(l.map((x) => [x.before, x.after])).toEqual([
      [{ color: null }, { color: "#0055FF" }],
      [{ color: "#0055FF" }, { color: null }],
    ]);
  });

  it("같은 값을 다시 보내면 바뀌지 않고 로그도 없다", async () => {
    const s = await shop();
    await put(s.cookie, { color: "#0055FF" });
    await put(s.cookie, { color: "#0055ff" });
    expect(await logs(s.seller.id)).toHaveLength(1);
  });

  it("형식이 틀리거나 너무 옅은 색, 모르는 키는 400이고 저장된 값이 바뀌지 않는다", async () => {
    const s = await shop();
    await put(s.cookie, { color: "#0055FF" });
    const format: unknown[] = [{}, [], null, { color: 123 }, { color: "0055FF" }, { color: "#05F" }, { color: "#0055FFAA" }, { color: "#GG0000" }, { color: "red" }, { color: "#0055FF", extra: 1 }, { colour: "#0055FF" }];
    for (const body of format) {
      const r = await put(s.cookie, body);
      expect([JSON.stringify(body), r.status, r.body.error]).toEqual([JSON.stringify(body), 400, "invalid_brand_color"]);
    }
    for (const color of ["#FFFFFF", "#FFFF00", "#CCCCCC", "#999999"]) {
      const r = await put(s.cookie, { color });
      expect([color, r.status, r.body.error]).toEqual([color, 400, "brand_color_too_light"]);
    }
    expect((await put(s.cookie, { color: "#888888" })).status).toBe(200);
    await put(s.cookie, { color: "#0055FF" });
    expect(await readBrandColorOf(db, s.seller.id)).toBe("#0055FF");
  });

  it("쇼핑몰 설정 권한이 없는 직원은 403, 비로그인 401, 다른 쇼핑몰 값과 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await put(a.cookie, { color: "#CC0000" });
    expect((await get(b.cookie)).body.brandColor.color).toBeNull();
    const bro = await cookieOf((await createSellerUser(a.seller.id, "BROADCASTER")).email);
    expect((await get(bro)).status).toBe(403);
    expect((await put(bro, { color: "#000000" })).status).toBe(403);
    expect((await get("")).status).toBe(401);
    const ok = await cookieOf((await createSellerUser(a.seller.id, { permissions: ["SHOP_SETTINGS"] })).email);
    expect((await put(ok, { color: "#000000" })).status).toBe(200);
    expect((await get(a.cookie)).body.brandColor.color).toBe("#000000");
  });

  it("DB 제약: 형식에 맞지 않는 값은 직접 넣어도 거부된다", async () => {
    const s = await shop();
    await expect(db.sellerBrandColor.create({ data: { sellerId: s.seller.id, color: "#0055ff" } })).rejects.toThrow();
  });
});
