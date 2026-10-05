import type { Prisma, PrismaClient, ProductStatus, StockDeductMode } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { dbNow } from "../billing/subscription";
import { MAX_OPTIONS_PER_PRODUCT, PRODUCT_NAME_MAX, createProduct, deleteProduct, parseNewProduct, type ProductFailure } from "../products/manage";
import { MAX_CATEGORIES_PER_PRODUCT, listCategories, setProductCategories } from "../shop-category/service";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { formatCsv, guardText, parseCsv, unguardText } from "./csv";

// 엑셀(CSV) 일괄 등록·내보내기(SA-018, PRODUCT_MANAGE). 규칙:
// - 파일은 UTF-8 CSV(엑셀에서 「CSV UTF-8」로 저장). 열: 상품명·판매가·상태·설명·차감시점·카테고리·옵션명·옵션추가금·재고·SKU. 옵션마다 한 줄이고, 상품명을 비운 줄은 앞 상품의 옵션이다.
// - 흐름: 미리보기(검증만, DB 상품은 안 만듦, 1시간 안에 확정) → 확정(오류 상품은 건너뛰고 나머지만 등록) → 24시간 안에 되돌리기(등록한 상품을 삭제 처리, 주문이 이미 있는 상품은 남김).
// - 검증은 상품 등록과 같은 규칙(parseNewProduct)이고, 확정 때 다시 검증한다. 한 상품에 오류가 하나라도 있으면 그 상품의 모든 줄을 건너뛴다.
// - 모든 조회·쓰기는 sellerId로 묶는다. 내보내기는 상품 정보만이라 개인정보가 없다(주문·회원 내보내기는 이 작업에 없음).

export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_CHARS = 1_000_000;
export const PREVIEW_VALID_MS = 3600_000;
export const UNDO_WINDOW_MS = 24 * 3600_000;
export const MAX_EXPORT_PRODUCTS = 5000;
const MAX_STORED_ERRORS = 500;
const SHOWN_ERRORS = 100;
const SHOWN_PRODUCTS = 20;

export const COLUMNS = ["상품명", "판매가", "상태", "설명", "차감시점", "카테고리", "옵션명", "옵션추가금", "재고", "SKU"] as const;
type Column = (typeof COLUMNS)[number];

const STATUS_BY_LABEL: Record<string, ProductStatus> = { 판매중: "ON_SALE", 품절: "SOLD_OUT", 준비중: "DRAFT", 숨김: "HIDDEN" };
const LABEL_BY_STATUS: Record<ProductStatus, string> = { ON_SALE: "판매중", SOLD_OUT: "품절", DRAFT: "준비중", HIDDEN: "숨김" };
const DEDUCT_BY_LABEL: Record<string, StockDeductMode> = { "결제 시": "PAYMENT", "주문 시": "ORDER" };
const LABEL_BY_DEDUCT: Record<StockDeductMode, string> = { PAYMENT: "결제 시", ORDER: "주문 시" };

// 화면 문구(파트너스 관리자: 합니다체)
export const BULK_MESSAGES = {
  file_too_large: "파일이 너무 큽니다. 1MB 이하로 나누어 올려 주십시오",
  invalid_csv: "파일을 읽을 수 없습니다. 엑셀에서 「CSV UTF-8」로 저장했는지 확인해 주십시오",
  invalid_header: "첫 줄의 열 이름이 양식과 다릅니다. 양식을 다시 내려받아 사용해 주십시오",
  too_many_rows: `한 번에 ${MAX_IMPORT_ROWS}줄까지 올릴 수 있습니다. 나누어 올려 주십시오`,
  empty_file: "등록할 줄이 없습니다",
  job_not_found: "작업을 찾을 수 없습니다",
  nothing_to_import: "등록할 수 있는 상품이 없습니다. 오류를 고쳐 다시 올려 주십시오",
  preview_expired: "미리보기가 만료되었습니다. 파일을 다시 올려 주십시오",
  job_busy: "등록이 진행 중입니다. 잠시 뒤 결과를 확인해 주십시오",
  job_not_committable: "이미 처리한 작업입니다",
  not_undoable: "등록을 완료한 작업만 되돌릴 수 있습니다",
  undo_expired: "되돌릴 수 있는 24시간이 지났습니다",
  too_many_products: `상품이 ${MAX_EXPORT_PRODUCTS}개를 넘어 한 번에 내보낼 수 없습니다`,
} as const;
export type BulkFailure = keyof typeof BULK_MESSAGES;
export const bulkErrorBody = (reason: BulkFailure) => ({ error: reason, message: BULK_MESSAGES[reason] });
export const bulkFailureStatus = (reason: BulkFailure) =>
  reason === "job_not_found"
    ? 404
    : reason === "file_too_large"
      ? 413
      : reason === "invalid_csv" || reason === "invalid_header" || reason === "too_many_rows" || reason === "empty_file"
        ? 400
        : 409;

