import { expect, test, type Page } from "@playwright/test";

// SA-061 배송비 정책: 방식(무료·고정·일정 금액 이상 무료)과 금액을 바꾸고 저장해 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function openAs(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fshipping");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/settings\/shipping$/);
}

const save = (page: Page) => page.getByRole("button", { name: "저장", exact: true }).last().click();
const saved = (page: Page) => expect(page.getByText("배송비 정책을 저장했어요 · 다음 주문부터 적용돼요")).toBeVisible();

test("일정 금액 이상 무료로 바꾸면 저장되고 주문서 미리보기에 보인다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByRole("radio", { name: "일정 금액 이상 무료" }).check();
  await page.getByLabel("배송비", { exact: true }).fill("3,500");
  await page.getByLabel("무료 배송 기준").fill("50000");
  await page.getByLabel("제주·도서산간 추가 배송비").fill("4000");
  await expect(page.getByTestId("fee-preview")).toHaveText("배송비 3,500원 · 50,000원 이상 무료");
  await save(page);
  await saved(page);
  await shot(page, "SA-061-shipping");

  await page.reload();
  await expect(page.getByRole("radio", { name: "일정 금액 이상 무료" })).toBeChecked();
  await expect(page.getByLabel("배송비", { exact: true })).toHaveValue("3500");
  await expect(page.getByLabel("무료 배송 기준")).toHaveValue("50000");
  await expect(page.getByLabel("제주·도서산간 추가 배송비")).toHaveValue("4000");
});

test("무료·고정으로 바꿔도 저장되고, 잘못된 금액은 막는다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByRole("radio", { name: "무료", exact: true }).check();
  await expect(page.getByTestId("fee-preview")).toHaveText("배송비 무료");
  await save(page);
  await saved(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "무료", exact: true })).toBeChecked();

  await page.getByRole("radio", { name: "고정" }).check();
  await page.getByLabel("배송비", { exact: true }).fill("-500");
  await save(page);
  await expect(page.getByText("1원 이상으로 적어 주세요")).toBeVisible();
  await page.getByLabel("배송비", { exact: true }).fill("200000");
  await expect(page.getByText("100,000원까지 정할 수 있어요")).toBeVisible();
  await shot(page, "SA-061-shipping-error");

  // 기본값으로 되돌려 둔다
  await page.getByLabel("배송비", { exact: true }).fill("3000");
  await page.getByLabel("제주·도서산간 추가 배송비").fill("3000");
  await save(page);
  await saved(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "고정" })).toBeChecked();
  await expect(page.getByTestId("fee-preview")).toHaveText("배송비 3,000원");
});

test("무료로 바꿨다가 되돌리면 이전에 넣은 배송비·무료 기준이 그대로 있다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByRole("radio", { name: "일정 금액 이상 무료" }).check();
  await page.getByLabel("배송비", { exact: true }).fill("2500");
  await page.getByLabel("무료 배송 기준").fill("70000");
  await save(page);
  await saved(page);

  await page.getByRole("radio", { name: "무료", exact: true }).check();
  await save(page);
  await saved(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "무료", exact: true })).toBeChecked();
  await page.getByRole("radio", { name: "일정 금액 이상 무료" }).check();
  await expect(page.getByLabel("배송비", { exact: true })).toHaveValue("2500");
  await expect(page.getByLabel("무료 배송 기준")).toHaveValue("70000");

  // 기본값으로 되돌려 둔다
  await page.getByRole("radio", { name: "고정" }).check();
  await page.getByLabel("배송비", { exact: true }).fill("3000");
  await save(page);
  await saved(page);
});

test("1440에서 도움말이 단어 중간에서 끊기지 않는다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  const help = page.getByText("제주와 그 밖의 도서지역에 같은 금액이 붙어요", { exact: false });
  await expect(help).toBeVisible();
  expect(await help.evaluate((el) => getComputedStyle(el).wordBreak)).toBe("keep-all");
});

test("쇼핑몰 설정 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await openAs(page, "demo-viewer@example.com");
  await expect(page.getByText("필요한 권한: 쇼핑몰 설정")).toBeVisible();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
});
