import type { Prisma, PrismaClient, ProductStatus, StockDeductMode } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { AuthError, notFound } from "../authz/errors";
import { dbNow } from "../billing/subscription";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../orders/messages";
import { MAX_OPTIONS_PER_PRODUCT, PRODUCT_NAME_MAX, STOCK_NOTES, createProduct, deleteProduct, parseNewProduct, updateProduct, type ProductFailure } from "../products/manage";
import { MAX_EVENT_RATE, discountedUnit, eventFits, eventOf, parseEvent, setProductEvent } from "../products/event";
import { adjustStock } from "../products/stock";
import { MAX_CATEGORIES_PER_PRODUCT, listCategories, setProductCategories } from "../shop-category/service";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { formatCsv, guardText as guardCsv, parseCsv, unguardText } from "./csv";
import { recordExport } from "./exports";
import { XLSX_MAX_BYTES, readXlsx, writeXlsx } from "./xlsx";

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

// 올릴 때 받는 열: 기존 10열 + 정본의 할인가·할인 기간·숨김. 「구매 제한」은 상품 필드가 없어 받지 않는다(별도 항목).
export const COLUMNS = ["상품명", "판매가", "상태", "설명", "차감시점", "카테고리", "옵션명", "옵션추가금", "재고", "SKU", "할인가", "할인 기간", "숨김"] as const;
// 내려받는 양식·내보내기 열(정본 SA-018 「양식 안내」): 필수 4열 + 선택 열. 올릴 때는 이 열도, 기존 10열도 읽는다.
export const TEMPLATE_COLUMNS = ["상품명", "카테고리", "판매가", "재고", "옵션", "할인가", "할인 기간", "설명", "숨김"] as const;
type Column = (typeof COLUMNS)[number];

const STATUS_BY_LABEL: Record<string, ProductStatus> = { 판매중: "ON_SALE", 품절: "SOLD_OUT", 준비중: "DRAFT", 숨김: "HIDDEN" };
const DEDUCT_BY_LABEL: Record<string, StockDeductMode> = { "결제 시": "PAYMENT", "주문 시": "ORDER" };