const PRODUCT_FAILURE_MESSAGES: Record<ProductFailure, string> = {
  invalid_product: "상품명·상태·설명·차감시점을 확인해 주십시오",
  product_name_too_long: `상품명은 ${PRODUCT_NAME_MAX}자까지 입력할 수 있습니다`,
  invalid_option: "옵션명·옵션추가금·재고·SKU를 확인해 주십시오",
  invalid_price: "판매가는 1원 이상이어야 하고, 옵션추가금을 더한 값도 1원 이상이어야 합니다",
  too_many_options: `옵션은 상품마다 ${MAX_OPTIONS_PER_PRODUCT}개까지 등록할 수 있습니다`,
  no_sellable_option: "판매중 상품에는 옵션이 한 개 이상 필요합니다",
  stock_conflict: "재고가 바뀌어 등록하지 못했습니다",
  price_conflict: "판매가가 바뀌어 등록하지 못했습니다",
  status_conflict: "판매 상태가 바뀌어 등록하지 못했습니다",
  event_price_too_low: "가격을 확인해 주십시오",
};

export type RowError = { row: number; column: Column | null; message: string };
type ImportProduct = { row: number; input: Record<string, unknown>; categoryIds: string[]; categories: string[] };
type Result<T> = { ok: true; value: T } | { ok: false; reason: BulkFailure };

export function templateCsv(): string {
  return formatCsv([
    [...COLUMNS],
    ["부스터 팩", "5000", "판매중", "신상 부스터 팩입니다", "결제 시", "카드>부스터", "기본", "0", "30", "BP-001"],
    ["슬리브 세트", "3000", "판매중", "", "결제 시", "", "검정", "0", "10", "SL-B"],
    ["", "", "", "", "", "", "흰색", "500", "5", "SL-W"],
  ]);
}

// 카테고리 이름 → id. 「상위>하위」 또는 「상위」, 여러 개는 「|」로 잇는다. 같은 이름이 여럿이면 어느 것인지 알 수 없어 오류.
function categoryIndex(tree: Awaited<ReturnType<typeof listCategories>>) {
  const map = new Map<string, string[]>();
  const add = (k: string, id: string) => map.set(k, [...(map.get(k) ?? []), id]);
  for (const c of tree) {
    add(c.name, c.id);
    for (const ch of c.children) add(`${c.name}>${ch.name}`, ch.id);
  }
  return map;
}

