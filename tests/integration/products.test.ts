import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as optionCreateRoute } from "../../app/api/seller/products/[productId]/options/route";
import { DELETE as optionDeleteRoute, PATCH as optionPatchRoute } from "../../app/api/seller/products/[productId]/options/[optionId]/route";
import { GET as productGetRoute, PATCH as productPatchRoute } from "../../app/api/seller/products/[productId]/route";
import { GET as listRoute, POST as createRoute } from "../../app/api/seller/products/route";
import { loginAdmin, loginSeller } from "../../lib/server/auth/login";
import { impersonateSeller, requireAdmin } from "../../lib/server/authz/guards";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES, ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { INT4_MAX } from "../../lib/server/orders/shipping";
import {
  createOption,
  createProduct,
  deleteOption,
  deleteProduct,
  getProduct,
  listProducts,
  updateOption,
  updateProduct,
} from "../../lib/server/products/manage";
import { markOrderPaid } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, adminCredentials, createAdmin, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const shippingAddress = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };

async function seller() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, owner, ctx };
}

async function made(ctx: TenantContext, body: Record<string, unknown> = {}) {
  const r = await createProduct(db, ctx, { name: "부스터 팩", price: 5000, status: "ON_SALE", options: [{ name: "1박스", priceDelta: 1000, stock: 10 }], ...body });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

async function cookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

describe("상품 등록·가격 검증", () => {
  it("옵션과 함께 등록하면 재고 이력(MANUAL)·감사 로그를 남기고, 기본 상태는 DRAFT", async () => {
    const s = await seller();
    const p = await made(s.ctx);
    expect(p).toMatchObject({ name: "부스터 팩", price: 5000, status: "ON_SALE", options: [{ name: "1박스", priceDelta: 1000, stock: 10, sku: null }] });
    expect(await db.stockMovement.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { optionId: p.options[0].id } })).toMatchObject({ delta: 10, reason: "MANUAL" });
    expect(await db.auditLog.count({ where: { action: "product.create", targetId: p.id } })).toBe(1);
    expect(await createProduct(db, s.ctx, { name: "초안", price: 1000 })).toMatchObject({ ok: true, value: { status: "DRAFT", options: [] } });
  });

  it("가격은 1원~정수 범위, 옵션 추가금을 더한 단가도 1원 이상·정수 범위 안이어야 한다", async () => {
    const s = await seller();
    for (const price of [0, -1, 1.5, INT4_MAX + 1, "1000", null]) {
      expect(await createProduct(db, s.ctx, { name: "x", price }), String(price)).toEqual({ ok: false, reason: "invalid_price" });
    }
    // 가격 1000원: 추가금 -1000(단가 0원)·-5000(음수)은 거부, -999(1원)는 허용
    for (const priceDelta of [-1000, -5000]) {
      expect(await createProduct(db, s.ctx, { name: "x", price: 1000, options: [{ name: "o", priceDelta }] })).toEqual({ ok: false, reason: "invalid_price" });
    }
    expect(await createProduct(db, s.ctx, { name: "x", price: 1000, options: [{ name: "o", priceDelta: -999 }] })).toMatchObject({ ok: true });
    expect(await createProduct(db, s.ctx, { name: "x", price: INT4_MAX, options: [{ name: "o", priceDelta: 1 }] })).toEqual({ ok: false, reason: "invalid_price" });
    expect(await createProduct(db, s.ctx, { name: "x", price: INT4_MAX, options: [{ name: "o", priceDelta: 0 }] })).toMatchObject({ ok: true });
  });

  it("재고는 0 이상 정수, 상태는 네 가지만, 판매 중은 옵션이 있어야 하고, 옵션은 100개까지, 보이지 않는 문자는 거부", async () => {
    const s = await seller();
    for (const stock of [-1, 1.5, "3"]) {
      expect(await createProduct(db, s.ctx, { name: "x", price: 1000, options: [{ name: "o", stock }] })).toEqual({ ok: false, reason: "invalid_option" });
    }
    expect(await createProduct(db, s.ctx, { name: "x", price: 1000, status: "DELETED" })).toEqual({ ok: false, reason: "invalid_product" });
    expect(await createProduct(db, s.ctx, { name: "x", price: 1000, status: "ON_SALE" })).toEqual({ ok: false, reason: "no_sellable_option" });
    const many = Array.from({ length: 101 }, (_, i) => ({ name: `o${i}` }));
    expect(await createProduct(db, s.ctx, { name: "x", price: 1000, options: many })).toEqual({ ok: false, reason: "too_many_options" });
    expect(await createProduct(db, s.ctx, { name: "부스터\u202e팩", price: 1000 })).toEqual({ ok: false, reason: "invalid_product" });
    expect(await createProduct(db, s.ctx, { name: "x", price: 1000, options: [{ name: "o\u0000" }] })).toEqual({ ok: false, reason: "invalid_option" });
    expect(await createProduct(db, s.ctx, { name: "x", price: 1000, description: "첫 줄\n둘째 줄" })).toMatchObject({ ok: true, value: { description: "첫 줄\n둘째 줄" } });
    expect(await createProduct(db, s.ctx, { name: "x", price: 1000, description: "숨김\u2028" })).toEqual({ ok: false, reason: "invalid_product" });
    expect(await db.product.count()).toBe(1);
  });

  it("상품 가격·옵션 추가금을 바꿀 때 살아 있는 옵션 단가가 1원 미만이 되면 거부", async () => {
    const s = await seller();
    const p = await made(s.ctx, { price: 1000, options: [{ name: "할인", priceDelta: -500, stock: 1 }] });
    expect(await updateProduct(db, s.ctx, p.id, { price: 500 })).toEqual({ ok: false, reason: "invalid_price" });
    expect(await updateProduct(db, s.ctx, p.id, { price: 501 })).toMatchObject({ ok: true, value: { price: 501 } });
    expect(await updateOption(db, s.ctx, p.id, p.options[0].id, { priceDelta: -501 })).toEqual({ ok: false, reason: "invalid_price" });
    expect(await createOption(db, s.ctx, p.id, { name: "더 할인", priceDelta: -600 })).toEqual({ ok: false, reason: "invalid_price" });
    // 지운 옵션은 가격 검사에서 빠진다
    await createOption(db, s.ctx, p.id, { name: "기본" });
    expect(await deleteOption(db, s.ctx, p.id, p.options[0].id)).toMatchObject({ ok: true });
    expect(await updateProduct(db, s.ctx, p.id, { price: 1 })).toMatchObject({ ok: true });
  });
});

