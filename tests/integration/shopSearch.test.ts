import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as popularRoute } from "../../app/api/shop/[slug]/search/popular/route";
import { GET as suggestRoute } from "../../app/api/shop/[slug]/search/suggest/route";
import { GET as listRoute } from "../../app/api/shop/[slug]/products/route";
import { DELETE as blockedDelete, GET as blockedGet, POST as blockedPost } from "../../app/api/seller/shop-search/blocked-terms/route";
import { GET as synonymsGet, PUT as synonymsPut } from "../../app/api/seller/shop-search/synonyms/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { createProduct, updateProduct } from "../../lib/server/products/manage";
import { COUNT_IP_BUDGET, resetSearchCountLimiter } from "../../lib/server/shop-search/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쇼핑몰 검색: 상품 태그·유사어 묶음 검색, 인기 검색어(자체 집계), 자동완성, 판매자 격리·권한
// 접속 IP는 신뢰 프록시가 있을 때만 X-Forwarded-For에서 읽는다(http/route.ts clientIp)
beforeAll(() => {
  process.env.TRUSTED_PROXY_HOPS = "1";
});
beforeEach(async () => {
  resetSearchCountLimiter();
  await resetDb();
});
afterAll(async () => {
  delete process.env.TRUSTED_PROXY_HOPS;
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

// ip를 주지 않으면 검색마다 다른 접속으로 본다(반복 제한과 상관없는 시험용)
let ipCounter = 0;
const search = async (s: Shop, q: string, ip = `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`) => {
  const res = await listRoute(new Request(`${BASE}/x?q=${encodeURIComponent(q)}`, { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ slug: s.slug }) });
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

describe("인기 검색어 집계 반복 제한(검수 후속)", () => {
  const countOf = async (s: Shop, term: string) => (await db.shopSearchTerm.findFirst({ where: { sellerId: s.seller.id, term } }))?.count ?? 0;

  it("같은 접속이 같은 검색어를 되풀이해도 한 번만 세고, 다른 접속·다른 검색어는 따로 센다", async () => {
    const s = await shop();
    await s.make("부스터 박스");
    await s.make("프로모 카드");
    for (let i = 0; i < 5; i++) await search(s, "부스터", "1.1.1.1");
    expect(await countOf(s, "부스터")).toBe(1);
    await search(s, "부스터", "2.2.2.2");
    expect(await countOf(s, "부스터")).toBe(2);
    await search(s, "프로모", "1.1.1.1");
    expect(await countOf(s, "프로모")).toBe(1);
    // 대소문자·공백만 다른 같은 검색어도 되풀이로 본다
    await s.make("Pokemon Box");
    await search(s, "POKEMON", "3.3.3.3");
    await search(s, " pokemon ", "3.3.3.3");
    expect(await countOf(s, "pokemon")).toBe(1);
  });

  it("한 접속이 한 쇼핑몰에서 센 검색은 1시간에 한도를 넘으면 더 세지 않고, 검색 결과는 그대로 준다", async () => {
    const s = await shop();
    for (let i = 0; i < COUNT_IP_BUDGET + 5; i++) await s.make(`한도상품${String(i).padStart(2, "0")}`);
    for (let i = 0; i < COUNT_IP_BUDGET + 5; i++) {
      const r = await search(s, `한도상품${String(i).padStart(2, "0")}`, "9.9.9.9");
      expect(r.names).toHaveLength(1); // 세지 않아도 검색은 된다
    }
    expect(await db.shopSearchTerm.count({ where: { sellerId: s.seller.id } })).toBe(COUNT_IP_BUDGET);
    // 다른 접속은 영향 없음
    await search(s, "한도상품34", "8.8.8.8");
    expect(await db.shopSearchTerm.count({ where: { sellerId: s.seller.id } })).toBe(COUNT_IP_BUDGET + 1);
  });

  it("접속 IP를 알 수 없으면(신뢰 프록시 없음) 모두 한 접속으로 본다", async () => {
    const s = await shop();
    await s.make("부스터 박스");
    delete process.env.TRUSTED_PROXY_HOPS;
    try {
      for (let i = 0; i < 3; i++) await search(s, "부스터", `7.7.7.${i}`); // 헤더는 무시된다
    } finally {
      process.env.TRUSTED_PROXY_HOPS = "1";
    }
    expect(await countOf(s, "부스터")).toBe(1);
  });

  it("쓸 오래된 행이 없으면 지우는 쓰기를 하지 않고, 있으면 지운다", async () => {
    const s = await shop();
    await s.make("부스터 박스");
    const deletes: string[] = [];
    const spy = new Proxy(db, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (k !== "$executeRaw") return typeof v === "function" ? v.bind(t) : v;
        return (strings: TemplateStringsArray, ...rest: unknown[]) => {
          if (strings.join("?").includes("DELETE FROM")) deletes.push("delete");
          return (v as (...a: unknown[]) => unknown).call(t, strings, ...rest);
        };
      },
    });
    const { recordSearchTerm } = await import("../../lib/server/shop-search/service");
    await recordSearchTerm(spy, s.seller.id, "부스터", "4.4.4.4");
    expect(deletes).toHaveLength(0);
    await db.$executeRaw`INSERT INTO "ShopSearchTerm" ("sellerId","day","term","count") VALUES (${s.seller.id}::uuid, (now() AT TIME ZONE 'Asia/Seoul')::date - 9, 'ancient', 1)`;
    await recordSearchTerm(spy, s.seller.id, "프로모", "4.4.4.4");
    expect(deletes).toHaveLength(1);
    expect(await db.shopSearchTerm.count({ where: { term: "ancient" } })).toBe(0);
  });
});