// 화면 문구(파트너스 관리자: 합니다체)
export const BULK_MESSAGES = {
  file_too_large: "파일이 너무 큽니다. 1MB 이하로 나누어 올려 주십시오",
  xlsx_too_large: "파일이 너무 큽니다. 5MB 이하로 나누어 올려 주십시오",
  invalid_xlsx: "엑셀 파일을 읽을 수 없습니다. .xlsx 형식의 파일인지 확인해 주십시오",
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
// 양식과 열 이름이 다를 때의 안내(정본 SA-018): 「가격」 열을 「판매가」로 바꿔 주십시오 (2개 열 불일치)
const ro = (w: string) => {
  const c = w.charCodeAt(w.length - 1) - 0xac00;
  return c >= 0 && c < 11172 && (c % 28 === 0 || c % 28 === 8) ? "로" : "으로";
};
export function headerMismatchMessage(columns: ColumnMismatch[]): string {
  const swap = columns.find((c) => c.found && c.expected);
  const unknown = columns.find((c) => c.found && !c.expected);
  const missing = columns.find((c) => !c.found && c.expected);
  const lead = swap
    ? `「${swap.found}」 열을 「${swap.expected}」${ro(swap.expected!)} 바꿔 주십시오`
    : unknown
      ? `「${unknown.found}」 열은 양식에 없습니다. 지우거나 양식의 열 이름으로 바꿔 주십시오`
      : missing
        ? `「${missing.expected}」 열이 없습니다. 양식의 열을 추가해 주십시오`
        : "양식을 다시 내려받아 사용해 주십시오";
  return `양식과 열 이름이 다릅니다 · ${lead} (${columns.length}개 열 불일치)`;
}
export const bulkFailureBody = (r: { reason: BulkFailure; columns?: ColumnMismatch[] }) =>
  r.reason === "invalid_header" && r.columns && r.columns.length > 0
    ? { error: r.reason, message: headerMismatchMessage(r.columns), columns: r.columns }
    : bulkErrorBody(r.reason);
export const bulkFailureStatus = (reason: BulkFailure) =>
  reason === "job_not_found"
    ? 404
    : reason === "file_too_large" || reason === "xlsx_too_large"
      ? 413
      : reason === "invalid_csv" || reason === "invalid_xlsx" || reason === "invalid_header" || reason === "too_many_rows" || reason === "empty_file"
        ? 400
        : 409;

const PRODUCT_FAILURE_MESSAGES: Record<ProductFailure, string> = {
  invalid_event: ORDER_ERROR_MESSAGES_FORMAL.invalid_event,
  invalid_event_period: ORDER_ERROR_MESSAGES_FORMAL.invalid_event_period,
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
// optionMeta: input.options와 같은 순서의 줄 번호·재고 칸 입력 여부(비어 있으면 기존 상품 수정 때 재고를 바꾸지 않는다).
// update: 상품명이 기존 상품과 같을 때만 있다(미리보기에서 채움). 그때는 판매가와 옵션 재고만 바꾸고 나머지 칸은 쓰지 않는다.
type StockChange = { optionId: string; name: string; before: number; target: number };
type ImportProduct = {
  row: number;
  input: Record<string, unknown>;
  categoryIds: string[];
  categories: string[];
  optionMeta?: { line: number; hasStock: boolean }[];
  // 파일에 적힌 할인가·할인 기간(검사 전). 새 상품으로 확인된 줄만 resolveProductEvents가 검사해 event로 바꾼다.
  eventRaw?: { discount: string; period: string; line: number };
  // 새 상품의 할인(할인가 − 판매가를 정액 할인으로, 기간은 KST 날짜 기준). 기존 상품 수정에는 쓰지 않는다.
  event?: { type: "AMOUNT"; value: number; startsAt: string; endsAt: string };
  defaultOption?: boolean;
  update?: { productId: string; currentPrice: number; stock: StockChange[] };
};
type UpdateRecord = { productId: string; name: string; price: { before: number; after: number } | null; stock: { optionId: string; name: string; delta: number }[] };
// invalid_header일 때 어느 열이 양식과 다른지(columns)도 함께 준다.
export type ColumnMismatch = { found: string | null; expected: string | null };
type Result<T> = { ok: true; value: T } | { ok: false; reason: BulkFailure; columns?: ColumnMismatch[] };

const KST_MS = 9 * 3600_000;
const pad2 = (n: number) => String(n).padStart(2, "0");
const kstDay = (d: Date) => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
// 양식의 예시 줄(할인 기간은 오늘부터 일주일). 「숨김」은 새 상품이 항상 숨김으로 등록된다는 뜻의 예시다.
const templateRows = (now = new Date()): string[][] => [
  [...TEMPLATE_COLUMNS],
  ["부스터 팩", "카드>부스터", "5000", "30", "기본", "4500", `${kstDay(now)} ~ ${kstDay(new Date(now.getTime() + 6 * 86_400_000))}`, "신상 부스터 팩입니다", "예"],
  ["슬리브 세트", "", "3000", "10", "검정", "", "", "", "예"],
  ["", "", "", "5", "흰색", "", "", "", ""],
];
const REQUIRED_COLUMNS = ["상품명", "카테고리", "판매가", "재고"] as const;
// 자주 틀리는 열 이름 → 바른 이름(안내용). 올린 파일의 열 이름으로 찾으므로 자기 속성만 본다(constructor 같은 이름이 상속 값을 돌려주지 않게).
const HEADER_SUGGESTIONS: Record<string, string> = {
  가격: "판매가",
  "판매 가격": "판매가",
  판매가격: "판매가",
  "상품 이름": "상품명",
  상품이름: "상품명",
  이름: "상품명",
  품명: "상품명",
  수량: "재고",
  재고수량: "재고",
  "재고 수량": "재고",
  분류: "카테고리",
  "옵션 이름": "옵션명",
  옵션이름: "옵션명",
  추가금: "옵션추가금",
  "옵션 추가금": "옵션추가금",
  "상품 설명": "설명",
  상품설명: "설명",
  "판매 상태": "상태",
};
export const templateCsv = (): string => formatCsv(templateRows());
export const templateXlsx = (): Buffer => writeXlsx(templateRows(), "상품 일괄 등록");

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

// 「2026-10-20 ~ 2026-10-27」(구분은 - . /). 시작일 0시부터 종료일 끝(다음 날 0시, KST)까지.
function parsePeriod(raw: string): { startsAt: string; endsAt: string } | null {
  const m = /^(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})\s*~\s*(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})$/.exec(raw.trim());
  if (!m) return null;
  const [y1, m1, d1, y2, m2, d2] = m.slice(1).map(Number);
  const real = (y: number, mo: number, d: number) => {
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  };
  if (!real(y1, m1, d1) || !real(y2, m2, d2)) return null;
  const start = Date.UTC(y1, m1 - 1, d1);
  const endDay = Date.UTC(y2, m2 - 1, d2);
  if (endDay < start) return null;
  const next = new Date(endDay + 86_400_000);
  return { startsAt: `${y1}-${pad2(m1)}-${pad2(d1)}T00:00:00+09:00`, endsAt: `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}T00:00:00+09:00` };
}