describe("이름에 숨은 글자·깨진 글자", () => {
  it("짝 없는 서로게이트(500 아님)·사용자 정의·미할당 문자, 빈칸처럼 보이는 글자, 보이는 글자가 없는 이름·SKU는 400", async () => {
    const s = await seller();
    const bad = ["a\ud800", "a\udc00b", "a\ue000", "a\u{f0000}", "a\u0378", "\u3164", "\u115f\u1160", "\uffa0", "\u2800", "부스터\u2800팩", "\u0301", "\u0301\u0302"];
    for (const name of bad) {
      expect(await createProduct(db, s.ctx, { name, price: 1000 }), JSON.stringify(name)).toEqual({ ok: false, reason: "invalid_product" });
      expect(await createProduct(db, s.ctx, { name: "x", price: 1000, options: [{ name: "o", sku: name }] }), JSON.stringify(name)).toEqual({ ok: false, reason: "invalid_option" });
    }
    expect(await createProduct(db, s.ctx, { name: "x", price: 1000, description: "설명\ud800" })).toEqual({ ok: false, reason: "invalid_product" });
    expect(await db.product.count()).toBe(0);
    // 기호·문장부호·숫자만 있는 이름, 결합 문자가 붙은 글자는 받는다
    for (const name of ["★", "#1", "2024", "e\u0301"]) {
      expect(await createProduct(db, s.ctx, { name, price: 1000 }), name).toMatchObject({ ok: true });
    }
  });

  it("HTTP: 짝 없는 서로게이트 이름은 400과 문구", async () => {
    const s = await seller();
    const res = await createRoute(
      new Request("http://localhost:3000/api/seller/products", {
        method: "POST",
        headers: { ...H, cookie: await cookie(s.owner.email) },
        body: '{"name":"a\\ud800","price":1000}',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_product", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_product });
    const price = await createRoute(
      new Request("http://localhost:3000/api/seller/products", { method: "POST", headers: { ...H, cookie: await cookie(s.owner.email) }, body: JSON.stringify({ name: "x", price: 0 }) }),
    );
    expect(await price.json()).toEqual({ error: "invalid_price", message: "가격은 1원 이상, 21억 원 이하로 입력해 주십시오. 옵션 추가금을 더한 가격도 같습니다" });
  });
});

describe("목록 페이지 넘김", () => {
  it("커서로 끝까지 넘기면 빠짐·겹침 없이 모두 나오고, 다른 판매자·잘못된 커서·한도 밖 limit은 거부", async () => {
    const s = await seller();
    const other = await seller();
    for (let i = 0; i < 7; i++) await made(s.ctx, { name: `상품${i}`, sortOrder: i % 3 });
    const otherP = await made(other.ctx);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo++) {
      const r = await listProducts(db, s.ctx, { cursor, limit: 3 });
      if (!r.ok) throw new Error(r.reason);
      seen.push(...r.value.products.map((p) => p.id));
      if (!r.value.nextCursor) break;
      cursor = r.value.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const all = await listProducts(db, s.ctx, { limit: 200 });
    expect(all.ok && all.value.products.map((p) => p.id)).toEqual(seen);
    expect(all.ok && all.value.nextCursor).toBeNull();
    for (const bad of [{ cursor: otherP.id }, { cursor: "x" }, { cursor: "00000000-0000-0000-0000-000000000000" }]) {
      expect(await listProducts(db, s.ctx, bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "invalid_cursor" });
    }
    for (const limit of [0, 201, 1.5, "abc", "1e2", "0x10", " 5 ", "", "-1"]) {
      expect(await listProducts(db, s.ctx, { limit }), JSON.stringify(limit)).toEqual({ ok: false, reason: "invalid_limit" });
    }
    expect(await listProducts(db, s.ctx, { limit: "5" })).toMatchObject({ ok: true });
    const res = await listRoute(new Request(`http://localhost:3000/api/seller/products?limit=2`, { headers: { ...H, cookie: await cookie(s.owner.email) } }));
    const body = await res.json();
    expect(body.products).toHaveLength(2);
    expect(body.nextCursor).toBe(body.products[1].id);
    const bad = await listRoute(new Request(`http://localhost:3000/api/seller/products?cursor=${otherP.id}`, { headers: { ...H, cookie: await cookie(s.owner.email) } }));
    expect(bad.status).toBe(400);
  });
});

describe("목록 이름 검색(q)", () => {
  const names = (r: Awaited<ReturnType<typeof listProducts>>) => (r.ok ? r.value.products.map((p) => p.name).sort() : r.reason);

  it("상품·옵션 이름에서 대소문자 무시·부분 일치로 찾고, 다른 쇼핑몰·지운 옵션은 섞이지 않는다", async () => {
    const s = await seller();
    const other = await seller();
    await made(s.ctx, { name: "Pokemon 부스터", options: [{ name: "1박스", stock: 3 }] });
    await made(s.ctx, { name: "원피스 카드", options: [{ name: "POKEMON 콜라보", stock: 0 }] });
    const gone = await made(s.ctx, { name: "디지몬", options: [{ name: "pokemon 한정", stock: 1 }, { name: "1팩", stock: 1 }] });
    expect(await deleteOption(db, s.ctx, gone.id, gone.options.find((o) => o.name === "pokemon 한정")!.id)).toMatchObject({ ok: true });
    await made(s.ctx, { name: "유희왕", options: [{ name: "1팩", stock: 1 }] });
    await made(other.ctx, { name: "pokemon 다른 쇼핑몰" });
    expect(names(await listProducts(db, s.ctx, { q: "POKEmon" }))).toEqual(["Pokemon 부스터", "원피스 카드"]);
    expect(names(await listProducts(db, s.ctx, { q: "  부스터  " }))).toEqual(["Pokemon 부스터"]);
    expect(names(await listProducts(db, s.ctx, { q: "없는 이름" }))).toEqual([]);
    // 빈 검색어는 검색하지 않는다
    expect(names(await listProducts(db, s.ctx, { q: " " }))).toHaveLength(4);
  });

  it("%·_도 글자 그대로 찾고(전부 나오지 않음), 전각 글자는 NFKC로 맞춰 찾는다", async () => {
    const s = await seller();
    await made(s.ctx, { name: "할인 50% 팩" });
    await made(s.ctx, { name: "snake_case 팩" });
    await made(s.ctx, { name: "보통 팩" });
    expect(names(await listProducts(db, s.ctx, { q: "%" }))).toEqual(["할인 50% 팩"]);
    expect(names(await listProducts(db, s.ctx, { q: "_" }))).toEqual(["snake_case 팩"]);
    expect(names(await listProducts(db, s.ctx, { q: "５０%" }))).toEqual(["할인 50% 팩"]);
  });

  it("상태·재고 필터, 커서와 함께 동작한다", async () => {
    const s = await seller();
    for (let i = 0; i < 5; i++) await made(s.ctx, { name: `포켓몬 ${i}`, sortOrder: i, options: [{ name: "1박스", stock: i === 0 ? 0 : 10 }] });
    await made(s.ctx, { name: "포켓몬 숨김", status: "HIDDEN", options: [{ name: "1박스", stock: 10 }] });
    await made(s.ctx, { name: "원피스", options: [{ name: "1박스", stock: 0 }] });
    expect(names(await listProducts(db, s.ctx, { q: "포켓몬", stock: "out" }))).toEqual(["포켓몬 0"]);
    expect(names(await listProducts(db, s.ctx, { q: "포켓몬", status: "HIDDEN" }))).toEqual(["포켓몬 숨김"]);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo++) {
      const r = await listProducts(db, s.ctx, { q: "포켓몬", status: "ON_SALE", cursor, limit: 2 });
      if (!r.ok) throw new Error(r.reason);
      seen.push(...r.value.products.map((p) => p.name));
      if (!r.value.nextCursor) break;
      cursor = r.value.nextCursor;
    }
    expect(seen).toEqual(["포켓몬 0", "포켓몬 1", "포켓몬 2", "포켓몬 3", "포켓몬 4"]);
  });

  it("50자 넘는 검색어·쓸 수 없는 글자는 400과 문구(HTTP)", async () => {
    const s = await seller();
    await made(s.ctx, { name: "부스터 팩" });
    const c = await cookie(s.owner.email);
    const get = (q: string) => listRoute(new Request(`http://localhost:3000/api/seller/products?q=${encodeURIComponent(q)}`, { headers: { ...H, cookie: c } }));
    // 탭·줄바꿈·BOM·폭 없는 공백만 있는 검색어도 400(필터 없는 전체 목록을 돌려주지 않음)
    for (const bad of ["가".repeat(51), "팩\u0000", "\u200b", "\ufeff", "\t", "\n", " \t "]) {
      const r = await get(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_search", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_search });
    }
    const ok = await get("가".repeat(49) + "팩");
    expect(ok.status).toBe(200);
    // 빈 검색어·일반 공백만 있는 검색어는 검색하지 않는다
    for (const blank of ["", " ", "   "]) {
      const r = await get(blank);
      expect(r.status, JSON.stringify(blank)).toBe(200);
      expect((await r.json()).products).toHaveLength(1);
    }
    expect((await (await get("부스터")).json()).products.map((p: { name: string }) => p.name)).toEqual(["부스터 팩"]);
  });
});

describe("목록 필터: 결과가 많아도 오류 없이 SQL에서 거른다", () => {
  it("검색·재고 조건에 맞는 상품이 Postgres 바인드 변수 한도(32,767)를 넘어도 500 없이 쪽을 나눠 돌려주고, 다른 쇼핑몰은 섞이지 않는다", async () => {
    const s = await seller();
    const other = await seller();
    const N = 33000;
    for (const sid of [s.ctx.sellerId, other.ctx.sellerId]) {
      // 상품 코드 번호를 직접 넣어 행마다 도는 번호 트리거를 건너뛴다(이 시험은 목록 필터만 본다)
      await db.$executeRaw`INSERT INTO "Product" ("sellerId", "name", "price", "status", "sortOrder", "codeNo")
        SELECT ${sid}::uuid, '포켓몬 카드 ' || g, 5000, 'ON_SALE', 0, g FROM generate_series(1, ${N}) g`;
    }
    for (const opts of [{ q: "포켓몬" }, { stock: "out" }, { q: "카드", stock: "out", status: "ON_SALE" }]) {
      const first = await listProducts(db, s.ctx, { ...opts, limit: 2 });
      expect(first.ok, JSON.stringify(opts)).toBe(true);
      if (!first.ok) continue;
      expect(first.value.products).toHaveLength(2);
      expect(first.value.products.every((p) => p.sellerId === s.ctx.sellerId)).toBe(true);
      const next = await listProducts(db, s.ctx, { ...opts, limit: 2, cursor: first.value.nextCursor ?? undefined });
      expect(next.ok && next.value.products.map((p) => p.id).filter((id) => first.value.products.some((f) => f.id === id))).toEqual([]);
    }
  }, 120000);
});

describe("목록: id를 고른 뒤 상품을 불러오기 전에 바뀐 상품", () => {
  // 첫 raw 조회(이번 쪽 id 고르기)가 끝난 직후 change를 실행하는 db
  function changeAfterIdQuery(change: () => Promise<unknown>): typeof db {
    let first = true;
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "$queryRaw") {
          return async (...args: unknown[]) => {
            const out = await (target.$queryRaw as (...a: unknown[]) => Promise<unknown>)(...args);
            if (first) {
              first = false;
              await change();
            }
            return out;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  it("그사이 지워지거나 상태가 바뀐 상품은 응답에 없고, 다음 쪽 커서는 그대로 이어진다", async () => {
    const s = await seller();
    const [a, b, c] = [await made(s.ctx, { name: "A", sortOrder: 0 }), await made(s.ctx, { name: "B", sortOrder: 1 }), await made(s.ctx, { name: "C", sortOrder: 2 })];
    const deleted = await listProducts(changeAfterIdQuery(() => deleteProduct(db, s.ctx, a.id)), s.ctx, { limit: 2 });
    expect(deleted.ok && deleted.value.products.map((p) => p.name)).toEqual(["B"]);
    expect(deleted.ok && deleted.value.nextCursor).toBe(b.id);
    const next = await listProducts(db, s.ctx, { limit: 2, cursor: b.id });
    expect(next.ok && next.value.products.map((p) => p.name)).toEqual(["C"]);
    const hidden = await listProducts(
      changeAfterIdQuery(() => db.product.update({ where: { id: c.id }, data: { status: "HIDDEN" } })),
      s.ctx,
      { status: "ON_SALE", limit: 5 },
    );
    expect(hidden.ok && hidden.value.products.map((p) => p.name)).toEqual(["B"]);
  });
});

describe("목록 페이지 넘김: 기준 상품이 그사이 바뀌어도 빠지지 않는다", () => {
  async function seven(ctx: TenantContext) {
    for (let i = 0; i < 7; i++) await made(ctx, { name: `상품${i}`, sortOrder: i % 2 });
  }
  async function pages(ctx: TenantContext, opts: { status?: string }, between: (cursor: string, round: number) => Promise<void>) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 10; round++) {
      const r = await listProducts(db, ctx, { ...opts, cursor, limit: 2 });
      if (!r.ok) throw new Error(r.reason);
      seen.push(...r.value.products.map((p) => p.id));
      if (!r.value.nextCursor) break;
      cursor = r.value.nextCursor;
      await between(cursor, round);
    }
    return seen;
  }

  it("다음 쪽을 부르기 전에 기준(nextCursor) 상품을 지워도 나머지 상품이 하나도 빠지지 않는다", async () => {
    const s = await seller();
    await seven(s.ctx);
    const deleted: string[] = [];
    const seen = await pages(s.ctx, {}, async (cursor, round) => {
      if (round === 0) {
        await deleteProduct(db, s.ctx, cursor);
        deleted.push(cursor);
      }
    });
    const alive = (await db.product.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id, deletedAt: null }, select: { id: true } })).map((p) => p.id);
    expect(alive).toHaveLength(6);
    // 첫 쪽에서 이미 받은 기준 상품 + 살아 있는 나머지 6개가 모두 한 번씩
    expect(new Set(seen)).toEqual(new Set([...alive, ...deleted]));
    expect(seen).toHaveLength(7);
  });

  it("판매 중 필터에서 기준 상품을 숨김으로 바꿔도 나머지 판매 중 상품이 빠지지 않는다", async () => {
    const s = await seller();
    await seven(s.ctx);
    const hidden: string[] = [];
    const seen = await pages(s.ctx, { status: "ON_SALE" }, async (cursor, round) => {
      if (round === 0) {
        await updateProduct(db, s.ctx, cursor, { status: "HIDDEN" });
        hidden.push(cursor);
      }
    });
    const onSale = (await db.product.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id, status: "ON_SALE" }, select: { id: true } })).map((p) => p.id);
    expect(onSale).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set([...onSale, ...hidden]));
    expect(seen).toHaveLength(7);
  });
});