describe("유사어 동시 저장·외래키(검수 후속)", () => {
  it("같은 쇼핑몰의 동시 PUT 여러 건이 겹쳐도 묶음이 중복되지 않는다", async () => {
    const s = await shop();
    const groups = [{ words: ["포켓몬", "pokemon"] }, { words: ["유희왕", "yugioh"] }];
    const rs = await Promise.all(Array.from({ length: 8 }, () => putSynonyms(s.owner, groups)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await db.shopSearchSynonym.count({ where: { sellerId: s.seller.id } })).toBe(2);
  });

  it("다른 판매자의 동시 PUT은 서로를 막거나 덮지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await Promise.all([putSynonyms(a.owner, [{ words: ["가가", "나나"] }]), putSynonyms(b.owner, [{ words: ["다다", "라라"] }, { words: ["마마", "바바"] }])]);
    expect(await db.shopSearchSynonym.count({ where: { sellerId: a.seller.id } })).toBe(1);
    expect(await db.shopSearchSynonym.count({ where: { sellerId: b.seller.id } })).toBe(2);
  });

  it("유사어·검색어 집계는 없는 판매자 id로 만들 수 없고, 외래키는 ON DELETE CASCADE이다", async () => {
    const s = await shop();
    const ghost = "11111111-1111-4111-8111-111111111111";
    await expect(db.shopSearchSynonym.create({ data: { sellerId: ghost, words: ["a1", "b1"] } })).rejects.toThrow();
    await expect(db.$executeRaw`INSERT INTO "ShopSearchTerm" ("sellerId","day","term","count") VALUES (${ghost}::uuid, now()::date, 'x1', 1)`).rejects.toThrow();
    await db.shopSearchSynonym.create({ data: { sellerId: s.seller.id, words: ["a1", "b1"] } });
    await db.$executeRaw`INSERT INTO "ShopSearchTerm" ("sellerId","day","term","count") VALUES (${s.seller.id}::uuid, now()::date, 'x1', 1)`;
    const fk = await db.$queryRaw<{ confdeltype: string }[]>`SELECT confdeltype FROM pg_constraint WHERE conname IN ('ShopSearchSynonym_sellerId_fkey','ShopSearchTerm_sellerId_fkey')`;
    expect(fk.map((r) => r.confdeltype)).toEqual(["c", "c"]); // ON DELETE CASCADE
  });
});

