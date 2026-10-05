import { expect, test, type Page } from "@playwright/test";
import { resetCartInDb, resetWishlistInDb, setOptionStockInDb } from "./cartDb";

// SH-003 상품 상세(운영 빌드 + 데모 시드). 데모 구매자(demo-buyer1@example.com)의 장바구니·찜을 시작·끝에 비운다.
const SLUG = "demo-shop";
const LOGIN = "demo-buyer1@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOT = process.env.E2E_SCREENSHOTS === "1";

async function login(page: Page, baseURL: string) {
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: LOGIN, password: PASSWORD }, headers: { origin: baseURL } });
  expect(r.status()).toBe(200);
}
async function open(page: Page, name: string) {
  await page.goto(`/shop/${SLUG}/products`);
  await page.getByRole("list", { name: "전체 상품" }).getByRole("link", { name }).first().click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.afterAll(async () => {
  await resetCartInDb(SLUG, LOGIN, []);
  await resetWishlistInDb(SLUG, LOGIN, []);
});

test("PC: 목록에서 상세로 → 옵션·수량·합계, 수량 한도 안내, 로그인 필요 창", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "스타라이트 부스터 박스");
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/products/[0-9a-f-]{36}$`));
  const opt = page.getByLabel("옵션");
  await expect(opt).toHaveValue(/./);
  await expect(opt.locator("option:checked")).toContainText("1박스 (36팩) · 189,000원");
  await expect(page.getByLabel("수량 1개")).toBeVisible(); // 기본 수량 1
  const total = page.locator(".pd-total");
  await expect(total).toContainText("189,000원");
  await page.getByRole("button", { name: "수량 늘리기" }).click();
  await expect(total).toContainText("378,000원");
  await opt.selectOption({ label: "낱개 1팩 · 6,000원" });
  await expect(page.getByLabel("수량 1개")).toBeVisible(); // 옵션을 바꾸면 수량 1로
  await expect(total).toContainText("6,000원");
  await expect(page.getByText("상세 정보가 아직 없어요.")).toBeVisible();
  if (SHOT) await page.screenshot({ path: "tests/e2e/screenshots/SH-003-detail-1440.png" });
  // 비회원: 장바구니·바로 구매·찜은 로그인 안내 창
  await page.getByRole("button", { name: "장바구니", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "로그인이 필요해요" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("link", { name: "로그인" })).toHaveAttribute("href", /\/login\?next=.*products/);
  await dlg.getByRole("button", { name: "둘러보기" }).click();
  await expect(dlg).toBeHidden();
  await page.getByRole("button", { name: "찜하기" }).click();
  await expect(dlg).toBeVisible();
  await page.keyboard.press("Escape");
  // 수량 한도: 남은 재고 5개 상품
  await open(page, "문라이트 컬렉션 박스");
  await expect(page.getByText("5개 남았어요")).toBeVisible();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "수량 늘리기" }).click();
  await expect(page.getByLabel("수량 5개")).toBeVisible();
  await page.getByRole("button", { name: "수량 늘리기" }).click();
  await expect(page.getByText("5개까지 주문할 수 있어요")).toBeVisible();
  await expect(page.getByLabel("수량 5개")).toBeVisible();
});

test.describe.serial("로그인 구매자", () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await resetCartInDb(SLUG, LOGIN, []);
    await resetWishlistInDb(SLUG, LOGIN, []);
    await login(page, baseURL!);
  });

  test("장바구니 담기·찜 켜고 끄기·바로 구매는 주문서로", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "스타라이트 부스터 박스");
    await page.getByRole("button", { name: "수량 늘리기" }).click();
    await page.getByRole("button", { name: "장바구니", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("장바구니에 담았어요");
    await expect(page.locator(".shop-hics").getByRole("link", { name: /장바구니 \(1개\)/ })).toBeVisible();
    await page.getByRole("link", { name: "장바구니 보기" }).click();
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.getByText("스타라이트 부스터 박스").first()).toBeVisible();
    await page.goBack();
    // 찜
    await expect(page.getByRole("button", { name: "찜하기" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "찜하기" }).click();
    await expect(page.getByRole("button", { name: "찜 빼기" })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByRole("button", { name: "찜 빼기" })).toBeVisible(); // 새로 불러와도 찜 상태가 남음
    await page.getByRole("button", { name: "찜 빼기" }).click();
    await expect(page.getByRole("button", { name: "찜하기" })).toBeVisible();
    // 바로 구매
    await page.getByRole("button", { name: "구매하기" }).click();
    await expect(page).toHaveURL(/\/checkout\?ids=/);
    await expect(page.getByRole("heading", { name: "주문서", level: 1 })).toBeVisible();
  });
});

test("품절: 띠·「품절됐어요」 버튼, 옵션 일부 품절은 그 옵션만 「품절」", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "드래곤 소울 부스터");
  await expect(page.locator(".pd-hero .pc-out")).toBeVisible();
  await expect(page.getByRole("button", { name: "품절됐어요" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "구매하기" })).toHaveCount(0);
  const before = await setOptionStockInDb(SLUG, "스타라이트 부스터 박스", "낱개 1팩", 0);
  try {
    await open(page, "스타라이트 부스터 박스");
    await expect(page.locator(".pd-hero .pc-out")).toHaveCount(0); // 띠 없음
    const sold = page.getByLabel("옵션").locator("option", { hasText: "낱개 1팩 · 품절" });
    await expect(sold).toBeDisabled();
    await expect(page.getByLabel("옵션").locator("option:checked")).toContainText("1박스"); // 기본은 살 수 있는 첫 옵션
    await expect(page.getByRole("button", { name: "구매하기" })).toBeEnabled();
  } finally {
    await setOptionStockInDb(SLUG, "스타라이트 부스터 박스", "낱개 1팩", before);
  }
});

test("없는 상품은 404, 휴대폰 390은 가로 스크롤 없음", async ({ page }) => {
  const r = await page.request.get(`/shop/${SLUG}/products/00000000-0000-4000-8000-000000000000`);
  expect(r.status()).toBe(404);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "스타라이트 부스터 박스");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  if (SHOT) await page.screenshot({ path: "tests/e2e/screenshots/SH-003-detail-390.png", fullPage: true });
});