const intCell = (raw: string, money: boolean): number | null => {
  const s = (money ? raw.replace(/[,\s]|원$/g, "") : raw.replace(/\s/g, "")).trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

export function parseProductCsv(
  text: string,
  categories: Map<string, string[]>,
): Result<{ totalRows: number; products: ImportProduct[]; errors: RowError[]; skippedProducts: number }> {
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, reason: "file_too_large" };
  const csv = parseCsv(text);
  if (!csv.ok) return { ok: false, reason: "invalid_csv" };
  const [head, ...body] = csv.rows;
  if (!head) return { ok: false, reason: "invalid_header" };
  const names = head.map((h) => h.trim());
  const index = new Map<string, number>();
  for (const [i, n] of names.entries()) {
    if (!(COLUMNS as readonly string[]).includes(n) || index.has(n)) return { ok: false, reason: "invalid_header" };
    index.set(n, i);
  }
  if (!index.has("상품명") || !index.has("판매가")) return { ok: false, reason: "invalid_header" };
  const data = body.map((cells, i) => ({ line: i + 2, cells })).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (data.length === 0) return { ok: false, reason: "empty_file" };
  if (data.length > MAX_IMPORT_ROWS) return { ok: false, reason: "too_many_rows" };

  const get = (cells: string[], col: Column) => {
    const i = index.get(col);
    return i === undefined ? "" : (cells[i] ?? "").trim();
  };
  type Group = { line: number; rows: { line: number; cells: string[] }[] };
  const groups: Group[] = [];
  const errors: RowError[] = [];
  const bad = new Set<Group | "orphan">();
  for (const r of data) {
    if (get(r.cells, "상품명") !== "") groups.push({ line: r.line, rows: [r] });
    else if (groups.length > 0) groups[groups.length - 1].rows.push(r);
    else {
      errors.push({ row: r.line, column: "상품명", message: "상품명이 필요합니다. 옵션만 있는 줄은 상품 줄 아래에 두십시오" });
      bad.add("orphan");
    }
  }

  const products: ImportProduct[] = [];
  let skipped = 0;
  for (const g of groups) {
    const errs: RowError[] = [];
    const err = (row: number, column: Column | null, message: string) => errs.push({ row, column, message });
    const first = g.rows[0].cells;
    const unit = (col: Column) => unguardText(get(first, col));
    const price = intCell(get(first, "판매가"), true);
    if (price === null) err(g.line, "판매가", "판매가는 숫자로 입력해 주십시오");
    const statusLabel = get(first, "상태");
    const status = statusLabel === "" ? "DRAFT" : STATUS_BY_LABEL[statusLabel];
    if (!status) err(g.line, "상태", "상태는 판매중·품절·준비중·숨김 중에서 입력해 주십시오");
    const deductLabel = get(first, "차감시점");
    const deduct = deductLabel === "" ? "PAYMENT" : DEDUCT_BY_LABEL[deductLabel];
    if (!deduct) err(g.line, "차감시점", "차감시점은 결제 시·주문 시 중에서 입력해 주십시오");

    const categoryIds: string[] = [];
    const categoryNames: string[] = [];
    for (const raw of get(first, "카테고리").split("|").map((c) => c.replace(/\s*>\s*/g, ">").trim()).filter(Boolean)) {
      const ids = categories.get(raw);
      if (!ids) err(g.line, "카테고리", `카테고리 「${raw}」를 찾을 수 없습니다`);
      else if (ids.length > 1) err(g.line, "카테고리", `카테고리 「${raw}」와 같은 이름이 여러 개입니다`);
      else if (!categoryIds.includes(ids[0])) {
        categoryIds.push(ids[0]);
        categoryNames.push(raw);
      }
    }
    if (categoryIds.length > MAX_CATEGORIES_PER_PRODUCT) err(g.line, "카테고리", `카테고리는 상품마다 ${MAX_CATEGORIES_PER_PRODUCT}개까지 지정할 수 있습니다`);

    const options: { name: string; priceDelta: number; stock: number; sku: string | null }[] = [];
    for (const [k, r] of g.rows.entries()) {
      if (k > 0) {
        for (const col of ["판매가", "상태", "설명", "차감시점", "카테고리"] as const) {
          const same = get(r.cells, col) === get(first, col);
          if (get(r.cells, col) !== "" && !same) err(r.line, col, "옵션 줄에는 상품 정보를 비워 두십시오");
        }
      }
      const optName = unguardText(get(r.cells, "옵션명"));
      const delta = get(r.cells, "옵션추가금");
      const stock = get(r.cells, "재고");
      const sku = unguardText(get(r.cells, "SKU"));
      if (optName === "") {
        if (delta !== "" || stock !== "" || sku !== "") err(r.line, "옵션명", "옵션명이 필요합니다");
        continue;
      }
      const d = delta === "" ? 0 : intCell(delta, true);
      const s = stock === "" ? 0 : intCell(stock, true);
      if (d === null) err(r.line, "옵션추가금", "옵션추가금은 숫자로 입력해 주십시오");
      if (s === null || s < 0) err(r.line, "재고", "재고는 0 이상의 숫자로 입력해 주십시오");
      if (options.some((o) => o.name === optName)) err(r.line, "옵션명", `옵션명 「${optName}」가 같은 상품에 두 번 있습니다`);
      if (d !== null && s !== null && s >= 0) options.push({ name: optName, priceDelta: d, stock: s, sku: sku === "" ? null : sku });
    }

    const input = { name: unit("상품명"), description: unit("설명"), price, status, stockDeductMode: deduct, options };
    if (errs.length === 0) {
      const parsed = parseNewProduct(input);
      if (!parsed.ok) err(g.line, null, PRODUCT_FAILURE_MESSAGES[parsed.reason]);
    }
    if (errs.length > 0) {
      errors.push(...errs);
      bad.add(g);
      skipped++;
    } else products.push({ row: g.line, input, categoryIds, categories: categoryNames });
  }
  errors.sort((a, b) => a.row - b.row);
  return { ok: true, value: { totalRows: data.length, products, errors, skippedProducts: skipped + (bad.has("orphan") ? 1 : 0) } };
}

