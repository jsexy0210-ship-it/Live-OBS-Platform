import { expect, test, type Page } from "@playwright/test";
import { cleanupProducts, RUN, track } from "./cleanup";
import { submitSellerLogin } from "./sellerLogin";

// SA-011 상품 목록: 검색 조건(코드·카테고리·노출·재고 차감·등록일)·정렬·판매량·선택 일괄 처리(판매 상태·삭제·되돌리기).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
test.afterAll(() => cleanupProducts(PASSWORD));

const rows = (page: Page) => page.getByTestId("product-row");
const box = (page: Page) => page.getByRole("search", { name: "목록 조건" });

async function open(page: Page) {
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL(/\/seller\/(?!login)/);
  await page.goto("/seller/products");
  await expect(rows(page).first()).toBeVisible();
}
const hdr = (page: Page) => ({ Origin: new URL(page.url()).origin });

async function make(page: Page, name: string, extra: Record<string, unknown> = {}) {
  const r = await page.request.post("/api/seller/products", {
    data: { name: track(name), price: 3000, status: "ON_SALE", options: [{ name: "기본", priceDelta: 0, stock: 10, sortOrder: 0 }], ...extra },
    headers: hdr(page),
  });
  expect(r.status()).toBe(201);
  return ((await r.json()) as { id: string; code: string }).id;
}
async function search(page: Page) {
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/seller/products?") && r.request().method() === "GET"), box(page).getByRole("button", { name: "검색", exact: true }).click()]);
}
const nameQuery = async (page: Page, text: string) => {
  await page.getByLabel("상품 검색").fill(text);
  await search(page);
};

test("정렬: 판매가 낮은순·높은순으로 바로 바뀌고, 판매량 열이 보인다", async ({ page }) => {
  await open(page);
  const prices = async () => (await rows(page).locator("td:nth-child(4)").allInnerTexts()).map((t) => Number(t.replace(/[^0-9]/g, "")));
  await Promise.all([page.waitForResponse((r) => r.url().includes("sort=price_asc")), page.getByLabel("정렬").selectOption({ label: "판매가 낮은순" })]);
  await expect.poll(async () => {
    const p = await prices();
    return p.length > 1 && p.every((v, i) => i === 0 || v >= p[i - 1]!);
  }).toBe(true);
  await Promise.all([page.waitForResponse((r) => r.url().includes("sort=price_desc")), page.getByLabel("정렬").selectOption({ label: "판매가 높은순" })]);
  await expect.poll(async () => {
    const p = await prices();
    return p.length > 1 && p.every((v, i) => i === 0 || v <= p[i - 1]!);
  }).toBe(true);
  await expect(page.locator("th", { hasText: /^판매$/ })).toBeVisible();
  // 목록 개수
  await Promise.all([page.waitForResponse((r) => r.url().includes("limit=20")), page.getByLabel("목록 개수").selectOption("20")]);
});

test("검색 조건: 상품 코드·노출 상태·재고 차감·등록일로 걸러 본다", async ({ page }) => {
  await open(page);
  const a = `조건상품 ${RUN}`;
  const b = `조건상품주문차감 ${RUN}`;
  await make(page, a);
  await make(page, b, { stockDeductMode: "ORDER", status: "HIDDEN" });
  await page.reload();
  // 이름 + 재고 차감 시점
  await page.getByLabel("상품 검색").fill(`조건상품`);
  await box(page).getByRole("radiogroup", { name: "재고가 줄어드는 때" }).getByRole("radio", { name: "주문하면 바로 줄임" }).check();
  await search(page);
  await expect(rows(page).filter({ hasText: b })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: a })).toHaveCount(0);
  // 노출 상태: 비노출만 → 숨김인 b
  await box(page).getByRole("radiogroup", { name: "재고가 줄어드는 때" }).getByRole("radio", { name: "전체" }).check();
  await box(page).getByRole("radiogroup", { name: "쇼핑몰 노출" }).getByRole("radio", { name: "안 보임" }).check();
  await search(page);
  await expect(rows(page).filter({ hasText: b })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: a })).toHaveCount(0);
  await expect(rows(page).locator("td:nth-child(7)").first()).toHaveText("안 보임");
  await box(page).getByRole("radiogroup", { name: "쇼핑몰 노출" }).getByRole("radio", { name: "쇼핑몰에 보임", exact: true }).check();
  await search(page);
  await expect(rows(page).filter({ hasText: a })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: b })).toHaveCount(0);
  // 상품 코드로 찾기: a의 코드(P0000012 꼴)
  const code = (await rows(page).filter({ hasText: a }).locator("td:nth-child(3) .t-c1").innerText()).split(" · ")[0]!;
  expect(code).toMatch(/^P\d{7}$/);
  await box(page).getByRole("button", { name: "초기화" }).click();
  await box(page).getByLabel("검색 기준").selectOption("code");
  await page.getByLabel("상품 검색").fill(code);
  await search(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText(a);
  // 등록일: 오늘이면 보이고, 지난 기간이면 안 보인다
  await box(page).getByRole("button", { name: "초기화" }).click();
  await box(page).getByRole("button", { name: "오늘", exact: true }).click();
  await nameQuery(page, `조건상품 ${RUN}`);
  await expect(rows(page).filter({ hasText: a })).toHaveCount(1);
  await box(page).getByLabel("등록일 시작").fill("2020-01-01");
  await box(page).getByLabel("등록일 끝").fill("2020-01-31");
  await search(page);
  await expect(page.getByText("에 해당하는 상품이 없습니다")).toBeVisible();
  // 시작이 끝보다 늦으면 서버가 알려 준 이유를 보인다
  await box(page).getByLabel("등록일 시작").fill("2026-02-01");
  await box(page).getByLabel("등록일 끝").fill("2026-01-01");
  await search(page);
  await expect(page.getByRole("button", { name: "조건 초기화" })).toBeVisible();
});

