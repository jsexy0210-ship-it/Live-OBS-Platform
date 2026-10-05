import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as sellerGet, PUT as sellerPut } from "../../app/api/seller/shop-legal/[kind]/route";
import { GET as publicGet } from "../../app/api/shop/[slug]/legal/[kind]/route";
import ShopLegal from "../../components/shop/ShopLegal";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { BODY_MAX, SHOP_LEGAL_MESSAGES } from "../../lib/server/shop-legal/service";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쇼핑몰별 이용약관·개인정보처리방침: 권한(대표자·쇼핑몰 설정 직원만 쓰기), 판매자 격리, 검사, version 충돌·동시 저장,
// 게시 전 비노출(초안 본문이 구매자에게 새지 않음), 운영 중이 아닌 쇼핑몰 404, 로그 추적에 본문이 남지 않음, 화면은 텍스트로만(HTML 이스케이프).
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const req = (path: string, method = "GET", cookie?: string, body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

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
const get = async (cookie: string, kind = "terms") => json(await sellerGet(req(`/api/seller/shop-legal/${kind}`, "GET", cookie), p({ kind })));
const put = async (cookie: string, body: unknown, kind = "terms") => json(await sellerPut(req(`/api/seller/shop-legal/${kind}`, "PUT", cookie, body), p({ kind })));
const pub = async (slug: string, kind = "terms") => json(await publicGet(req(`/api/shop/${slug}/legal/${kind}`), p({ slug, kind })));
const DOC = { body: "제1조(목적)\n이 약관은 쇼핑몰 이용 조건을 정해요.", effectiveOn: "2026-11-01", isPublished: true };

describe("파트너스 입력", () => {
  it("대표자·쇼핑몰 설정 직원만 쓰고, 다른 직원은 보기만 하며, 로그인 없으면 401", async () => {
    const s = await shop();
    expect(await get(s.owner)).toMatchObject({ status: 200, body: { doc: { kind: "terms", body: "", effectiveOn: null, isPublished: false, version: 0 } } });
    expect((await put(s.owner, { ...DOC, expectedVersion: 0 })).status).toBe(200);
    expect((await put(s.staff, { ...DOC, body: "직원이 고침", expectedVersion: 1 })).status).toBe(200);
    expect((await put(s.noPerm, { ...DOC, expectedVersion: 2 })).status).toBe(403);
    expect((await get(s.noPerm)).body.doc).toMatchObject({ body: "직원이 고침", version: 2 });
    expect((await json(await sellerGet(req("/api/seller/shop-legal/terms"), p({ kind: "terms" })))).status).toBe(401);
    expect((await put("", { ...DOC, expectedVersion: 2 })).status).toBe(401);
  });

  it("종류는 terms·privacy만, 서로 따로 저장한다", async () => {
    const s = await shop();
    expect((await get(s.owner, "x")).status).toBe(404);
    expect((await put(s.owner, { ...DOC, expectedVersion: 0 }, "x")).status).toBe(404);
    await put(s.owner, { ...DOC, expectedVersion: 0 }, "terms");
    await put(s.owner, { ...DOC, body: "처리방침 본문", expectedVersion: 0 }, "privacy");
    expect((await get(s.owner, "terms")).body.doc.body).toContain("제1조");
    expect((await get(s.owner, "privacy")).body.doc.body).toBe("처리방침 본문");
  });

  it("잘못된 값을 막는다(본문 길이·시행일·게시 조건)", async () => {
    const s = await shop();
    const bad = async (body: unknown, error: string) => {
      const r = await put(s.owner, { expectedVersion: 0, ...(body as object) });
      expect([r.status, r.body.error]).toEqual([400, error]);
      expect(r.body.message).toBe(SHOP_LEGAL_MESSAGES[error as keyof typeof SHOP_LEGAL_MESSAGES]);
    };
    await bad({ body: "가".repeat(BODY_MAX + 1) }, "invalid_body");
    await bad({ body: "a\u0000b" }, "invalid_body");
    await bad({ body: 123 }, "invalid_body");
    await bad({ body: "본문", effectiveOn: "내일" }, "invalid_date");
    await bad({ body: "본문", effectiveOn: "2026-02-30" }, "invalid_date");
    await bad({ body: "본문", effectiveOn: "1999-12-31" }, "invalid_date");
    await bad({ body: "본문", effectiveOn: 20261101 }, "invalid_date");
    await bad({ body: "", effectiveOn: "2026-11-01", isPublished: true }, "publish_incomplete");
    await bad({ body: "본문", isPublished: true }, "publish_incomplete");
    // 상한 정확히는 저장된다, 초안(미게시)은 본문·시행일 없이도 저장된다
    expect((await put(s.owner, { body: "가".repeat(BODY_MAX), expectedVersion: 0 })).status).toBe(200);
    expect((await put(s.owner, { expectedVersion: 1 })).body.doc).toMatchObject({ body: "", effectiveOn: null, isPublished: false, version: 2 });
  });

  it("옛 version은 409, 같은 version 동시 저장은 하나만 성공한다", async () => {
    const s = await shop();
    expect((await put(s.owner, { ...DOC, expectedVersion: 0 })).body.doc.version).toBe(1);
    expect(await put(s.owner, { ...DOC, expectedVersion: 0 })).toMatchObject({ status: 409, body: { error: "version_conflict", currentVersion: 1 } });
    expect((await put(s.owner, { ...DOC })).status).toBe(409); // expectedVersion 없음
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => put(s.owner, { ...DOC, body: `동시 ${i}`, expectedVersion: 1 })));
    expect(rs.map((x) => x.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect((await get(s.owner)).body.doc.version).toBe(2);
  });

  it("바꿀 때마다 로그 추적에 남지만 본문은 남기지 않고 글자 수만 남긴다", async () => {
    const s = await shop();
    await put(s.owner, { ...DOC, expectedVersion: 0 });
    const logs = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: "shop.legal.update" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].after).toMatchObject({ kind: "TERMS", isPublished: true, effectiveOn: "2026-11-01", version: 1, bodyLength: [...DOC.body].length });
    expect(JSON.stringify(logs[0])).not.toContain("제1조");
  });
});