describe("재고 변경", () => {
  it("화면이 본 재고(expectedStock)가 지금과 다르면(결제 차감과 겹침) 409로 덮어쓰지 않고, 같으면 바꾸고 차이를 이력으로 남긴다", async () => {
    const s = await seller();
    const p = await made(s.ctx);
    const optionId = p.options[0].id;
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId, quantity: 3 }], consent, shippingAddress });
    if (!o.ok) throw new Error(o.reason);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" });
    expect(await updateOption(db, s.ctx, p.id, optionId, { stock: 20, expectedStock: 10 })).toEqual({ ok: false, reason: "stock_conflict" });
    expect((await db.productOption.findUniqueOrThrow({ where: { id: optionId } })).stock).toBe(7);
    expect(await updateOption(db, s.ctx, p.id, optionId, { stock: 20, expectedStock: 7 })).toMatchObject({ ok: true, value: { options: [{ stock: 20 }] } });
    // 「변경 후」 일괄 적용도 사유와 함께 남긴다(MASTER 후속), 등록 때 재고는 「처음 재고」
    expect(await db.stockMovement.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { optionId, reason: "MANUAL", delta: 13 } })).toMatchObject({ note: "재고 일괄 수정" });
    expect(await db.stockMovement.count({ where: { optionId, reason: "MANUAL", note: null } })).toBe(0);
    for (const body of [{ stock: 5 }, { stock: -1, expectedStock: 20 }, { stock: 1.5, expectedStock: 20 }, {}]) {
      expect(await updateOption(db, s.ctx, p.id, optionId, body), JSON.stringify(body)).toEqual({ ok: false, reason: "invalid_option" });
    }
  });
});

