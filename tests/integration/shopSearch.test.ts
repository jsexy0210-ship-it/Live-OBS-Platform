import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as popularRoute } from "../../app/api/shop/[slug]/search/popular/route";
import { GET as suggestRoute } from "../../app/api/shop/[slug]/search/suggest/route";
import { GET as listRoute } from "../../app/api/shop/[slug]/products/route";
import { GET as synonymsGet, PUT as synonymsPut } from "../../app/api/seller/shop-search/synonyms/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { createProduct, updateProduct } from "../../lib/server/products/manage";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쇼핑몰 검색: 상품 태그·유사어 묶음 검색, 인기 검색어(자체 집계), 자동완성, 판매자 격리·권한
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const staff = await createSellerUser(seller.id, { permissions: ["ORDER_SHIPPING"] });
  const productStaff = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const cookie = async (email: string) => {
    const r = await loginSeller(db, { email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  };
  const make = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await createProduct(db, ctx, { name, price: 1000, status: "ON_SALE", options: [{ name: "o", stock: 10 }], ...extra });
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  };
  return { seller, slug: seller.slug, ctx, make, owner: await cookie(owner.email), noPerm: await cookie(staff.email), productStaff: await cookie(productStaff.email) };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const search = async (s: Shop, q: string) => {
  const res = await listRoute(new Request(`${BASE}/x?q=${encodeURIComponent(q)}`), { params: Promise.resolve({ slug: s.slug }) });
  return { status: res.status, names: ((await res.json()) as { products?: { name: string }[] }).products?.map((p) => p.name) ?? [] };
};
const popular = async (slug: string) => {
  const res = await popularRoute(new Request(`${BASE}/x`), { params: Promise.resolve({ slug }) });
  return { status: res.status, terms: ((await res.json()) as { terms?: string[] }).terms };
};
const suggest = async (slug: string, q: string) => {
  const res = await suggestRoute(new Request(`${BASE}/x?q=${encodeURIComponent(q)}`), { params: Promise.resolve({ slug }) });
  return { status: res.status, list: ((await res.json()) as { suggestions?: { text: string; kind: string }[] }).suggestions };
};
const putSynonyms = async (cookie: string, groups: unknown) => {
  const res = await synonymsPut(new Request(`${BASE}/x`, { method: "PUT", headers: { ...H, "content-type": "application/json", cookie }, body: JSON.stringify({ groups }) }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("상품 태그 검색", () => {
  it("이름에 없는 태그(부분 일치·대소문자 무시)로도 찾고, 태그를 고치면 검색 결과가 바뀐다", async () => {
    const s = await shop();
    const p = await s.make("부스터 박스", { searchTags: ["Pokemon", "스칼렛바이올렛"] });
    await s.make("다른 상품");
    expect((await search(s, "pokemon")).names).toEqual(["부스터 박스"]);
    expect((await search(s, "스칼렛")).names).toEqual(["부스터 박스"]);
    expect((await search(s, "부스터")).names).toEqual(["부스터 박스"]);
    expect((await search(s, "없는말")).names).toEqual([]);
    const upd = await updateProduct(db, s.ctx, p.id, { searchTags: ["유희왕"] });
    expect(upd.ok && upd.value.searchTags).toEqual(["유희왕"]);
    expect((await search(s, "pokemon")).names).toEqual([]);
    expect((await search(s, "유희")).names).toEqual(["부스터 박스"]);
  });

  it("태그 입력 검사: 10개·20자·중복·잘못된 형식", async () => {
    const s = await shop();
    const bad = async (tags: unknown) => {
      const r = await createProduct(db, s.ctx, { name: "x", price: 1000, searchTags: tags });
      return !r.ok && r.reason === "invalid_product";
    };
    expect(await bad("문자열")).toBe(true);
    expect(await bad(Array.from({ length: 11 }, (_, i) => `태그${i}`))).toBe(true);
    expect(await bad(["가".repeat(21)])).toBe(true);
    expect(await bad([""])).toBe(true);
    expect(await bad([1])).toBe(true);
    const ok = await createProduct(db, s.ctx, { name: "x", price: 1000, searchTags: ["A", "a", "b"] });
    expect(ok.ok && ok.value.searchTags).toEqual(["A", "b"]); // 대소문자 무시 중복 제거
  });

  it("검색어의 % _ 는 글자 그대로 찾고, 다른 판매자의 태그는 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await a.make("할인 상품", { searchTags: ["100%"] });
    await a.make("일반 상품", { searchTags: ["abc"] });
    await b.make("남의 상품", { searchTags: ["100%", "공유태그"] });
    expect((await search(a, "100%")).names).toEqual(["할인 상품"]);
    expect((await search(a, "%")).names).toEqual(["할인 상품"]);
    expect((await search(a, "_")).names).toEqual([]);
    expect((await search(a, "공유태그")).names).toEqual([]);
  });
});

describe("유사어 묶음", () => {
  it("묶음 안 단어 중 하나로 검색해도 같은 상품을 찾고, 묶음에 없는 말은 넓히지 않는다", async () => {
    const s = await shop();
    await s.make("포켓몬 카드 박스");
    await s.make("Pokemon Sleeve", { searchTags: ["슬리브"] });
    await s.make("유희왕 팩");
    expect((await search(s, "pokemon")).names).toEqual(["Pokemon Sleeve"]);
    expect((await putSynonyms(s.owner, [{ words: ["포켓몬", "pokemon", "피카츄"] }])).status).toBe(200);
    expect((await search(s, "POKEMON")).names.sort()).toEqual(["Pokemon Sleeve", "포켓몬 카드 박스"]);
    expect((await search(s, "피카츄")).names.sort()).toEqual(["Pokemon Sleeve", "포켓몬 카드 박스"]);
    expect((await search(s, "유희")).names).toEqual(["유희왕 팩"]);
  });

  it("다른 쇼핑몰의 유사어는 적용되지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await a.make("포켓몬 박스");
    await putSynonyms(b.owner, [{ words: ["포켓몬", "피카츄"] }]);
    expect((await search(a, "피카츄")).names).toEqual([]);
  });

  it("권한·검사: 상품 관리 직원만 바꾸고 다른 직원은 조회만, 잘못된 묶음은 400이며 아무것도 바꾸지 않는다", async () => {
    const s = await shop();
    expect((await putSynonyms(s.noPerm, [{ words: ["a1", "b1"] }])).status).toBe(403);
    expect((await putSynonyms(s.productStaff, [{ words: ["a1", "b1"] }])).status).toBe(200);
    const got = await synonymsGet(new Request(`${BASE}/x`, { headers: { ...H, cookie: s.noPerm } }));
    expect(await got.json()).toEqual({ groups: [{ words: ["a1", "b1"] }], canEdit: false });
    for (const bad of [[{ words: ["하나만"] }], [{ words: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] }], [{ words: ["가".repeat(21), "b"] }], [{ words: ["x1", "y1"] }, { words: ["X1", "z1"] }], "문자열", Array.from({ length: 51 }, (_, i) => ({ words: [`a${i}`, `b${i}`] }))]) {
      const r = await putSynonyms(s.owner, bad);
      expect([r.status, ["invalid_synonyms", "duplicate_word"].includes(r.body.error)]).toEqual([400, true]);
    }
    expect((await synonymsGet(new Request(`${BASE}/x`, { headers: { ...H, cookie: s.noPerm } })).then((r) => r.json()) as any).groups).toEqual([{ words: ["a1", "b1"] }]);
    expect((await putSynonyms(s.owner, [])).status).toBe(200);
  });
});

describe("인기 검색어", () => {
  it("결과가 나온 검색어만 세고, 많이 검색한 순으로 주며, 결과 없는 말·너무 짧은 말·홈 진열은 세지 않는다", async () => {
    const s = await shop();
    await s.make("부스터 박스");
    await s.make("프로모 카드");
    for (let i = 0; i < 3; i++) await search(s, "부스터");
    await search(s, "프로모");
    await search(s, "없는상품이름");
    await search(s, "부"); // 1글자는 세지 않는다
    await search(s, "  프로모  ".trim());
    expect((await popular(s.slug)).terms).toEqual(["부스터", "프로모"]);
  });

  it("대소문자·공백을 합쳐 한 단어로 세고, 다른 쇼핑몰·7일이 지난 집계는 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await a.make("Pokemon Box");
    await b.make("Pokemon Box");
    await search(a, "POKEMON");
    await search(a, "pokemon");
    await search(b, "pokemon");
    await db.$executeRaw`INSERT INTO "ShopSearchTerm" ("sellerId","day","term","count") VALUES (${a.seller.id}::uuid, (now() AT TIME ZONE 'Asia/Seoul')::date - 7, 'oldterm', 99)`;
    expect((await popular(a.slug)).terms).toEqual(["pokemon"]);
    expect((await db.shopSearchTerm.findFirstOrThrow({ where: { sellerId: a.seller.id, term: "pokemon" } })).count).toBe(2);
    expect((await popular(b.slug)).terms).toEqual(["pokemon"]);
  });

  it("8일이 지난 행은 다음 집계 때 지워지고, 운영 중이 아닌 쇼핑몰은 404이다", async () => {
    const s = await shop();
    await s.make("부스터 박스");
    await db.$executeRaw`INSERT INTO "ShopSearchTerm" ("sellerId","day","term","count") VALUES (${s.seller.id}::uuid, (now() AT TIME ZONE 'Asia/Seoul')::date - 9, 'ancient', 1)`;
    await search(s, "부스터");
    expect(await db.shopSearchTerm.count({ where: { term: "ancient" } })).toBe(0);
    expect((await popular("no-such-shop")).status).toBe(404);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await popular(s.slug)).status).toBe(404);
  });
});

