import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-031 적립 정책 중 적립금 지급 시점: 결제하면 바로 / 배송 완료 후(기본)를 바꿔 저장해 확인한다.
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

async function login(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller%2Frewards");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/rewards$/);
}

async function saveOk(page: Page) {
  await page.getByRole("button", { name: "저장", exact: true }).last().click();
  const dialog = page.getByRole("dialog", { name: "적립 정책을 저장하시겠습니까?" });
  await expect(dialog).toContainText("이미 지급한 적립금은 그대로입니다");
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/reward-policy") && r.ok()),
    dialog.getByRole("button", { name: "저장", exact: true }).click(),
  ]);
  await expect(page.getByText("적립 정책을 저장했습니다", { exact: false }).first()).toBeVisible();
}

test("적립금 지급 시점: 기본은 배송 완료 후, 결제하면 바로로 바꾸면 저장되고 다시 열어도 그대로다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  // 이전 실행이 바꾼 값에 기대지 않게 기본값으로 맞춘다
  const status = await page.evaluate(async () =>
    (await fetch("/api/seller/reward-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ earnTiming: "ON_DELIVERY" }) })).status,
  );
  expect(status).toBe(200);
  await page.reload();

  // 메뉴 「적립금」에서 들어온다
  await expect(page.getByRole("link", { name: "적립금", exact: true })).toHaveAttribute("href", "/seller/rewards");
  await expect(page.getByRole("radio", { name: "배송 완료 후 지급 (기본)" })).toBeChecked();
  await expect(page.getByText("적립금은 결제할 때 금액으로 정해집니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "저장", exact: true }).last()).toBeDisabled();
  await shot(page, "SA-031-earn-timing");

  await page.getByRole("radio", { name: "결제하면 바로 지급" }).check();
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "결제하면 바로 지급" })).toBeChecked();

  // 되돌려 둔다
  await page.getByRole("radio", { name: "배송 완료 후 지급 (기본)" }).check();
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "배송 완료 후 지급 (기본)" })).toBeChecked();
});

test("회원·적립금 권한이 없는 직원은 메뉴가 안 보이고, 주소로 들어와도 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Frewards");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/rewards$/);
  await expect(page.getByText("필요한 권한: 회원·적립금", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "적립금", exact: true })).toHaveCount(0);
});