describe("판매가 변경과 기존 주문", () => {
  it("판매가 정상 변경·충돌 거절은 이미 받은 주문 금액·환불 수량·옵션 재고를 바꾸지 않는다", async () => {
    const s = await seller();
    const p = await made(s.ctx);
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    expect(await createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId: p.options[0].id, quantity: 1 }], consent, shippingAddress })).toMatchObject({ ok: true });
    const readOrder = () => db.order.findMany({ where: { sellerId: s.seller.id }, select: { totalAmount: true, items: { select: { unitPrice: true, listUnitPrice: true, quantity: true, refundedQuantity: true } } } });
    const orders = await readOrder();
    const stock = await db.productOption.findUniqueOrThrow({ where: { id: p.options[0].id }, select: { stock: true } });
    const movements = await db.stockMovement.count({ where: { sellerId: s.seller.id } });
    expect((await updateProduct(db, s.ctx, p.id, { price: 7000, expectedPrice: 5000 })).ok).toBe(true);
    expect(await updateProduct(db, s.ctx, p.id, { price: 8000, expectedPrice: 5000 })).toMatchObject({ ok: false, reason: "price_conflict", currentPrice: 7000 });
    expect(await readOrder()).toEqual(orders);
    expect(await db.productOption.findUniqueOrThrow({ where: { id: p.options[0].id }, select: { stock: true } })).toEqual(stock);
    expect(await db.stockMovement.count({ where: { sellerId: s.seller.id } })).toBe(movements);
  });
});

