import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as exportRoute } from "../../app/api/seller/bulk-io/products/export/route";
import { POST as previewRoute } from "../../app/api/seller/bulk-io/products/preview/route";
import { GET as templateRoute } from "../../app/api/seller/bulk-io/products/template/route";
import { GET as jobRoute } from "../../app/api/seller/bulk-io/jobs/[jobId]/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { BULK_MESSAGES, commitProductImport, exportProductsCsv, getBulkJob, listBulkJobs, previewProductImport, undoProductImport } from "../../lib/server/shop-bulk-io/service";
import { parseCsv } from "../../lib/server/shop-bulk-io/csv";
import { createCategory } from "../../lib/server/shop-category/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 엑셀(CSV) 일괄 등록·내보내기(SA-018)
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const HEAD = "상품명,판매가,상태,설명,차감시점,카테고리,옵션명,옵션추가금,재고,SKU";
const csv = (...rows: string[]) => [HEAD, ...rows].join("\r\n");
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, owner, ctx };
}
const preview = async (ctx: TenantContext, text: string) => {
  const r = await previewProductImport(db, ctx, { csv: text, fileName: "a.csv" });
  if (!r.ok) throw new Error(r.reason);
  return r.value as { jobId: string; totalRows: number; productCount: number; skippedProductCount: number; errorTotal: number; errors: { row: number; column: string | null }[]; products: { name: string }[] };
};
const commit = async (ctx: TenantContext, id: string) => {
  const r = await commitProductImport(db, ctx, id);
  return r.ok ? (r.value as { status: string; createdCount: number; failedCount: number; failures: { row: number; message: string }[]; undoUntil: Date }) : r;
};
const liveProducts = (sellerId: string) => db.product.findMany({ where: { sellerId, deletedAt: null }, orderBy: { name: "asc" }, include: { options: { orderBy: { sortOrder: "asc" } } } });