const asErrors = (v: Prisma.JsonValue): { total: number; items: RowError[] } =>
  v && typeof v === "object" && !Array.isArray(v) && "items" in v ? (v as unknown as { total: number; items: RowError[] }) : { total: 0, items: [] };
const asArray = <T>(v: Prisma.JsonValue): T[] => (Array.isArray(v) ? (v as T[]) : []);

type Failure = { row: number; name: string; message: string };

// 미리보기: 검증만 하고 작업 기록을 남긴다. 응답 { jobId, totalRows, productCount, skippedProductCount, errorTotal, errors: [{ row, column, message }](100개까지), products: [{ row, name, price, status, optionCount, categories }](20개까지) }
export async function previewProductImport(db: PrismaClient, ctx: TenantContext, raw: { csv: unknown; fileName?: unknown }): Promise<Result<unknown>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (typeof raw.csv !== "string") return { ok: false, reason: "invalid_csv" };
  const parsed = parseProductCsv(raw.csv, categoryIndex(await listCategories(db, ctx)));
  if (!parsed.ok) return parsed;
  const { totalRows, products, errors, skippedProducts } = parsed.value;
  const fileName = typeof raw.fileName === "string" && raw.fileName.trim() ? raw.fileName.trim().slice(0, 100) : null;
  const job = await db.bulkJob.create({
    data: {
      sellerId: ctx.sellerId,
      kind: "PRODUCT_IMPORT",
      fileName,
      totalRows,
      productCount: products.length,
      errors: { total: errors.length, skippedProducts, items: errors.slice(0, MAX_STORED_ERRORS) } as unknown as Prisma.InputJsonValue,
      payload: products as unknown as Prisma.InputJsonValue,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
    },
  });
  return {
    ok: true,
    value: {
      jobId: job.id,
      totalRows,
      productCount: products.length,
      skippedProductCount: skippedProducts,
      errorTotal: errors.length,
      errors: errors.slice(0, SHOWN_ERRORS),
      products: products.slice(0, SHOWN_PRODUCTS).map((p) => ({
        row: p.row,
        name: p.input.name,
        price: p.input.price,
        status: p.input.status,
        optionCount: (p.input.options as unknown[]).length,
        categories: p.categories,
      })),
    },
  };
}

