import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as exportRoute } from "../../app/api/seller/bulk-io/products/export/route";
import { POST as previewRoute } from "../../app/api/seller/bulk-io/products/preview/route";
import { GET as templateRoute } from "../../app/api/seller/bulk-io/products/template/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { COLUMNS, commitProductImport, exportProductsXlsx, previewProductImportXlsx } from "../../lib/server/shop-bulk-io/service";
import { XLSX_MAX_BYTES, readXlsx, writeXlsx } from "../../lib/server/shop-bulk-io/xlsx";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createCategory } from "../../lib/server/shop-category/service";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 엑셀(.xlsx) 일괄 등록·내보내기(SA-018): CSV와 같은 열·검증, 5MB, 행 번호는 엑셀 화면과 같다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const H = { host: "localhost:3000", origin: "http://localhost:3000" };
const head = [...COLUMNS];

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const cookie = async (email = owner.email) => {
    const r = await loginSeller(db, { email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  };
  return { seller, owner, ctx, cookie };
}
const post = (cookie: string, body: BodyInit, headers: Record<string, string>) => previewRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie, ...headers }, body }));
const live = (sellerId: string) => db.product.findMany({ where: { sellerId, deletedAt: null }, orderBy: { codeNo: "asc" }, include: { options: { orderBy: { sortOrder: "asc" } } } });

describe("엑셀 미리보기·확정", () => {
  it("엑셀 본문(raw)으로 올리면 CSV와 같이 검증하고, 오류 줄 번호는 엑셀 행 번호다. 확정하면 상품이 생긴다", async () => {
    const s = await shop();
    const c = await s.cookie();
    const file = writeXlsx([head, ["부스터 팩", "5000", "판매중", "설명", "주문 시", "", "기본", "0", "30", "BP-1"], ["", "", "", "", "", "", "", "", "", ""], ["잘못", "abc", "판매중", "", "", "", "기본", "0", "1", ""]]);
    const res = await post(c, new Uint8Array(file), { "content-type": XLSX, "x-file-name": encodeURIComponent("상품_1004.xlsx") });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ totalRows: 2, productCount: 1, skippedProductCount: 1, errorTotal: 1, errors: [{ row: 4, column: "판매가" }], products: [{ name: "부스터 팩", price: 5000, status: "ON_SALE" }] });
    expect((await db.bulkJob.findUniqueOrThrow({ where: { id: body.jobId } })).fileName).toBe("상품_1004.xlsx");
    expect(await live(s.seller.id)).toEqual([]);
    const done = await commitProductImport(db, s.ctx, body.jobId);
    expect(done).toMatchObject({ ok: true, value: { status: "COMMITTED", createdCount: 1 } });
    const [p] = await live(s.seller.id);
    expect(p).toMatchObject({ name: "부스터 팩", price: 5000, stockDeductMode: "ORDER" });
    expect(p.options.map((o) => [o.name, o.stock, o.sku])).toEqual([["기본", 30, "BP-1"]]);
  });

  it("multipart의 file 칸으로도 올릴 수 있고, 파일이 없거나 엑셀이 아니면 400 invalid_xlsx", async () => {
    const s = await shop();
    const c = await s.cookie();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(writeXlsx([head, ["슬리브", "3000", "판매중", "", "", "", "검정", "0", "10", ""]]))], "a.xlsx", { type: XLSX }));
    const ok = await previewRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie: c }, body: form }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ productCount: 1, totalRows: 1 });
    expect((await db.bulkJob.findFirstOrThrow({ where: { sellerId: s.seller.id } })).fileName).toBe("a.xlsx");
    const none = await previewRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie: c }, body: new FormData() }));
    expect([none.status, (await none.json()).error]).toEqual([400, "invalid_xlsx"]);
    const garbage = await post(c, "상품명,판매가\n부스터,5000", { "content-type": XLSX });
    expect([garbage.status, (await garbage.json()).error]).toEqual([400, "invalid_xlsx"]);
    expect(await db.bulkJob.count({ where: { sellerId: s.seller.id } })).toBe(1);
  });

  it("5MB를 넘으면 413 xlsx_too_large이고 작업을 만들지 않는다. 양식 열이 다르면 400 invalid_header", async () => {
    const s = await shop();
    const c = await s.cookie();
    const big = await post(c, new Uint8Array(XLSX_MAX_BYTES + 1), { "content-type": XLSX });
    expect([big.status, (await big.json()).error]).toEqual([413, "xlsx_too_large"]);
    expect(await previewProductImportXlsx(db, s.ctx, { bytes: Buffer.alloc(XLSX_MAX_BYTES + 1) })).toEqual({ ok: false, reason: "xlsx_too_large" });
    const wrongHead = await post(c, new Uint8Array(writeXlsx([["상품명", "가격"], ["A", "1"]])), { "content-type": XLSX });
    expect([wrongHead.status, (await wrongHead.json()).error]).toEqual([400, "invalid_header"]);
    const empty = await post(c, new Uint8Array(writeXlsx([head])), { "content-type": XLSX });
    expect([empty.status, (await empty.json()).error]).toEqual([400, "empty_file"]);
    const tooMany = await post(c, new Uint8Array(writeXlsx([head, ...Array.from({ length: 1001 }, (_, i) => [`상품${i}`, "1000", "판매중", "", "", "", "기본", "0", "1", ""])])), { "content-type": XLSX });
    expect([tooMany.status, (await tooMany.json()).error]).toEqual([400, "too_many_rows"]);
    expect(await db.bulkJob.count({ where: { sellerId: s.seller.id } })).toBe(0);
  });

  it("상품 관리 권한이 없는 직원은 올릴 수 없다", async () => {
    const s = await shop();
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const res = await post(await s.cookie(staff.email), new Uint8Array(writeXlsx([head, ["A", "1000", "판매중", "", "", "", "기본", "0", "1", ""]])), { "content-type": XLSX });
    expect(res.status).toBe(403);
    expect(await db.bulkJob.count({ where: { sellerId: s.seller.id } })).toBe(0);
  });
});