export type Parsed = { totalRows: number; products: ImportProduct[]; errors: RowError[]; skippedProducts: number };

export function parseProductCsv(text: string, categories: Map<string, string[]>): Result<Parsed> {
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, reason: "file_too_large" };
  const csv = parseCsv(text);
  if (!csv.ok) return { ok: false, reason: "invalid_csv" };
  return parseProductRows(csv.rows, categories);
}

// 파일 형식(CSV·엑셀)과 상관없는 검증. rows[0]이 열 이름, 이후 줄 번호는 위치 + 1(엑셀 화면의 행 번호).
export function parseProductRows(rows: string[][], categories: Map<string, string[]>): Result<Parsed> {
  const [head, ...body] = rows;
  if (!head) return { ok: false, reason: "invalid_header" };
  const names = head.map((h) => h.trim());
  const index = new Map<string, number>();
  const columns: ColumnMismatch[] = [];
  for (const [i, n] of names.entries()) {
    const column = n === "옵션" ? "옵션명" : n;
    if (!(COLUMNS as readonly string[]).includes(column)) columns.push({ found: n, expected: Object.hasOwn(HEADER_SUGGESTIONS, n) ? HEADER_SUGGESTIONS[n] : null });
    else if (index.has(column)) columns.push({ found: n, expected: null });
    else index.set(column, i);
  }
  // 다른 이름으로 쓴 열(예: 가격)이 이미 짚였으면 빠진 필수 열(판매가)을 따로 세지 않는다.
  for (const r of REQUIRED_COLUMNS) if (!index.has(r) && !columns.some((c) => c.expected === r)) columns.push({ found: null, expected: r });
  if (columns.length > 0) return { ok: false, reason: "invalid_header", columns };
  const hasOptionColumn = index.has("옵션명");
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
    // 신규 상품은 빈 상태를 숨김으로 준비한다. 기존 상품은 분류 뒤 가격·재고만 반영한다.
    const status = statusLabel === "" ? "HIDDEN" : STATUS_BY_LABEL[statusLabel];
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
    const optionMeta: { line: number; hasStock: boolean }[] = [];
    for (const [k, r] of g.rows.entries()) {
      if (k > 0) {
        for (const col of ["판매가", "상태", "설명", "차감시점", "카테고리", "할인가", "할인 기간", "숨김"] as const) {
          const same = get(r.cells, col) === get(first, col);
          if (get(r.cells, col) !== "" && !same) err(r.line, col, "옵션 줄에는 상품 정보를 비워 두십시오");
        }
      }
      const optName = hasOptionColumn ? unguardText(get(r.cells, "옵션명")) : k === 0 ? "기본" : "";
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
      if (d !== null && s !== null && s >= 0) {
        options.push({ name: optName, priceDelta: d, stock: s, sku: sku === "" ? null : sku });
        optionMeta.push({ line: r.line, hasStock: stock !== "" });
      }
    }

    // 할인가·할인 기간은 새 상품일 때만 쓰므로 여기서는 입력만 담아 두고, 기존 상품과 맞춰 본 뒤(classifyProducts) 새 상품에만 검사한다
    // (기존 상품은 이 열이 어떤 값이어도 무시한다 — 내보낸 파일을 다시 올려도 판매가·재고 수정이 막히지 않게).
    const discountRaw = get(first, "할인가");
    const periodRaw = get(first, "할인 기간");
    const eventRaw = discountRaw !== "" || periodRaw !== "" ? { discount: discountRaw, period: periodRaw, line: g.line } : undefined;

    const input = { name: unit("상품명"), description: unit("설명"), price, status, stockDeductMode: deduct, options };
    if (errs.length === 0) {
      const parsed = parseNewProduct(input);
      if (!parsed.ok) err(g.line, null, PRODUCT_FAILURE_MESSAGES[parsed.reason]);
    }
    if (errs.length > 0) {
      errors.push(...errs);
      bad.add(g);
      skipped++;
    } else products.push({ row: g.line, input, categoryIds, categories: categoryNames, optionMeta, defaultOption: !hasOptionColumn, ...(eventRaw ? { eventRaw } : {}) });
  }
  errors.sort((a, b) => a.row - b.row);
  return { ok: true, value: { totalRows: data.length, products, errors, skippedProducts: skipped + (bad.has("orphan") ? 1 : 0) } };
}