describe("인기 검색어 제외 단어", () => {
  const hdr = (cookie: string) => ({ ...H, "content-type": "application/json", cookie });
  const addBlocked = async (cookie: string, term: unknown) => {
    const res = await blockedPost(new Request(`${BASE}/x`, { method: "POST", headers: hdr(cookie), body: JSON.stringify({ term }) }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const delBlocked = async (cookie: string, term: string) => {
    const res = await blockedDelete(new Request(`${BASE}/x?term=${encodeURIComponent(term)}`, { method: "DELETE", headers: hdr(cookie) }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const listBlocked = async (cookie: string) => (await (await blockedGet(new Request(`${BASE}/x`, { headers: hdr(cookie) }))).json()) as { terms: { term: string }[]; canEdit: boolean };

  it("제외 단어가 들어 있는 검색어는 인기 검색어에서 빠지고, 지우면 다시 보이며, 검색 자체는 그대로 된다", async () => {
    const s = await shop();
    await s.make("부스터 박스");
    await s.make("스킨 비속어 카드");
    await search(s, "부스터");
    await search(s, "비속어");
    expect((await popular(s.slug)).terms!.sort()).toEqual(["부스터", "비속어"]);
    expect((await addBlocked(s.owner, "비속")).status).toBe(201);
    expect((await popular(s.slug)).terms).toEqual(["부스터"]); // 이미 쌓인 집계도 바로 가려진다
    expect((await search(s, "비속어")).names).toEqual(["스킨 비속어 카드"]); // 검색은 그대로
    expect((await delBlocked(s.owner, "비속")).status).toBe(200);
    expect((await popular(s.slug)).terms!.sort()).toEqual(["부스터", "비속어"]);
  });

  it("제외된 단어는 새로 세지 않고, 자동완성의 인기 검색어 칸에서도 빠지지만 상품 이름 칸은 그대로다", async () => {
    const s = await shop();
    await s.make("포켓몬 카드");
    await addBlocked(s.owner, "포켓몬 카드");
    await search(s, "포켓몬 카드");
    expect(await db.shopSearchTerm.count({ where: { sellerId: s.seller.id } })).toBe(0);
    const r = await suggest(s.slug, "포켓");
    expect(r.list).toEqual([{ text: "포켓몬 카드", kind: "product" }]);
  });

  it("대소문자·공백을 정리해 저장하고, 같은 단어를 다시 넣어도 하나이며, 잘못된 값은 400이다", async () => {
    const s = await shop();
    expect((await addBlocked(s.owner, "  BAD  Word ")).body.term).toBe("bad word");
    expect((await addBlocked(s.owner, "bad word")).status).toBe(201);
    expect((await listBlocked(s.owner)).terms.map((t) => t.term)).toEqual(["bad word"]);
    for (const bad of ["", "a", "가".repeat(21), 123, null, undefined]) {
      const r = await addBlocked(s.owner, bad);
      expect([r.status, r.body.error]).toEqual([400, "invalid_term"]);
    }
    expect((await delBlocked(s.owner, "없는단어")).body.error).toBe("term_not_found");
    expect((await delBlocked(s.owner, "x")).body.error).toBe("invalid_term");
  });

  it("최대 100개까지(동시 추가도 넘지 않음)이고, 권한·판매자 격리가 지켜진다", async () => {
    const s = await shop();
    const other = await shop();
    await db.shopSearchBlockedTerm.createMany({ data: Array.from({ length: 98 }, (_, i) => ({ sellerId: s.seller.id, term: `금지${String(i).padStart(2, "0")}` })) });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => addBlocked(s.owner, `신규단어${i}`)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
    expect(rs.filter((r) => r.status === 400).every((r) => r.body.error === "too_many_terms")).toBe(true);
    expect(await db.shopSearchBlockedTerm.count({ where: { sellerId: s.seller.id } })).toBe(100);
    // 권한: 상품 관리 직원만 쓰고 다른 직원은 조회만
    expect((await addBlocked(other.noPerm, "권한없음")).status).toBe(403);
    expect((await addBlocked(other.productStaff, "직원추가")).status).toBe(201);
    expect((await listBlocked(other.noPerm)).canEdit).toBe(false);
    expect((await delBlocked(other.noPerm, "직원추가")).status).toBe(403);
    // 격리: 다른 쇼핑몰의 제외 단어는 이 쇼핑몰에 영향이 없고 삭제도 못 한다
    await s.make("직원추가 상품");
    await search(s, "직원추가");
    expect((await popular(s.slug)).terms).toEqual(["직원추가"]);
    expect((await delBlocked(s.owner, "직원추가")).body.error).toBe("term_not_found");
    expect((await listBlocked(other.owner)).terms.map((t) => t.term)).toEqual(["직원추가"]);
  });

  it("추가·삭제가 로그 추적에 남는다", async () => {
    const s = await shop();
    await addBlocked(s.owner, "비속어");
    await addBlocked(s.owner, "비속어"); // 이미 있으면 새 기록 없음
    await delBlocked(s.owner, "비속어");
    const logs = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: { startsWith: "shop_search.blocked_term" } }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["shop_search.blocked_term.add", "shop_search.blocked_term.remove"]);
  });
});