// 확정: 미리보기를 통과한 상품만 등록한다. 같은 작업을 다시 확정하면 처음 결과를 그대로 돌려준다(두 번 만들지 않는다).
// 응답 { jobId, status, createdCount, failedCount, failures: [{ row, name, message }], undoUntil }
export async function commitProductImport(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<Result<unknown>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const found = await db.bulkJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId } });
  if (!found) return { ok: false, reason: "job_not_found" };
  if (found.status === "COMMITTED") return { ok: true, value: commitView(found) };
  if (found.status === "COMMITTING") return { ok: false, reason: "job_busy" };
  if (found.status !== "PREVIEW") return { ok: false, reason: "job_not_committable" };
  if (found.productCount === 0) return { ok: false, reason: "nothing_to_import" };
  const now = await dbNow(db);
  if (now.getTime() - found.createdAt.getTime() > PREVIEW_VALID_MS) return { ok: false, reason: "preview_expired" };
  // 한 번에 하나만 확정한다(조건부 UPDATE)
  const claimed = await db.bulkJob.updateMany({ where: { id: jobId, sellerId: ctx.sellerId, status: "PREVIEW" }, data: { status: "COMMITTING", committingAt: now } });
  if (claimed.count !== 1) return { ok: false, reason: "job_busy" };

  const products = asArray<ImportProduct>(found.payload);
  const created: string[] = [];
  const failures: Failure[] = [];
  for (const p of products) {
    const name = String(p.input.name ?? "");
    const r = await createProduct(db, ctx, p.input);
    if (!r.ok) {
      failures.push({ row: p.row, name, message: PRODUCT_FAILURE_MESSAGES[r.reason] });
      continue;
    }
    created.push(r.value.id);
    // 되돌리기 대상은 만들자마자 기록해 둔다(중간에 끊겨도 지울 수 있게)
    await db.bulkJob.update({ where: { id: jobId }, data: { createdProductIds: created } });
    if (p.categoryIds.length > 0) {
      const c = await setProductCategories(db, ctx, r.value.id, { categoryIds: p.categoryIds });
      if (!c.ok) failures.push({ row: p.row, name, message: "상품은 등록했지만 카테고리를 지정하지 못했습니다. 상품에서 직접 지정해 주십시오" });
    }
  }
  const doneAt = await dbNow(db);
  const done = await db.bulkJob.update({
    where: { id: jobId },
    data: { status: "COMMITTED", committedAt: doneAt, undoUntil: new Date(doneAt.getTime() + UNDO_WINDOW_MS), createdProductIds: created, failures },
  });
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "bulk_io.product_import",
    targetType: "BulkJob",
    targetId: jobId,
    after: { created: created.length, failed: failures.length },
  });
  return { ok: true, value: commitView(done) };
}

function commitView(j: { id: string; status: string; createdProductIds: Prisma.JsonValue; failures: Prisma.JsonValue; undoUntil: Date | null }) {
  const failures = asArray<Failure>(j.failures);
  return { jobId: j.id, status: j.status, createdCount: asArray<string>(j.createdProductIds).length, failedCount: failures.length, failures, undoUntil: j.undoUntil };
}

// 되돌리기: 확정 뒤 24시간 안에 등록한 상품을 삭제 처리한다. 주문이 한 번이라도 들어온 상품은 남기고 알려 준다. 응답 { removedCount, keptCount, kept: [{ productId, name }] }
export async function undoProductImport(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<Result<unknown>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const found = await db.bulkJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId } });
  if (!found) return { ok: false, reason: "job_not_found" };
  if (found.status !== "COMMITTED") return { ok: false, reason: "not_undoable" };
  const now = await dbNow(db);
  if (!found.undoUntil || now.getTime() > found.undoUntil.getTime()) return { ok: false, reason: "undo_expired" };
  // 한 번만 되돌린다(조건부 UPDATE)
  const claimed = await db.bulkJob.updateMany({ where: { id: jobId, sellerId: ctx.sellerId, status: "COMMITTED" }, data: { status: "UNDONE", undoneAt: now } });
  if (claimed.count !== 1) return { ok: false, reason: "not_undoable" };

  const ids = asArray<string>(found.createdProductIds);
  const ordered = new Set((await db.orderItem.findMany({ where: { sellerId: ctx.sellerId, productId: { in: ids } }, select: { productId: true }, distinct: ["productId"] })).map((r) => r.productId));
  const live = await db.product.findMany({ where: { sellerId: ctx.sellerId, id: { in: ids }, deletedAt: null }, select: { id: true, name: true } });
  const kept: { productId: string; name: string }[] = [];
  let removed = 0;
  for (const p of live) {
    if (ordered.has(p.id)) kept.push({ productId: p.id, name: p.name });
    else {
      await deleteProduct(db, ctx, p.id);
      removed++;
    }
  }
  await db.bulkJob.update({ where: { id: jobId }, data: { keptCount: kept.length } });
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "bulk_io.product_import_undo",
    targetType: "BulkJob",
    targetId: jobId,
    after: { removed, kept: kept.length },
  });
  return { ok: true, value: { removedCount: removed, keptCount: kept.length, kept } };
}