describe("구매자 조회", () => {
  it("게시 전에는 초안 본문이 보이지 않고, 게시하면 본문·시행일이 보이며, 내리면 다시 준비 중이다", async () => {
    const s = await shop();
    expect(await pub(s.seller.slug)).toEqual({ status: 200, body: { published: false, kind: "terms" } });
    await put(s.owner, { body: "초안 본문(비공개)", effectiveOn: "2026-11-01", isPublished: false, expectedVersion: 0 });
    expect(await pub(s.seller.slug)).toEqual({ status: 200, body: { published: false, kind: "terms" } });
    expect((await put(s.owner, { ...DOC, expectedVersion: 1 })).status).toBe(200);
    expect(await pub(s.seller.slug)).toEqual({ status: 200, body: { published: true, kind: "terms", body: DOC.body, effectiveOn: "2026-11-01", version: 2 } });
    const first = (await db.shopLegalDoc.findFirstOrThrow({ where: { sellerId: s.seller.id } })).publishedAt;
    await put(s.owner, { ...DOC, body: "고친 본문", expectedVersion: 2 });
    expect((await db.shopLegalDoc.findFirstOrThrow({ where: { sellerId: s.seller.id } })).publishedAt).toEqual(first); // 처음 게시 시각 유지
    await put(s.owner, { ...DOC, isPublished: false, expectedVersion: 3 });
    expect((await pub(s.seller.slug)).body).toEqual({ published: false, kind: "terms" });
    expect((await db.shopLegalDoc.findFirstOrThrow({ where: { sellerId: s.seller.id } })).publishedAt).toBeNull();
  });

  it("다른 쇼핑몰 글이 섞이지 않는다(판매자 격리)", async () => {
    const a = await shop();
    const b = await shop();
    await put(a.owner, { ...DOC, body: "A 쇼핑몰 약관", expectedVersion: 0 });
    expect((await pub(a.seller.slug)).body).toMatchObject({ published: true, body: "A 쇼핑몰 약관" });
    expect((await pub(b.seller.slug)).body).toEqual({ published: false, kind: "terms" });
    // B 파트너스는 A의 글을 읽지도 쓰지도 못한다(자기 쇼핑몰 값만 다룬다)
    expect((await get(b.owner)).body.doc).toMatchObject({ body: "", version: 0 });
    await put(b.owner, { ...DOC, body: "B 쇼핑몰 약관", expectedVersion: 0 });
    expect((await pub(a.seller.slug)).body).toMatchObject({ body: "A 쇼핑몰 약관", version: 1 });
    expect((await pub(b.seller.slug)).body).toMatchObject({ body: "B 쇼핑몰 약관", version: 1 });
  });

  it("없는 쇼핑몰·운영 중이 아닌 쇼핑몰·알 수 없는 종류는 404", async () => {
    const s = await shop();
    await put(s.owner, { ...DOC, expectedVersion: 0 });
    expect((await pub("no-such-shop")).status).toBe(404);
    expect((await pub(s.seller.slug, "x")).status).toBe(404);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await pub(s.seller.slug)).status).toBe(404);
  });
});

describe("화면", () => {
  it("본문은 텍스트로만 그린다: 태그·스크립트는 글자 그대로 이스케이프된다", () => {
    const html = renderToStaticMarkup(createElement(ShopLegal, { kind: "terms", doc: { published: true, body: '<script>alert(1)</script><img src=x onerror="a()">\n두 번째 줄', effectiveOn: "2026-11-01" } }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("시행일 2026년 11월 1일");
  });

  it("게시 전·운영 중이 아닌 쇼핑몰은 안내만 보인다(해요체)", () => {
    const pending = renderToStaticMarkup(createElement(ShopLegal, { kind: "privacy", doc: { published: false } }));
    expect(pending).toContain("개인정보처리방침을 준비하고 있어요");
    expect(pending).not.toContain("shop-legal-body");
    expect(renderToStaticMarkup(createElement(ShopLegal, { kind: "terms", doc: null }))).toContain("지금은 쇼핑몰을 이용할 수 없어요");
  });
});
