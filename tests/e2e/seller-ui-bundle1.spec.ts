import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// UI 묶음 1(상품 목록·주문 목록·입금 확인·재고 관리): 버튼 폭·높이 규칙, 썸네일 64, 그리고 UX-01·02
// (검색어·필터·정렬을 주소에 싣고, 상세에 갔다 Back으로 돌아오면 복원, 「상품 목록」은 앱 안 이전 화면이 있으면 되돌아감).
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

const size = async (loc: ReturnType<Page["locator"]>) => {
  const b = (await loc.boundingBox())!;
  return { w: Math.round(b.width), h: Math.round(b.height) };
};

test("상품 목록: 날짜 빠른 버튼 40×64, 일괄 버튼 40×96, 표 안 수정 32×64, 썸네일 64", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products");
  await expect(page.getByTestId("product-row").first()).toBeVisible();
  for (const name of ["오늘", "7일", "1개월", "3개월", "전체"]) {
    expect(await size(page.getByRole("button", { name, exact: true }).first()), name).toEqual({ w: 64, h: 40 });
  }
  for (const name of ["선택 판매 중", "선택 숨김", "선택 삭제"]) {
    expect(await size(page.getByRole("button", { name })), name).toEqual({ w: 96, h: 40 });
  }
  // 도구 줄 Select는 inline 폭 없이 클래스 폭(정렬 150·개수 100)이고 한 줄에 나란히 있다
  expect(await size(page.getByLabel("정렬"))).toEqual({ w: 150, h: 40 });
  expect(await size(page.getByLabel("목록 개수"))).toEqual({ w: 100, h: 40 });
  const edit = page.getByTestId("product-row").first().getByRole("link", { name: "수정" });
  expect(await size(edit)).toEqual({ w: 64, h: 32 });
  const thumb = await size(page.getByTestId("product-row").first().locator(".thumb"));
  expect(thumb).toEqual({ w: 64, h: 64 });
  // inline 크기를 쓰지 않는다
  expect(await page.locator(".p-table th[style*='width']").count()).toBe(0);
});

test("상품 목록: 검색어·판매 상태·정렬이 주소에 실리고, 상세에 갔다 Back으로 돌아오면 그대로다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products");
  await expect(page.getByTestId("product-row").first()).toBeVisible();
  await page.getByLabel("상품 검색").fill("탑로더");
  await page.getByRole("radio", { name: "판매 중" }).check();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page).toHaveURL(/[?&]q=%ED%83%91%EB%A1%9C%EB%8D%94|[?&]q=탑로더/);
  await expect(page).toHaveURL(/status=ON_SALE/);
  await page.getByLabel("정렬").selectOption("price_desc");
  await expect(page).toHaveURL(/sort=price_desc/);
  const rows = page.getByTestId("product-row");
  await expect(rows.first()).toBeVisible();
  await rows.first().getByRole("link").first().click();
  await expect(page).toHaveURL(/\/seller\/products\/[^/?]+$/);
  await page.goBack();
  await expect(page).toHaveURL(/status=ON_SALE/);
  await expect(page.getByLabel("상품 검색")).toHaveValue("탑로더");
  await expect(page.getByRole("radio", { name: "판매 중" })).toBeChecked();
  await expect(page.getByLabel("정렬")).toHaveValue("price_desc");
  // 잘못된 값은 기본값으로 읽는다
  await page.goto("/seller/products?status=BOGUS&sort=nope&limit=7");
  await expect(page.getByLabel("정렬")).toHaveValue("newest");
  await expect(page.getByLabel("목록 개수")).toHaveValue("50");
  await expect(page.getByRole("radio", { name: "전체" }).first()).toBeChecked();
  // 초기화하면 쿼리가 비워진다
  await page.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(page).not.toHaveURL(/status=/);
});

test("주문 목록: 기간 칩이 주소에 실리고 새로고침·Back에도 유지된다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/orders");
  await page.getByRole("button", { name: /^최근 7일/ }).click();
  await expect(page).toHaveURL(/period=7d/);
  await page.reload();
  await expect(page.getByRole("button", { name: /^최근 7일/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByPlaceholder("닉네임 · 주문번호").fill("zzz-없는-닉네임");
  await expect(page).toHaveURL(/q=/);
  await page.getByRole("button", { name: "필터 초기화" }).first().click();
  await expect(page).not.toHaveURL(/period=|q=/);
  await expect(page.getByPlaceholder("닉네임 · 주문번호")).toHaveValue("");
  // 환불 요청 버튼은 Secondary 96
  expect(await size(page.getByRole("link", { name: "환불 요청" }).last())).toMatchObject({ w: 96 });
});

test("입금 확인: 일괄 버튼 40×144, 표 안 버튼은 폭 80", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/orders/deposits");
  const bulk = page.getByRole("button", { name: /^선택 입금 확인/ });
  await expect(bulk).toBeVisible();
  expect(await size(bulk)).toEqual({ w: 144, h: 40 });
  const one = page.getByTestId("deposit-row").first().getByRole("button", { name: "입금 확인" });
  if (await one.count()) expect(await size(one)).toEqual({ w: 80, h: 32 });
});

test("재고 관리: 검색어·재고 조건이 주소에 실리고, 「상품 목록」은 이전 화면으로 돌아간다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products/stock");
  await expect(page.getByTestId("stock-row").first()).toBeVisible();
  await page.getByLabel("재고 검색").fill("탑로더");
  await expect(page).toHaveURL(/q=/);
  await page.reload();
  await expect(page.getByLabel("재고 검색")).toHaveValue("탑로더");
  await expect(page.getByTestId("stock-row").first()).toBeVisible();
  // 표 안 버튼 96×32, 한꺼번에 적기 40×120
  const btns = page.getByTestId("stock-row").first().locator(".c-act .btn");
  for (const b of await btns.all()) expect(await size(b)).toEqual({ w: 96, h: 32 });
  expect(await size(page.getByRole("button", { name: "한꺼번에 적기" }))).toEqual({ w: 120, h: 40 });
  expect(await size(page.getByLabel("선택한 옵션에 더하거나 뺄 수량"))).toEqual({ w: 80, h: 40 });
  expect(await page.locator(".stock-table th[style*='width']").count()).toBe(0);
});

test("재고 관리: 상품 목록에서 들어왔다가 「상품 목록」을 누르면 목록 조건이 그대로 돌아온다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/seller/products");
  await page.getByLabel("정렬").selectOption("price_asc");
  await expect(page).toHaveURL(/sort=price_asc/);
  await page.getByRole("link", { name: "재고 관리" }).first().click();
  await expect(page).toHaveURL(/\/seller\/products\/stock/);
  await page.getByRole("button", { name: "상품 목록" }).first().click();
  await expect(page).toHaveURL(/\/seller\/products\?.*sort=price_asc/);
  await expect(page.getByLabel("정렬")).toHaveValue("price_asc");
});
