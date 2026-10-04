import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-052 오버레이 주소 발급·재발급(메뉴 「오버레이 편집기」): 확인 창을 거쳐 발급하면 세로·가로 주소가 한 번 보이고,
// 그 주소가 실제 오버레이로 열리며, 다시 발급하면 이전 주소는 끊긴다. 결과가 불분명한 발급은 성공으로 보이지 않는다.
// 오버레이 편집 권한이 없는 직원은 메뉴·화면이 없다. 모두 실제 API(POST /api/seller/overlay/token)를 부른다.
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

async function login(page: Page, email: string, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

const toast = (page: Page) => page.getByRole("status").filter({ has: page.locator(".toast") });

async function issueVia(page: Page, button: string) {
  await page.getByRole("button", { name: button }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(button === "다시 발급" ? "기존 OBS 주소는 바로 끊깁니다" : "이전에 발급한 주소가 있으면 바로 끊깁니다");
  await dialog.getByRole("button", { name: "발급" }).click();
  await expect(dialog).toHaveCount(0);
}

test("대표자: 메뉴에서 들어가 주소를 발급·복사하면 실제 오버레이가 열리고, 다시 발급하면 이전 주소는 끊긴다", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, "demo-owner@example.com", "/seller/products");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "방송", exact: true }).click();
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "오버레이 편집기" }).click();
  await expect(page).toHaveURL(/\/seller\/overlay$/);
  await expect(page.getByTestId("ove")).toBeVisible();
  await expect(page.getByTestId("ovu-urls")).toHaveCount(0);
  await shot(page, "SA-052-empty");

  // 확인 창에서 닫으면 발급하지 않는다
  await page.getByRole("button", { name: "주소 발급" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "닫기" }).click();
  await expect(page.getByTestId("ovu-urls")).toHaveCount(0);

  await issueVia(page, "주소 발급");
  await expect(toast(page)).toContainText("새 주소를 발급했습니다");
  const port = page.getByLabel("세로 9:16 주소");
  const first = await port.inputValue();
  expect(first).toMatch(/\/overlay\/[^/?]+$/);
  await expect(page.getByLabel("가로 16:9 주소")).toHaveValue(`${first}?ratio=16x9`);
  await expect(page.getByText("이 주소는 지금만 볼 수 있습니다. OBS에 넣은 뒤 잃어버리면 재발급해 주십시오.")).toBeVisible();
  await shot(page, "SA-052-issued");

  // 복사
  await page.locator("li", { has: port }).getByRole("button", { name: "주소 복사" }).click();
  await expect(toast(page)).toContainText("주소를 복사했습니다");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);

  // 발급한 주소가 실제 오버레이로 열린다
  const ov = await context.newPage();
  await ov.goto(first);
  await expect(ov.getByTestId("overlay")).toBeVisible();
  await expect(ov.getByTestId("overlay-gone")).toHaveCount(0);
  await expect(ov.getByTestId("overlay-idle").or(ov.getByTestId("overlay-queue"))).toBeVisible();

  // 다시 발급 → 새 주소, 이전 주소는 끊김
  await issueVia(page, "다시 발급");
  await expect(port).not.toHaveValue(first);
  const second = await port.inputValue();
  await ov.goto(first);
  await expect(ov.getByTestId("overlay-gone")).toBeVisible();
  await ov.goto(second);
  await expect(ov.getByTestId("overlay-gone")).toHaveCount(0);
  await expect(ov.getByTestId("overlay-idle").or(ov.getByTestId("overlay-queue"))).toBeVisible();
  await ov.close();
});

test("발급 결과가 불분명하면 주소를 보이지 않고 이전 주소가 끊겼을 수 있다고 알린다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/overlay");
  await page.route("**/api/seller/overlay/token", (r) => r.abort("connectionreset"));
  await issueVia(page, "주소 발급");
  await expect(page.getByTestId("ovu-unclear")).toContainText("발급 결과를 확인하지 못했습니다");
  await expect(page.getByTestId("ovu-urls")).toHaveCount(0);
});

test("오버레이 편집 권한이 없는 직원: 메뉴가 없고 주소로 들어와도 화면이 없다", async ({ page }) => {
  await login(page, "demo-none@example.com", "/seller/overlay");
  await expect(page.getByText("필요한 권한: 오버레이 편집")).toBeVisible();
  await expect(page.getByRole("link", { name: "오버레이 편집기" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "주소 발급" })).toHaveCount(0);
});

test("이미 주소를 보던 중 재발급 결과가 불분명하면 이전 주소도 지운다(서버가 이미 끊었을 수 있음)", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/overlay");
  await issueVia(page, "주소 발급");
  await expect(page.getByTestId("ovu-urls")).toBeVisible();
  // 요청은 서버에 닿아 실제로 재발급되지만 응답은 5xx로 받는다
  await page.route("**/api/seller/overlay/token", async (r) => {
    await r.fetch();
    await r.fulfill({ status: 502, body: "{}" });
  });
  await issueVia(page, "다시 발급");
  await expect(page.getByTestId("ovu-unclear")).toContainText("이전 주소가 이미 끊겼을 수 있습니다");
  await expect(page.getByTestId("ovu-urls")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "주소 복사" })).toHaveCount(0);
});