describe("일괄 등록", () => {
  it("미리보기는 상품을 만들지 않고, 확정하면 상품·옵션·재고·카테고리가 생긴다", async () => {
    const s = await shop();
    const parent = await createCategory(db, s.ctx, { name: "카드" });
    if (!parent.ok) throw new Error(parent.reason);
    const child = await createCategory(db, s.ctx, { name: "부스터", parentId: parent.value[0].id });
    if (!child.ok) throw new Error(child.reason);
    const p = await preview(s.ctx, csv("부스터 팩,\"5,000\",판매중,설명,주문 시,카드>부스터,기본,0,30,BP-1", "슬리브,3000,판매중,,,,검정,0,10,", ",,,,,,흰색,500,5,"));
    expect([p.totalRows, p.productCount, p.skippedProductCount, p.errorTotal]).toEqual([3, 2, 0, 0]);
    expect(await liveProducts(s.seller.id)).toEqual([]);
    const c = await commit(s.ctx, p.jobId);
    expect(c).toMatchObject({ status: "COMMITTED", createdCount: 2, failedCount: 0 });
    const [booster, sleeve] = await liveProducts(s.seller.id);
    expect(booster).toMatchObject({ name: "부스터 팩", price: 5000, status: "ON_SALE", stockDeductMode: "ORDER" });
    expect(booster.options.map((o) => [o.name, o.stock, o.sku])).toEqual([["기본", 30, "BP-1"]]);
    expect(sleeve.options.map((o) => [o.name, o.priceDelta, o.stock])).toEqual([["검정", 0, 10], ["흰색", 500, 5]]);
    expect((await db.productCategory.findMany({ where: { productId: booster.id } })).map((r) => r.categoryId).sort()).toEqual([child.value[0].children[0].id]);
    expect(await db.stockMovement.count({ where: { sellerId: s.seller.id } })).toBe(3);
  });

  it("같은 작업을 다시 확정해도 상품은 두 번 만들어지지 않고, 동시에 눌러도 한 번만", async () => {
    const s = await shop();
    const p = await preview(s.ctx, csv("A,1000,판매중,,,,기본,0,1,"));
    const [x, y] = await Promise.all([commitProductImport(db, s.ctx, p.jobId), commitProductImport(db, s.ctx, p.jobId)]);
    expect([x.ok, y.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const again = await commit(s.ctx, p.jobId);
    expect(again).toMatchObject({ status: "COMMITTED", createdCount: 1 });
    expect(await liveProducts(s.seller.id)).toHaveLength(1);
  });

  it("오류 상품은 건너뛰고 나머지만 등록, 오류에는 줄 번호가 있다", async () => {
    const s = await shop();
    const p = await preview(s.ctx, csv("OK,1000,판매중,,,,기본,0,1,", "BAD,abc,판매중,,,,기본,0,1,", ",,,,,,옵션2,0,1,", "BAD2,1000,판매중,,,,,,,"));
    expect([p.productCount, p.skippedProductCount, p.errorTotal]).toEqual([1, 2, 2]);
    expect(p.errors.map((e) => [e.row, e.column])).toEqual([[3, "판매가"], [5, null]]);
    expect(await commit(s.ctx, p.jobId)).toMatchObject({ createdCount: 1 });
    expect((await liveProducts(s.seller.id)).map((x) => x.name)).toEqual(["OK"]);
    const d = await getBulkJob(db, s.ctx, p.jobId);
    expect([d.status, d.errorTotal, d.errors.length, d.createdCount]).toEqual(["COMMITTED", 2, 2, 1]);
  });

  it("등록할 상품이 없으면 확정할 수 없고, 1시간이 지난 미리보기는 만료", async () => {
    const s = await shop();
    const none = await preview(s.ctx, csv("BAD,abc,,,,,,,,"));
    expect(await commit(s.ctx, none.jobId)).toEqual({ ok: false, reason: "nothing_to_import" });
    const p = await preview(s.ctx, csv("A,1000,,,,,,,,"));
    await db.bulkJob.update({ where: { id: p.jobId }, data: { createdAt: new Date(Date.now() - 3601_000) } });
    expect(await commit(s.ctx, p.jobId)).toEqual({ ok: false, reason: "preview_expired" });
    expect(await liveProducts(s.seller.id)).toEqual([]);
  });

  it("파일 오류는 작업을 만들지 않는다", async () => {
    const s = await shop();
    for (const [text, reason] of [["상품명,가격\r\nA,1", "invalid_header"], [HEAD + "\r\n", "empty_file"], [123, "invalid_csv"]] as const) {
      expect(await previewProductImport(db, s.ctx, { csv: text })).toEqual({ ok: false, reason });
    }
    expect(await db.bulkJob.count()).toBe(0);
  });

  it("되돌리기: 등록한 상품을 지우되 주문이 있는 상품은 남긴다. 한 번만, 24시간 안에만", async () => {
    const s = await shop();
    const p = await preview(s.ctx, csv("주문됨,1000,판매중,,,,기본,0,5,", "안팔림,1000,판매중,,,,기본,0,5,"));
    await commit(s.ctx, p.jobId);
    const sold = (await liveProducts(s.seller.id)).find((x) => x.name === "주문됨")!;
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId: sold.options[0].id, quantity: 1 }], consent, shippingAddress });
    expect(o.ok).toBe(true);
    const r = await undoProductImport(db, s.ctx, p.jobId);
    expect(r).toEqual({ ok: true, value: { removedCount: 1, keptCount: 1, kept: [{ productId: sold.id, name: "주문됨" }] } });
    expect((await liveProducts(s.seller.id)).map((x) => x.name)).toEqual(["주문됨"]);
    expect(await undoProductImport(db, s.ctx, p.jobId)).toEqual({ ok: false, reason: "not_undoable" });
    expect((await getBulkJob(db, s.ctx, p.jobId)).status).toBe("UNDONE");
  });

  it("24시간이 지나면 되돌릴 수 없고, 확정 전 작업도 되돌릴 수 없다", async () => {
    const s = await shop();
    const p = await preview(s.ctx, csv("A,1000,판매중,,,,기본,0,5,"));
    expect(await undoProductImport(db, s.ctx, p.jobId)).toEqual({ ok: false, reason: "not_undoable" });
    await commit(s.ctx, p.jobId);
    await db.bulkJob.update({ where: { id: p.jobId }, data: { undoUntil: new Date(Date.now() - 1000) } });
    expect(await undoProductImport(db, s.ctx, p.jobId)).toEqual({ ok: false, reason: "undo_expired" });
    expect(await liveProducts(s.seller.id)).toHaveLength(1);
    expect((await listBulkJobs(db, s.ctx)).jobs[0]).toMatchObject({ status: "COMMITTED", undoable: false });
  });

  it("다른 파트너스의 작업은 확정·되돌리기·조회 모두 404이고 상품에도 영향이 없다", async () => {
    const a = await shop();
    const b = await shop();
    const p = await preview(a.ctx, csv("A,1000,판매중,,,,기본,0,5,"));
    expect(await commitProductImport(db, b.ctx, p.jobId)).toEqual({ ok: false, reason: "job_not_found" });
    expect(await undoProductImport(db, b.ctx, p.jobId)).toEqual({ ok: false, reason: "job_not_found" });
    await expect(getBulkJob(db, b.ctx, p.jobId)).rejects.toBeDefined();
    expect((await listBulkJobs(db, b.ctx)).jobs).toEqual([]);
    expect(await liveProducts(b.seller.id)).toEqual([]);
  });

  it("상품 관리 권한이 없는 직원·조회 전용(마스터 대리)은 쓸 수 없다", async () => {
    const s = await shop();
    const staff: TenantContext = { ...s.ctx, isOwner: false, permissions: [] };
    const readOnly: TenantContext = { ...s.ctx, readOnly: true };
    for (const c of [staff, readOnly]) {
      await expect(previewProductImport(db, c, { csv: csv("A,1000,,,,,,,,") })).rejects.toBeDefined();
      await expect(exportProductsCsv(db, c)).rejects.toBeDefined();
    }
    await expect(listBulkJobs(db, staff)).rejects.toBeDefined();
    expect(await db.bulkJob.count()).toBe(0);
  });
});