const asErrors = (v: Prisma.JsonValue): { total: number; items: RowError[] } =>
  v && typeof v === "object" && !Array.isArray(v) && "items" in v ? (v as unknown as { total: number; items: RowError[] }) : { total: 0, items: [] };
const asArray = <T>(v: Prisma.JsonValue): T[] => (Array.isArray(v) ? (v as T[]) : []);

type Failure = { row: number; name: string; message: string };

// 미리보기: 검증만 하고 작업 기록을 남긴다. 응답 { jobId, totalRows, productCount(등록+수정), createCount(새로 등록), updateCount(기존 상품 수정), skippedProductCount, errorTotal, errors: [{ row, column, message }](100개까지), products: [{ row, name, price, status, optionCount, categories, mode("create"|"update"), currentPrice(수정이면 지금 판매가), stockChangeCount(수정이면 재고가 바뀌는 옵션 수) }](20개까지) }
export async function previewProductImport(db: PrismaClient, ctx: TenantContext, raw: { csv: unknown; fileName?: unknown }): Promise<Result<unknown>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (typeof raw.csv !== "string") return { ok: false, reason: "invalid_csv" };
  return createPreview(db, ctx, parseProductCsv(raw.csv, categoryIndex(await listCategories(db, ctx))), raw.fileName);
}

// 엑셀(.xlsx, 5MB까지) 미리보기. 첫 시트의 첫 줄이 열 이름이고, 검증·응답은 CSV와 같다(parseProductRows).
export async function previewProductImportXlsx(db: PrismaClient, ctx: TenantContext, raw: { bytes: Buffer; fileName?: unknown }): Promise<Result<unknown>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (raw.bytes.length > XLSX_MAX_BYTES) return { ok: false, reason: "xlsx_too_large" };
  const sheet = readXlsx(raw.bytes);
  if (!sheet.ok) return { ok: false, reason: sheet.reason === "too_many_rows" ? "too_many_rows" : sheet.reason };
  return createPreview(db, ctx, parseProductRows(sheet.rows, categoryIndex(await listCategories(db, ctx))), raw.fileName);
}

// 상품명이 기존(삭제 안 한) 상품과 같으면 「기존 상품 수정」으로 바꾼다: 판매가와 옵션 재고만 수정하고 나머지 칸은 쓰지 않는다.
// 옵션은 옵션명으로 찾고(없으면 그 줄 오류), 재고 칸을 비운 옵션은 그대로 둔다. 같은 이름 상품이 여럿이거나 파일에 같은 상품이 두 번 있으면 오류.
async function classifyProducts(db: PrismaClient, ctx: TenantContext, parsed: Parsed): Promise<Parsed> {
  if (parsed.products.length === 0) return parsed;
  const names = [...new Set(parsed.products.map((p) => String(p.input.name)))];
  const existing = await db.product.findMany({
    where: { sellerId: ctx.sellerId, deletedAt: null, name: { in: names } },
    select: { id: true, name: true, price: true, options: { where: { deletedAt: null }, select: { id: true, name: true, stock: true } } },
  });
  const byName = new Map<string, typeof existing>();
  for (const e of existing) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  const errors = [...parsed.errors];
  const products: ImportProduct[] = [];
  const seen = new Set<string>();
  let skipped = parsed.skippedProducts;
  for (const p of parsed.products) {
    const name = String(p.input.name);
    const hits = byName.get(name) ?? [];
    if (hits.length === 0) {
      products.push(p);
      continue;
    }
    const errs: RowError[] = [];
    const cur = hits[0];
    if (hits.length > 1) errs.push({ row: p.row, column: "상품명", message: `상품명 「${name}」와 같은 상품이 여러 개입니다. 하나만 남기고 이름을 바꿔 주십시오` });
    else if (seen.has(cur.id)) errs.push({ row: p.row, column: "상품명", message: `상품 「${name}」가 파일에 두 번 있습니다` });
    else {
      seen.add(cur.id);
      const stock: StockChange[] = [];
      if (p.defaultOption && cur.options.length !== 1) errs.push({ row: p.row, column: "재고", message: `상품 「${name}」는 옵션이 ${cur.options.length}개라 어느 옵션의 재고인지 알 수 없어요. 옵션 열을 넣어 올려 주세요` });
      else for (const [i, o] of (p.input.options as { name: string; stock: number }[]).entries()) {
        const matches = p.defaultOption ? cur.options : cur.options.filter((x) => x.name === o.name);
        const found = matches[0];
        const meta = p.optionMeta?.[i];
        if (matches.length > 1) errs.push({ row: meta?.line ?? p.row, column: "옵션명", message: `상품 「${name}」에 옵션 「${o.name}」이 여러 개입니다. 옵션 이름을 서로 다르게 바꾼 뒤 올려 주십시오` });
        else if (!found) errs.push({ row: meta?.line ?? p.row, column: "옵션명", message: `상품 「${name}」에 옵션 「${o.name}」이 없습니다. 기존 상품은 옵션을 새로 만들지 않습니다` });
        else if (meta?.hasStock) stock.push({ optionId: found.id, name: found.name, before: found.stock, target: o.stock });
      }
      if (errs.length === 0) products.push({ ...p, update: { productId: cur.id, currentPrice: cur.price, stock } });
    }
    if (errs.length > 0) {
      errors.push(...errs);
      skipped++;
    }
  }
  errors.sort((a, b) => a.row - b.row);
  return { ...parsed, products, errors, skippedProducts: skipped };
}

