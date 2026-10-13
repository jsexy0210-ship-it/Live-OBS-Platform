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

// 이미 발급한 적이 있으면(서버 발급일) 버튼 이름이 「주소 새로 만들기」, 처음이면 「주소 만들기」
const ISSUE = /^(주소 만들기|재발급)$/;
async function issueVia(page: Page, button: string) {
  await page.getByRole("button", { name: ISSUE }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(button === "재발급" ? "기존 OBS 주소는 바로 끊깁니다" : /바로 (쓸 수 없게 됩니다|끊깁니다)/);
  // 재발급 확인 창은 「확인했습니다」를 체크해야 실행된다
  const sure = dialog.getByRole("checkbox", { name: "확인했습니다" });
  if (await sure.count()) await sure.check();
  await dialog.getByRole("button", { name: ISSUE }).click();
  await expect(dialog).toHaveCount(0);
}

test("대표자: 메뉴에서 들어가 주소를 발급·복사하면 실제 오버레이가 열리고, 다시 발급하면 이전 주소는 끊긴다", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, "demo-owner@example.com", "/seller/products");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "방송", exact: true }).click();
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "방송 화면 꾸미기" }).click();
  await expect(page).toHaveURL(/\/seller\/overlay$/);
  await expect(page.getByTestId("ove")).toBeVisible();
  // 둘째 탭 「방송 프로그램에 넣기」(SA-052)에서 주소를 만든다. 편집기에는 주소 칸이 없다
  await expect(page.getByTestId("ovu-urls")).toHaveCount(0);
  await page.getByRole("navigation", { name: "화면 탭" }).getByRole("link", { name: "방송 프로그램에 넣기" }).click();
  await expect(page).toHaveURL(/\/seller\/overlay\/address$/);
  await expect(page.getByRole("heading", { name: "방송 프로그램에 넣기", level: 1 })).toBeVisible();
  await expect(page.getByTestId("ove")).toHaveCount(0);
  await expect(page.getByTestId("ovu-how")).toContainText("브라우저");
  await shot(page, "SA-052-empty");

  // 확인 창에서 닫으면 발급하지 않는다
  await page.getByRole("button", { name: ISSUE }).click();
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();
  await expect(page.getByLabel("세로형 1080×1920 (9:16) 주소")).toHaveValue(/•/);

  await issueVia(page, "주소 만들기");
  await expect(toast(page)).toContainText("새 주소를 만들었습니다");
  const port = page.getByLabel("세로형 1080×1920 (9:16) 주소");
  const first = await port.inputValue();
  expect(first).toMatch(/\/overlay\/[^/?]+$/);
  await expect(page.getByLabel("가로형 1920×1080 (16:9) 주소")).toHaveValue(`${first}?ratio=16x9`);
  await expect(page.getByText("이 주소는 지금만 볼 수 있습니다. OBS에 넣은 뒤 잃어버리면 재발급해 주십시오.")).toBeVisible();
  await shot(page, "SA-052-issued");

  // 복사
  await page.locator("tr", { has: port }).getByRole("button", { name: "복사" }).click();
  await expect(toast(page)).toContainText("주소를 복사했습니다");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);

  // 발급한 주소가 실제 오버레이로 열린다
  const ov = await context.newPage();
  await ov.goto(first);
  await expect(ov.getByTestId("overlay")).toBeVisible();
  await expect(ov.getByTestId("overlay-gone")).toHaveCount(0);
  await expect(ov.getByTestId("overlay-idle").or(ov.getByTestId("overlay-queue"))).toBeVisible();

  // 다시 발급 → 새 주소, 이전 주소는 끊김
  await issueVia(page, "재발급");
  await expect(port).not.toHaveValue(first);
  const second = await port.inputValue();
  await ov.goto(first);
  await expect(ov.getByTestId("overlay-gone")).toBeVisible();
  await ov.goto(second);
  await expect(ov.getByTestId("overlay-gone")).toHaveCount(0);
  await expect(ov.getByTestId("overlay-idle").or(ov.getByTestId("overlay-queue"))).toBeVisible();
  await ov.close();

  // 발급 정보: 연결 상태 · 재발급 이력 · 접속 기록(없으면 안내)
  await expect(page.getByTestId("ovu-conn")).toBeVisible();
  await expect(page.getByTestId("ovu-reissues")).toContainText("재발급");
  await expect(page.getByTestId("ovu-accesses").or(page.getByTestId("ovu-ac-empty"))).toBeVisible();
  await shot(page, "SA-052-info");
});

test("발급 결과가 불분명하면 주소를 보이지 않고 이전 주소가 끊겼을 수 있다고 알린다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/overlay/address");
  await page.route("**/api/seller/overlay/token", (r) => r.abort("connectionreset"));
  await issueVia(page, "주소 만들기");
  await expect(page.getByTestId("ovu-unclear")).toContainText("새 주소를 만들었는지 확인하지 못했습니다");
  await expect(page.getByLabel("세로형 1080×1920 (9:16) 주소")).toHaveValue(/•/);
});

test("오버레이 편집 권한이 없는 직원: 메뉴가 없고 주소로 들어와도 화면이 없다", async ({ page }) => {
  await login(page, "demo-none@example.com", "/seller/overlay");
  await expect(page.getByText("필요한 권한: 오버레이 편집")).toBeVisible();
  await expect(page.getByRole("link", { name: "방송 화면 꾸미기" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: ISSUE })).toHaveCount(0);
});

test("이미 주소를 보던 중 재발급 결과가 불분명하면 이전 주소도 지운다(서버가 이미 끊었을 수 있음)", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/overlay/address");
  await issueVia(page, "주소 만들기");
  await expect(page.getByLabel("세로형 1080×1920 (9:16) 주소")).toHaveValue(/\/overlay\//);
  // 요청은 서버에 닿아 실제로 재발급되지만 응답은 5xx로 받는다
  await page.route("**/api/seller/overlay/token", async (r) => {
    await r.fetch();
    await r.fulfill({ status: 502, body: "{}" });
  });
  await issueVia(page, "재발급");
  await expect(page.getByTestId("ovu-unclear")).toContainText("이전 주소를 쓸 수 없을 수 있으니");
  await expect(page.getByLabel("세로형 1080×1920 (9:16) 주소")).toHaveValue(/•/);
  await expect(page.getByRole("button", { name: "복사" }).first()).toBeDisabled();
});