describe("상품 내보내기", () => {
  it("쉼표·따옴표·줄바꿈·수식 글자가 든 상품도 내보냈다가 그대로 다시 읽힌다. 지운 상품은 뺀다", async () => {
    const s = await shop();
    const p = await preview(s.ctx, csv('"=위험, ""이름""",1000,판매중,"줄1\n줄2",,,옵션A,100,3,SKU-1', ",,,,,,옵션B,0,4,", "지울 상품,500,준비중,,,,,,,"));
    await commit(s.ctx, p.jobId);
    const gone = (await liveProducts(s.seller.id)).find((x) => x.name === "지울 상품")!;
    await db.product.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const r = await exportProductsCsv(db, s.ctx);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.count).toBe(1);
    const rows = (parseCsv(r.value.csv) as { rows: string[][] }).rows;
    expect(rows[0]).toEqual(HEAD.split(","));
    expect(rows[1][0]).toBe("'=위험, \"이름\"");
    expect(rows.slice(1).map((x) => [x[6], x[7], x[8], x[9]])).toEqual([["옵션A", "100", "3", "SKU-1"], ["옵션B", "0", "4", ""]]);
    expect(rows[2].slice(0, 6)).toEqual(["", "", "", "", "", ""]);
    const again = await preview(s.ctx, r.value.csv);
    expect([again.productCount, again.errorTotal]).toEqual([1, 0]);
    await commit(s.ctx, again.jobId);
    const names = (await liveProducts(s.seller.id)).map((x) => x.name);
    expect(names).toEqual(['=위험, "이름"', '=위험, "이름"']);
  });

  it("내보내기는 로그 추적에 남고 다른 파트너스 상품은 섞이지 않으며 개인정보 열이 없다", async () => {
    const a = await shop();
    const b = await shop();
    await commit(b.ctx, (await preview(b.ctx, csv("남의 상품,1000,판매중,,,,기본,0,1,"))).jobId);
    await commit(a.ctx, (await preview(a.ctx, csv("내 상품,1000,판매중,,,,기본,0,1,"))).jobId);
    const r = await exportProductsCsv(db, a.ctx);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.csv).toContain("내 상품");
    expect(r.value.csv).not.toContain("남의 상품");
    expect(await db.auditLog.count({ where: { sellerId: a.seller.id, action: "bulk_io.product_export" } })).toBe(1);
    expect(await db.auditLog.count({ where: { sellerId: a.seller.id, action: "bulk_io.product_import" } })).toBe(1);
  });
});

describe("API 경로", () => {
  const H = { host: "localhost:3000", origin: "http://localhost:3000" };
  async function cookie(s: Awaited<ReturnType<typeof shop>>) {
    const r = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  }
  it("로그인 전에는 401, 양식·미리보기·상세는 로그인 뒤에만", async () => {
    const s = await shop();
    expect((await templateRoute(new Request("http://localhost:3000/x"))).status).toBe(401);
    expect((await previewRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ csv: csv("A,1,,,,,,,,") }) }))).status).toBe(401);
    expect((await exportRoute(new Request("http://localhost:3000/x"))).status).toBe(401);
    const c = await cookie(s);
    const t = await templateRoute(new Request("http://localhost:3000/x", { headers: { cookie: c } }));
    expect([t.status, t.headers.get("content-type")]).toEqual([200, "text/csv; charset=utf-8"]);
    const bytes = new Uint8Array(await t.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // 엑셀이 한글을 깨뜨리지 않게 BOM
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).slice(1).startsWith("상품명,판매가")).toBe(true);
    const pv = await previewRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie: c, "content-type": "text/csv" }, body: csv("A,1000,판매중,,,,기본,0,1,") }));
    expect(pv.status).toBe(201);
    const body = await pv.json();
    expect(body).toMatchObject({ totalRows: 1, productCount: 1 });
    const d = await jobRoute(new Request("http://localhost:3000/x", { headers: { cookie: c } }), { params: Promise.resolve({ jobId: body.jobId }) });
    expect(d.status).toBe(200);
    const bad = await previewRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie: c, "content-type": "application/json" }, body: JSON.stringify({ csv: "a,b\r\n1,2" }) }));
    expect([bad.status, (await bad.json()).message]).toEqual([400, BULK_MESSAGES.invalid_header]);
    const nf = await jobRoute(new Request("http://localhost:3000/x", { headers: { cookie: c } }), { params: Promise.resolve({ jobId: "nope" }) });
    expect(nf.status).toBe(404);
  });
});