describe("소프트 삭제", () => {
  it("지운 상품·옵션은 목록·조회·새 주문에서 빠지고, 지난 주문 품목은 그대로 남는다", async () => {
    const s = await seller();
    const p = await made(s.ctx, { options: [{ name: "A", stock: 5 }, { name: "B", stock: 5 }] });
    const [a, b] = p.options;
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    const order = (optionId: string) => createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId, quantity: 1 }], consent, shippingAddress });
    const before = await order(a.id);
    expect(before).toMatchObject({ ok: true });

    expect(await deleteOption(db, s.ctx, p.id, a.id)).toMatchObject({ ok: true, value: { options: [{ name: "B" }] } });
    expect(await order(a.id)).toEqual({ ok: false, reason: "product_unavailable" });
    expect(await db.productOption.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ deletedAt: expect.any(Date) });
    // 판매 중 상품의 마지막 옵션은 지우지 않는다
    expect(await deleteOption(db, s.ctx, p.id, b.id)).toEqual({ ok: false, reason: "no_sellable_option" });
    await expect(deleteOption(db, s.ctx, p.id, a.id)).rejects.toMatchObject({ status: 404 });

    await deleteProduct(db, s.ctx, p.id);
    expect(await listProducts(db, s.ctx)).toEqual({ ok: true, value: { products: [], nextCursor: null } });
    await expect(getProduct(db, s.ctx, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateProduct(db, s.ctx, p.id, { name: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteProduct(db, s.ctx, p.id)).rejects.toMatchObject({ status: 404 });
    expect(await order(b.id)).toEqual({ ok: false, reason: "product_unavailable" });
    expect(await db.orderItem.count({ where: { optionId: a.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: { in: ["product.delete", "product_option.delete"] } } })).toBe(2);
  });
});