test("카테고리로 걸러 본다(대분류는 하위 포함)", async ({ page }) => {
  await open(page);
  const h = hdr(page);
  const p = await page.request.post("/api/seller/categories", { data: { name: `목록대 ${RUN}` }, headers: h });
  const parentId = ((await p.json()) as { categories: { id: string; name: string }[] }).categories.find((c) => c.name === `목록대 ${RUN}`)!.id;
  const c = await page.request.post("/api/seller/categories", { data: { name: `목록소 ${RUN}`, parentId }, headers: h });
  const childId = ((await c.json()) as { categories: { id: string; children: { id: string; name: string }[] }[] }).categories.find((x) => x.id === parentId)!.children[0]!.id;
  try {
    const inCat = `카테고리목록 ${RUN}`;
    const id = await make(page, inCat);
    await make(page, `카테고리밖 ${RUN}`);
    expect((await page.request.put(`/api/seller/products/${id}/categories`, { data: { categoryIds: [childId] }, headers: h })).status()).toBe(200);
    await page.reload();
    // 한 선택 상자: 「대분류」 다음에 「대분류 › 하위」
    await box(page).getByLabel("카테고리", { exact: true }).selectOption({ label: `목록대 ${RUN}` });
    await search(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(inCat);
    await box(page).getByLabel("카테고리", { exact: true }).selectOption({ label: `목록대 ${RUN} › 목록소 ${RUN}` });
    await search(page);
    await expect(rows(page)).toHaveCount(1);
  } finally {
    await page.request.delete(`/api/seller/categories/${childId}`, { headers: h });
    await page.request.delete(`/api/seller/categories/${parentId}`, { headers: h });
  }
});

test("선택 일괄 처리: 숨김으로 바꾸고 되돌리고, 선택 삭제는 확인을 거친다", async ({ page }) => {
  await open(page);
  const names = ["가", "나", "다"].map((s) => `일괄${s} ${RUN}`);
  for (const n of names) await make(page, n);
  await page.reload();
  await nameQuery(page, `일괄`);
  const mine = rows(page).filter({ hasText: `${RUN}` });
  await expect(mine).toHaveCount(3);
  // 선택이 없으면 일괄 버튼은 눌 수 없다
  await expect(page.getByRole("button", { name: "선택 숨김" })).toBeDisabled();
  for (const n of names) await page.getByLabel(`${n} 선택`).check();
  await page.getByRole("button", { name: "선택 숨김" }).click();
  await page.getByRole("button", { name: "바꾸기", exact: true }).click();
  await expect(page.getByText("선택한 3개 상품을 숨김으로 바꿨습니다")).toBeVisible();
  await expect(mine.locator("td:nth-child(8)").first()).toHaveText("숨김");
  await expect(mine.filter({ hasText: "숨김" })).toHaveCount(3);
  // 되돌리기: 처음 상태(판매 중)로
  await page.getByRole("button", { name: "되돌리기" }).click();
  await expect(page.getByText("되돌렸습니다")).toBeVisible();
  await expect(mine.filter({ hasText: "판매 중" })).toHaveCount(3);
  // 선택 삭제: 취소하면 그대로, 삭제하면 사라진다
  await page.getByLabel(`${names[0]} 선택`).check();
  await page.getByLabel(`${names[1]} 선택`).check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("선택한 상품 2개를 삭제하시겠습니까?");
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(mine).toHaveCount(3);
  await page.getByLabel(`${names[0]} 선택`).check();
  await page.getByLabel(`${names[1]} 선택`).check();
  await page.getByRole("button", { name: "선택 삭제" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByText("상품 2개를 삭제했습니다")).toBeVisible();
  await expect(mine).toHaveCount(1);
  await expect(mine.first()).toContainText(names[2]!);
});