describe("자동완성", () => {
  it("인기 검색어 → 상품 이름 → 태그 순서로, 같은 글자는 한 번만, 앞부분 일치 상품이 먼저다", async () => {
    const s = await shop();
    await s.make("신규 포켓몬 박스");
    await s.make("포켓몬 카드", { searchTags: ["포켓몬스터", "포켓몬 슬리브"] });
    await s.make("숨김 포켓몬", { status: "HIDDEN" });
    await search(s, "포켓몬 카드");
    const r = await suggest(s.slug, "포켓");
    // 인기 검색어 「포켓몬 카드」가 먼저, 같은 글자의 상품 이름은 한 번만(중복 제거), 앞부분이 맞지 않는 상품 이름이 그다음, 태그가 마지막
    expect(r.list!.slice(0, 2)).toEqual([
      { text: "포켓몬 카드", kind: "term" },
      { text: "신규 포켓몬 박스", kind: "product" },
    ]);
    expect(r.list!.slice(2).sort((a, b) => a.text.localeCompare(b.text))).toEqual([
      { text: "포켓몬 슬리브", kind: "tag" },
      { text: "포켓몬스터", kind: "tag" },
    ]);
    expect(r.list).toHaveLength(4);
    expect(r.list!.some((x) => x.text.includes("숨김"))).toBe(false);
  });

  it("유사어로도 찾고, 빈 q·20자 초과는 빈 목록, 최대 8개, 없는·꺼진 쇼핑몰은 404이다", async () => {
    const s = await shop();
    for (let i = 0; i < 10; i++) await s.make(`피카츄 상품 ${i}`);
    await s.make("포켓몬 상품");
    await putSynonyms(s.owner, [{ words: ["포켓몬", "pokemon"] }]);
    expect((await suggest(s.slug, "pokemon")).list).toEqual([{ text: "포켓몬 상품", kind: "product" }]);
    expect((await suggest(s.slug, "피카츄")).list).toHaveLength(8);
    expect((await suggest(s.slug, "")).list).toEqual([]);
    expect((await suggest(s.slug, "가".repeat(21))).list).toEqual([]);
    expect((await suggest("no-such-shop", "a")).status).toBe(404);
  });

  it("다른 판매자의 상품·태그·검색어는 나오지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await b.make("포켓몬 박스", { searchTags: ["포켓몬태그"] });
    await search(b, "포켓몬");
    expect((await suggest(a.slug, "포켓몬")).list).toEqual([]);
  });
});