// 새 상품(기존 상품과 맞지 않은 줄)의 할인가·할인 기간 검사: 할인가를 정액 할인(판매가 − 할인가)으로 바꿔 상품 이벤트 할인 규칙(기간·90% 한도·옵션 단가)으로 확인한다.
// 오류가 있는 상품은 건너뛴다. 기존 상품 수정 줄(update)은 이 열을 쓰지 않으므로 검사하지 않는다.
export function resolveProductEvents(parsed: Parsed, now = new Date()): Parsed {
  const errors = [...parsed.errors];
  const products: ImportProduct[] = [];
  let skipped = parsed.skippedProducts;
  for (const p of parsed.products) {
    const raw = p.eventRaw;
    if (!raw || p.update) {
      const { eventRaw: _drop, ...rest } = p;
      products.push(rest);
      continue;
    }
    const errs: RowError[] = [];
    const err = (column: Column, message: string) => errs.push({ row: raw.line, column, message });
    const price = Number(p.input.price);
    const dp = raw.discount === "" ? null : intCell(raw.discount, true);
    const period = raw.period === "" ? null : parsePeriod(raw.period);
    let event: ImportProduct["event"];
    if (raw.discount === "" || raw.period === "") err(raw.discount === "" ? "할인가" : "할인 기간", "할인가와 할인 기간은 함께 입력해 주십시오");
    else if (dp === null || dp < 1) err("할인가", "할인가는 1원 이상의 숫자로 입력해 주십시오");
    else if (!period) err("할인 기간", "할인 기간은 「2026-10-20 ~ 2026-10-27」처럼 시작일 ~ 종료일로 입력해 주십시오");
    else if (dp >= price) err("할인가", "할인가는 판매가보다 낮아야 합니다");
    else {
      const candidate = { type: "AMOUNT" as const, value: price - dp, startsAt: period.startsAt, endsAt: period.endsAt };
      const parsedEvent = parseEvent(candidate, now);
      const deltas = (p.input.options as { priceDelta: number }[]).map((o) => o.priceDelta);
      if (typeof parsedEvent === "string") err("할인 기간", parsedEvent === "invalid_event_period" ? "할인 기간을 확인해 주십시오. 종료일은 오늘 이후여야 하고 기간은 365일까지입니다" : "할인가를 확인해 주십시오");
      else if (candidate.value * 100 > price * MAX_EVENT_RATE) err("할인가", `할인가는 판매가의 ${100 - MAX_EVENT_RATE}% 이상이어야 합니다`);
      else if (!eventFits(parsedEvent, price, [0, ...deltas], now)) err("할인가", "할인 뒤 가격이 옵션 가격에서 1원 미만이 됩니다. 할인가를 확인해 주십시오");
      else event = candidate;
    }
    if (errs.length > 0) {
      errors.push(...errs);
      skipped++;
      continue;
    }
    const { eventRaw: _drop, ...rest } = p;
    products.push({ ...rest, ...(event ? { event } : {}) });
  }
  errors.sort((a, b) => a.row - b.row);
  return { ...parsed, products, errors, skippedProducts: skipped };
}