describe("판매자 격리·권한", () => {
  it("다른 판매자 상품·옵션, 다른 상품의 옵션은 없는 것(404)으로 보고 바꾸지 않는다", async () => {
    const s = await seller();
    const other = await seller();
    const p = await made(s.ctx);
    const q = await made(s.ctx, { name: "다른 상품" });
    await expect(getProduct(db, other.ctx, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateProduct(db, other.ctx, p.id, { price: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(deleteProduct(db, other.ctx, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(createOption(db, other.ctx, p.id, { name: "침입" })).rejects.toMatchObject({ status: 404 });
    await expect(updateOption(db, other.ctx, p.id, p.options[0].id, { name: "침입" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteOption(db, other.ctx, p.id, p.options[0].id)).rejects.toMatchObject({ status: 404 });
    // 같은 판매자라도 상품과 옵션 짝이 다르면 404
    await expect(updateOption(db, s.ctx, q.id, p.options[0].id, { name: "엇갈림" })).rejects.toMatchObject({ status: 404 });
    expect(await listProducts(db, other.ctx)).toEqual({ ok: true, value: { products: [], nextCursor: null } });
    expect(await db.product.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ price: 5000, deletedAt: null });
    expect(await db.productOption.findUniqueOrThrow({ where: { id: p.options[0].id } })).toMatchObject({ name: "1박스" });
  });

  it("HTTP: 상품 권한 없는 직원은 403, 상품 권한 직원은 가능, 다른 판매자 세션은 404", async () => {
    const s = await seller();
    const other = await seller();
    const p = await made(s.ctx);
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    const otherOwner = await createSellerUser(other.seller.id, "OWNER");
    const list = (c: string) => listRoute(new Request("http://localhost:3000/api/seller/products", { headers: { ...H, cookie: c } }));
    const patch = (c: string, body: unknown) =>
      productPatchRoute(new Request(`http://localhost:3000/api/seller/products/${p.id}`, { method: "PATCH", headers: { ...H, cookie: c }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ productId: p.id }),
      });

    expect((await list(await cookie(broadcaster.email))).status).toBe(403);
    expect((await patch(await cookie(broadcaster.email), { name: "x" })).status).toBe(403);
    const staffCookie = await cookie(staff.email);
    expect((await (await list(staffCookie)).json()).products).toHaveLength(1);
    expect((await patch(staffCookie, { status: "SOLD_OUT" })).status).toBe(200);
    expect(await patch(await cookie(otherOwner.email), { price: 1 }).then((r) => r.status)).toBe(404);
    const get = await productGetRoute(new Request(`http://localhost:3000/api/seller/products/${p.id}`, { headers: { ...H, cookie: await cookie(otherOwner.email) } }), {
      params: Promise.resolve({ productId: p.id }),
    });
    expect(get.status).toBe(404);
    expect(await db.product.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: "SOLD_OUT", price: 5000 });
  });

  it("마스터 대리 조회는 상품 목록·조회만 되고 등록·변경·삭제·옵션 변경은 403", async () => {
    const s = await seller();
    const p = await made(s.ctx);
    const admin = await createAdmin("CS");
    const login = await loginAdmin(db, adminCredentials(admin), {});
    if (!login.ok) throw new Error("login failed");
    const ctx = await impersonateSeller(db, await requireAdmin(db, login.token, "platform.read"), s.seller.id, "상품 문의 확인");
    expect(await listProducts(db, ctx)).toMatchObject({ ok: true, value: { products: [{ id: p.id }] } });
    expect((await getProduct(db, ctx, p.id)).id).toBe(p.id);
    await expect(createProduct(db, ctx, { name: "x", price: 1000 })).rejects.toMatchObject({ status: 403 });
    await expect(updateProduct(db, ctx, p.id, { name: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(deleteProduct(db, ctx, p.id)).rejects.toMatchObject({ status: 403 });
    await expect(createOption(db, ctx, p.id, { name: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(updateOption(db, ctx, p.id, p.options[0].id, { stock: 0, expectedStock: 10 })).rejects.toMatchObject({ status: 403 });
    await expect(deleteOption(db, ctx, p.id, p.options[0].id)).rejects.toMatchObject({ status: 403 });
    expect(await db.product.findUniqueOrThrow({ where: { id: p.id }, include: { options: true } })).toMatchObject({ name: "부스터 팩", deletedAt: null, options: [{ stock: 10 }] });
  });

  it("HTTP: 등록·옵션 추가·재고 충돌·삭제 응답과 화면 문구, 잠긴 판매자는 402, 다른 출처는 403", async () => {
    const s = await seller();
    const c = await cookie(s.owner.email);
    const create = (body: unknown, headers: Record<string, string> = H) =>
      createRoute(new Request("http://localhost:3000/api/seller/products", { method: "POST", headers: { ...headers, cookie: c }, body: JSON.stringify(body) }));
    const bad = await create({ name: "x", price: 1000, options: [{ name: "o", priceDelta: -1000 }] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_price", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_price });
    const ok = await create({ name: "부스터 팩", price: 1000, options: [{ name: "o", stock: 2 }] });
    expect(ok.status).toBe(201);
    const p = await ok.json();

    const added = await optionCreateRoute(
      new Request(`http://localhost:3000/api/seller/products/${p.id}/options`, { method: "POST", headers: { ...H, cookie: c }, body: JSON.stringify({ name: "o2", stock: 1 }) }),
      { params: Promise.resolve({ productId: p.id }) },
    );
    expect(added.status).toBe(201);
    const optionCall = (route: typeof optionPatchRoute, method: string, body?: unknown) =>
      route(
        new Request(`http://localhost:3000/api/seller/products/${p.id}/options/${p.options[0].id}`, { method, headers: { ...H, cookie: c }, body: body ? JSON.stringify(body) : undefined }),
        { params: Promise.resolve({ productId: p.id, optionId: p.options[0].id }) },
      );
    const conflict = await optionCall(optionPatchRoute, "PATCH", { stock: 9, expectedStock: 1 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "stock_conflict", message: ORDER_ERROR_MESSAGES_FORMAL.stock_conflict });
    expect((await optionCall(optionDeleteRoute, "DELETE")).status).toBe(200);

    expect((await create({ name: "y", price: 1000 }, { ...H, origin: "http://evil.example" })).status).toBe(403);
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    expect((await create({ name: "y", price: 1000 })).status).toBe(402);
    expect(await db.product.count()).toBe(1);
  });
});