describe("엑셀 양식·내보내기", () => {
  it("양식(.xlsx)을 그대로 올리면 예시 상품 2개가 통과한다", async () => {
    const s = await shop();
    const c = await s.cookie();
    // 양식 예시의 카테고리 「카드>부스터」
    const parent = await createCategory(db, s.ctx, { name: "카드" });
    if (!parent.ok) throw new Error(parent.reason);
    const child = await createCategory(db, s.ctx, { name: "부스터", parentId: parent.value[0].id });
    if (!child.ok) throw new Error(child.reason);
    const t = await templateRoute(new Request("http://localhost:3000/x?format=xlsx", { headers: { cookie: c } }));
    expect([t.status, t.headers.get("content-type")]).toEqual([200, XLSX]);
    expect(t.headers.get("content-disposition")).toContain(".xlsx");
    const bytes = Buffer.from(await t.arrayBuffer());
    const read = readXlsx(bytes);
    expect(read.ok && read.rows[0]).toEqual(head);
    const res = await post(c, new Uint8Array(bytes), { "content-type": XLSX });
    expect(await res.json()).toMatchObject({ totalRows: 3, productCount: 2, errorTotal: 0 });
  });

  it("상품 내보내기(.xlsx)는 다시 올려도 같은 상품으로 읽힌다(수식처럼 보이는 글자 보호 포함)", async () => {
    const s = await shop();
    const c = await s.cookie();
    const seed = await post(
      c,
      new Uint8Array(writeXlsx([head, ["=위험 수식", "5000", "판매중", "설명, \"따옴표\"\n줄바꿈", "주문 시", "", "기본", "0", "30", "00123"], ["슬리브", "3000", "품절", "", "결제 시", "", "검정", "0", "0", ""], ["", "", "", "", "", "", "흰색", "500", "5", ""]])),
      { "content-type": XLSX },
    );
    const seeded = await seed.json();
    expect(seeded).toMatchObject({ productCount: 2, errorTotal: 0 });
    await commitProductImport(db, s.ctx, seeded.jobId);

    const ex = await exportRoute(new Request("http://localhost:3000/x?format=xlsx", { headers: { cookie: c } }));
    expect([ex.status, ex.headers.get("content-type"), ex.headers.get("x-product-count")]).toEqual([200, XLSX, "2"]);
    const bytes = Buffer.from(await ex.arrayBuffer());
    const sheet = readXlsx(bytes);
    if (!sheet.ok) throw new Error(sheet.reason);
    expect(sheet.rows[0]).toEqual(head);
    const danger = sheet.rows.find((r) => r[0] === "'=위험 수식");
    expect(danger?.[9]).toBe("00123");
    // 그대로 다시 올리면 같은 상품 2개로 통과(작은따옴표 보호는 읽을 때 벗겨진다)
    const again = await post(c, new Uint8Array(bytes), { "content-type": XLSX });
    const body = await again.json();
    expect(body).toMatchObject({ productCount: 2, errorTotal: 0, products: expect.arrayContaining([expect.objectContaining({ name: "=위험 수식", price: 5000 }), expect.objectContaining({ name: "슬리브", price: 3000, status: "SOLD_OUT" })]) });
  });

  it("엑셀 내보내기도 로그 추적과 처리 이력에 남고 권한이 없으면 막힌다", async () => {
    const s = await shop();
    const r = await exportProductsXlsx(db, s.ctx);
    expect(r).toMatchObject({ ok: true, value: { count: 0 } });
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "bulk_io.product_export" } })).toBe(1);
    expect(await db.bulkJob.count({ where: { sellerId: s.seller.id, kind: "PRODUCT_EXPORT" } })).toBe(1);
    const noRight: TenantContext = { ...s.ctx, isOwner: false, permissions: ["ORDER_SHIPPING"] };
    await expect(exportProductsXlsx(db, noRight)).rejects.toThrow();
  });
});