async function createPreview(db: PrismaClient, ctx: TenantContext, parsedIn: Result<Parsed>, rawName: unknown): Promise<Result<unknown>> {
  if (!parsedIn.ok) return parsedIn;
  const { totalRows, products, errors, skippedProducts } = resolveProductEvents(await classifyProducts(db, ctx, parsedIn.value));
  const fileName = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 100) : null;
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
      createCount: products.filter((p) => !p.update).length,
      updateCount: products.filter((p) => p.update).length,
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
        mode: p.update ? "update" : "create",
        currentPrice: p.update?.currentPrice ?? null,
        stockChangeCount: p.update ? p.update.stock.filter((s) => s.before !== s.target).length : 0,
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
  const updates: UpdateRecord[] = [];
  const failures: Failure[] = [];
  for (const p of products) {
    const name = String(p.input.name ?? "");
    if (p.update) {
      await applyUpdate(db, ctx, p, p.update, failures, async (rec) => {
        if (!updates.includes(rec)) updates.push(rec);
        await db.bulkJob.update({ where: { id: jobId }, data: { updatedProducts: updates as unknown as Prisma.InputJsonValue } });
      });
      continue;
    }
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
    if (p.event) {
      const e = await setProductEvent(db, ctx, r.value.id, p.event);
      if (!e.ok) failures.push({ row: p.row, name, message: "상품은 등록했지만 할인을 설정하지 못했습니다. 상품에서 직접 설정해 주십시오" });
    }
  }
  const doneAt = await dbNow(db);
  const done = await db.bulkJob.update({
    where: { id: jobId },
    data: { status: "COMMITTED", committedAt: doneAt, undoUntil: new Date(doneAt.getTime() + UNDO_WINDOW_MS), createdProductIds: created, updatedProducts: updates as unknown as Prisma.InputJsonValue, failures },
  });
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "bulk_io.product_import",
    targetType: "BulkJob",
    targetId: jobId,
    after: { created: created.length, updated: updates.length, failed: failures.length },
  });
  return { ok: true, value: commitView(done) };
}

// 기존 상품 수정 반영: 판매가가 다르면 바꾸고, 재고는 지금 재고와의 차이만큼 증감한다(직접 바꾼 재고와 같은 기록·검증, adjustStock).
// 미리보기 뒤 이름이 바뀐 상품·옵션은 건드리지 않는다. 판매가는 읽은 값(expectedPrice)과 같을 때만 바꿔 그사이의 직접 수정을 덮지 않는다.
// 바꿀 때마다 되돌리기 기록(save)을 바로 남겨 중간에 끊겨도 이미 바꾼 것은 되돌릴 수 있다.
async function applyUpdate(
  db: PrismaClient,
  ctx: TenantContext,
  p: ImportProduct,
  u: NonNullable<ImportProduct["update"]>,
  failures: Failure[],
  save: (rec: UpdateRecord) => Promise<void>,
): Promise<void> {
  const name = String(p.input.name ?? "");
  const rec: UpdateRecord = { productId: u.productId, name, price: null, stock: [] };
  const fail = (message: string) => failures.push({ row: p.row, name, message });
  try {
    const cur = await db.product.findFirst({
      where: { id: u.productId, sellerId: ctx.sellerId, deletedAt: null },
      select: { name: true, price: true, options: { where: { deletedAt: null }, select: { id: true, name: true, stock: true } } },
    });
    if (!cur || cur.name !== name) {
      fail("상품을 찾을 수 없습니다. 삭제되었거나 이름이 바뀌었습니다");
      return;
    }
    const price = Number(p.input.price);
    if (cur.price !== price) {
      const r = await updateProduct(db, ctx, u.productId, { price, expectedPrice: cur.price });
      if (r.ok) {
        rec.price = { before: cur.price, after: price };
        await save(rec);
      } else fail(r.reason === "price_conflict" ? "판매가가 그사이 바뀌어 수정하지 못했습니다" : (PRODUCT_FAILURE_MESSAGES[r.reason] ?? "판매가를 바꾸지 못했습니다"));
    }
    for (const s of u.stock) {
      const o = cur.options.find((x) => x.id === s.optionId);
      if (!o || o.name !== s.name) {
        fail(`옵션 「${s.name}」을 찾을 수 없습니다. 삭제되었거나 이름이 바뀌었습니다`);
        continue;
      }
      const delta = s.target - o.stock;
      if (delta === 0) continue;
      const r = await adjustStock(db, ctx, u.productId, s.optionId, { delta, reason: STOCK_NOTES.bulkEdit }, p.defaultOption ? s.optionId : undefined);
      if (r.ok) {
        rec.stock.push({ optionId: s.optionId, name: s.name, delta });
        await save(rec);
      } else fail(`옵션 「${s.name}」 재고를 바꾸지 못했습니다`);
    }
  } catch (e) {
    if (e instanceof AuthError && e.status === 404) fail("상품을 찾을 수 없습니다. 삭제되었거나 이름이 바뀌었습니다");
    else throw e;
  }
}

function commitView(j: { id: string; status: string; createdProductIds: Prisma.JsonValue; updatedProducts: Prisma.JsonValue; failures: Prisma.JsonValue; undoUntil: Date | null }) {
  const failures = asArray<Failure>(j.failures);
  return {
    jobId: j.id,
    status: j.status,
    createdCount: asArray<string>(j.createdProductIds).length,
    updatedCount: asArray<UpdateRecord>(j.updatedProducts).length,
    failedCount: failures.length,
    failures,
    undoUntil: j.undoUntil,
  };
}