const jobSummary = (j: Awaited<ReturnType<typeof listRaw>>[number], now: Date) => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  fileName: j.fileName,
  totalRows: j.totalRows,
  productCount: j.productCount,
  createdCount: asArray<string>(j.createdProductIds).length,
  failedCount: asArray<Failure>(j.failures).length,
  errorTotal: asErrors(j.errors).total,
  keptCount: j.keptCount,
  createdAt: j.createdAt,
  committedAt: j.committedAt,
  undoUntil: j.undoUntil,
  undoneAt: j.undoneAt,
  undoable: j.status === "COMMITTED" && !!j.undoUntil && j.undoUntil.getTime() >= now.getTime(),
});
const listRaw = (db: PrismaClient, sellerId: string, id?: string) =>
  db.bulkJob.findMany({ where: { sellerId, ...(id ? { id } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: id ? 1 : 30 });

// 작업 목록(최근 30개). 응답 { jobs: [{ id, status, fileName, totalRows, productCount, createdCount, failedCount, errorTotal, keptCount, createdAt, committedAt, undoUntil, undoable }] }
export async function listBulkJobs(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const now = await dbNow(db);
  return { jobs: (await listRaw(db, ctx.sellerId)).map((j) => jobSummary(j, now)) };
}

// 작업 상세: 목록 항목 + 오류 목록(500개까지)과 확정 때 못 만든 상품.
export async function getBulkJob(db: PrismaClient, ctx: TenantContext, jobId: string) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw notFound();
  const [j] = await listRaw(db, ctx.sellerId, jobId);
  if (!j) throw notFound();
  return { ...jobSummary(j, await dbNow(db)), errors: asErrors(j.errors).items, failures: asArray<Failure>(j.failures) };
}

// 상품 내보내기: 양식과 같은 열이라 고쳐서 다시 올리는 데 쓸 수 있다(올리면 새 상품으로 등록된다). 지운 상품은 뺀다. 개인정보 없음.
export async function exportProductsCsv(db: PrismaClient, ctx: TenantContext): Promise<Result<{ csv: string; count: number }>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const count = await db.product.count({ where: { sellerId: ctx.sellerId, deletedAt: null } });
  if (count > MAX_EXPORT_PRODUCTS) return { ok: false, reason: "too_many_products" };
  const tree = await listCategories(db, ctx);
  const path = new Map<string, string>();
  for (const c of tree) {
    path.set(c.id, c.name);
    for (const ch of c.children) path.set(ch.id, `${c.name}>${ch.name}`);
  }
  const products = await db.product.findMany({
    where: { sellerId: ctx.sellerId, deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "asc" }],
    select: {
      name: true,
      description: true,
      price: true,
      status: true,
      stockDeductMode: true,
      categories: { select: { categoryId: true } },
      options: { where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { name: true, priceDelta: true, stock: true, sku: true } },
    },
  });
  const rows: string[][] = [[...COLUMNS]];
  for (const p of products) {
    const cats = p.categories.map((c) => path.get(c.categoryId)).filter((v): v is string => !!v).join("|");
    const optRows = p.options.length > 0 ? p.options : [null];
    optRows.forEach((o, i) => {
      const head = i === 0 ? [guardText(p.name), String(p.price), LABEL_BY_STATUS[p.status], guardText(p.description ?? ""), LABEL_BY_DEDUCT[p.stockDeductMode], guardText(cats)] : ["", "", "", "", "", ""];
      rows.push([...head, o ? guardText(o.name) : "", o ? String(o.priceDelta) : "", o ? String(o.stock) : "", o?.sku ? guardText(o.sku) : ""]);
    });
  }
  await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "bulk_io.product_export", targetType: "Product", after: { count: products.length } });
  return { ok: true, value: { csv: formatCsv(rows), count: products.length } };
}