// 되돌리기: 확정 뒤 24시간 안에 등록한 상품을 삭제 처리하고 수정한 상품은 반영 전 값으로 되돌린다. 주문이 한 번이라도 들어온 상품은 남기고, 되돌리지 못한 수정 상품도 알려 준다. 응답 { removedCount, restoredCount, keptCount, kept: [{ productId, name }] }
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

  // 기존 상품 수정은 반영 전 값으로 되돌린다: 재고는 반영 때 바꾼 만큼을 거꾸로 증감해 그 뒤 들어온 주문으로 줄어든 재고는 그대로 두고,
  // 판매가는 지금도 반영한 값일 때만 되돌린다(그 사이 직접 바꿨으면 그대로 두고 알려 준다).
  const restoreKept: { productId: string; name: string }[] = [];
  let restored = 0;
  for (const u of asArray<UpdateRecord>(found.updatedProducts)) {
    let all = true;
    try {
      for (const s of u.stock) {
        const r = await adjustStock(db, ctx, u.productId, s.optionId, { delta: -s.delta, reason: "재고 일괄 수정 되돌리기" });
        if (!r.ok) all = false;
      }
      if (u.price) {
        // 지금도 반영한 값일 때만(expectedPrice, 상품 잠금 안에서 비교) 되돌린다
        if (!(await updateProduct(db, ctx, u.productId, { price: u.price.before, expectedPrice: u.price.after })).ok) all = false;
      }
    } catch (e) {
      if (!(e instanceof AuthError && e.status === 404)) throw e;
      all = false;
    }
    if (all) restored++;
    else restoreKept.push({ productId: u.productId, name: u.name });
  }

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
  kept.push(...restoreKept);
  await db.bulkJob.update({ where: { id: jobId }, data: { keptCount: kept.length } });
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "bulk_io.product_import_undo",
    targetType: "BulkJob",
    targetId: jobId,
    after: { removed, restored, kept: kept.length },
  });
  return { ok: true, value: { removedCount: removed, restoredCount: restored, keptCount: kept.length, kept } };
}

const jobSummary = (j: Awaited<ReturnType<typeof listRaw>>[number], now: Date) => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  fileName: j.fileName,
  totalRows: j.totalRows,
  productCount: j.productCount,
  createdCount: asArray<string>(j.createdProductIds).length,
  updatedCount: asArray<UpdateRecord>(j.updatedProducts).length,
  updatedStockCount: asArray<UpdateRecord>(j.updatedProducts).reduce((n, u) => n + u.stock.length, 0),
  failedCount: asArray<Failure>(j.failures).length,
  errorTotal: asErrors(j.errors).total,
  keptCount: j.keptCount,
  createdAt: j.createdAt,
  committedAt: j.committedAt,
  undoUntil: j.undoUntil,
  undoneAt: j.undoneAt,
  reason: j.reason,
  meta: j.meta,
  undoable: j.status === "COMMITTED" && !!j.undoUntil && j.undoUntil.getTime() >= now.getTime(),
});
const IMPORT_ONLY: Prisma.BulkJobWhereInput = { kind: "PRODUCT_IMPORT" };
const listRaw = (db: PrismaClient, sellerId: string, opts: { id?: string; all?: boolean } = {}) =>
  db.bulkJob.findMany({ where: { sellerId, ...(opts.id ? { id: opts.id } : opts.all ? {} : IMPORT_ONLY) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: opts.id ? 1 : 30 });

// 처리한 사람(처리 이력의 「누가」): 파트너스 직원 이름과 대표자 여부. 직원이 아닌 행위자(마스터 대리 조회 등)는 이름 없음.
async function withActors<T extends { actorType: string; actorId: string | null }>(db: PrismaClient, sellerId: string, rows: T[]) {
  const ids = [...new Set(rows.filter((r) => r.actorType === "SELLER_USER" && r.actorId).map((r) => r.actorId!))];
  const users = ids.length ? await db.sellerUser.findMany({ where: { sellerId, id: { in: ids } }, select: { id: true, name: true, isOwner: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => {
    const u = r.actorType === "SELLER_USER" && r.actorId ? byId.get(r.actorId) : undefined;
    return { row: r, actorName: u?.name ?? null, actorIsOwner: u?.isOwner ?? null };
  });
}

// 작업 목록(최근 30개). 기본은 일괄 등록만(기존 화면), all=true면 내보내기 이력(상품·주문·회원)까지 함께(처리 이력).
// 응답 { jobs: [{ id, kind, status, fileName, totalRows, productCount, createdCount, failedCount, errorTotal, keptCount, reason, meta, createdAt, committedAt, undoUntil, undoable, actorName, actorIsOwner }] }
export async function listBulkJobs(db: PrismaClient, ctx: TenantContext, opts: { all?: boolean } = {}) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const now = await dbNow(db);
  const rows = await listRaw(db, ctx.sellerId, { all: opts.all });
  return { jobs: (await withActors(db, ctx.sellerId, rows)).map(({ row, actorName, actorIsOwner }) => ({ ...jobSummary(row, now), actorName, actorIsOwner })) };
}

// 작업 상세: 목록 항목 + 오류 목록(500개까지)과 확정 때 못 만든 상품.
export async function getBulkJob(db: PrismaClient, ctx: TenantContext, jobId: string) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw notFound();
  const [j] = await listRaw(db, ctx.sellerId, { id: jobId });
  if (!j) throw notFound();
  const [{ actorName, actorIsOwner }] = await withActors(db, ctx.sellerId, [j]);
  return { ...jobSummary(j, await dbNow(db)), actorName, actorIsOwner, errors: asErrors(j.errors).items, failures: asArray<Failure>(j.failures) };
}

// 상품 내보내기: 양식과 같은 열이라 고쳐서 다시 올리는 데 쓸 수 있다(올리면 이름이 같은 상품은 판매가·재고만 수정된다). 지운 상품은 뺀다. 개인정보 없음.
export async function exportProductsCsv(db: PrismaClient, ctx: TenantContext): Promise<Result<{ csv: string; count: number }>> {
  const r = await exportProductRows(db, ctx, true);
  return r.ok ? { ok: true, value: { csv: formatCsv(r.value.rows), count: r.value.count } } : r;
}

// 같은 내용을 엑셀(.xlsx)로. 엑셀 칸은 글자 형식이라 수식으로 실행되지 않아 CSV처럼 작은따옴표를 붙이지 않는다(붙이면 화면에 그대로 보인다).
export async function exportProductsXlsx(db: PrismaClient, ctx: TenantContext): Promise<Result<{ xlsx: Buffer; count: number }>> {
  const r = await exportProductRows(db, ctx, false);
  return r.ok ? { ok: true, value: { xlsx: writeXlsx(r.value.rows, "상품 목록"), count: r.value.count } } : r;
}

// guard: CSV는 수식처럼 보이는 글자 앞에 작은따옴표를 붙여 엑셀에서 열 때 수식이 실행되지 않게 한다(guardText)
async function exportProductRows(db: PrismaClient, ctx: TenantContext, guard: boolean): Promise<Result<{ rows: string[][]; count: number }>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const guardText = (v: string) => (guard ? guardCsv(v) : v);
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
      eventDiscountType: true,
      eventDiscountValue: true,
      eventStartsAt: true,
      eventEndsAt: true,
      categories: { select: { categoryId: true } },
      options: { where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { name: true, priceDelta: true, stock: true, sku: true } },
    },
  });
  const now = await dbNow(db);
  const rows: string[][] = [[...TEMPLATE_COLUMNS]];
  for (const p of products) {
    const cats = p.categories.map((c) => path.get(c.categoryId)).filter((v): v is string => !!v).join("|");
    const optRows = p.options.length > 0 ? p.options : [null];
    optRows.forEach((o, i) => {
      // 끝나지 않은 할인만 내보낸다: 할인가 = 판매가에서 할인한 값, 기간 = 시작일 ~ 종료일(KST)
      const ev = eventOf(p);
      const live = ev && ev.endsAt > now ? ev : null;
      const head =
        i === 0
          ? [guardText(p.name), guardText(cats), String(p.price)]
          : ["", "", ""];
      const tail =
        i === 0
          ? [live ? String(discountedUnit(p.price, live)) : "", live ? `${kstDay(live.startsAt)} ~ ${kstDay(new Date(live.endsAt.getTime() - 1))}` : "", guardText(p.description ?? ""), p.status === "HIDDEN" ? "예" : "아니오"]
          : ["", "", "", ""];
      rows.push([...head, o ? String(o.stock) : "", o ? guardText(o.name) : "", ...tail]);
    });
  }
  await recordExport(db, ctx, { kind: "PRODUCT_EXPORT", rows: products.length, action: "bulk_io.product_export", targetType: "BulkJob" });
  return { ok: true, value: { rows, count: products.length } };
}
