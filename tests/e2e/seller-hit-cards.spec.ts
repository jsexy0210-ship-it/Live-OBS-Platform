import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-053 HIT 카드 이력: 메뉴에서 들어가 등록·기간 조회·해제까지 실제 API(/api/seller/hit-cards)로 처리된다.
// 권한이 없는 직원은 메뉴와 화면이 없다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page, email: string, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

test("대표자: 메뉴에서 들어가 HIT 카드를 등록하고, 기간으로 걸러 보고, 해제한다", async ({ page }) => {
  const card = `e2e-card-${Date.now()}`;
  await login(page, "demo-owner@example.com", "/seller/products");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "방송", exact: true }).click();
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "HIT 카드 이력" }).click();
  await expect(page).toHaveURL(/\/seller\/hit-cards$/);

  // 등록: 필수 칸이 비면 등록 버튼이 꺼져 있다
  await page.getByRole("button", { name: "HIT 카드 등록" }).click();
  const add = page.getByRole("dialog", { name: "HIT 카드 등록" });
  await expect(add.getByRole("button", { name: "등록" })).toBeDisabled();
  await add.getByLabel("카드 이름").fill(card);
  await add.getByLabel("구매자 닉네임").fill("hit-e2e-buyer");
  await add.getByLabel("메모").fill("e2e 메모");
  await add.getByRole("button", { name: "등록" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.getByTestId("hit-list").locator("tr", { hasText: card });
  await expect(row).toContainText("hit-e2e-buyer");
  await expect(row).toContainText("e2e 메모");
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-053-1440.png", fullPage: true });

  // 기간: 과거 하루만 고르면 방금 등록한 카드는 없다. 잘못된 기간(시작 > 끝)은 조회하지 않는다
  await page.getByLabel("시작일").fill("2020-01-01");
  await page.getByLabel("종료일").fill("2020-01-02");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByTestId("hit-empty")).toContainText("조건에 맞는 HIT 카드가 없습니다");
  await page.getByLabel("시작일").fill("2020-02-01");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByText("조회 기간의 시작일이 끝일보다 늦습니다")).toBeVisible();
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(row).toBeVisible();

  // 해제: 확인 창에서 닫으면 그대로, 해제하면 사라진다
  await row.getByRole("button", { name: "해제" }).click();
  const del = page.getByRole("dialog", { name: "HIT 카드를 해제하시겠습니까?" });
  await del.getByRole("button", { name: "닫기" }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "해제" }).click();
  await page.getByRole("dialog", { name: "HIT 카드를 해제하시겠습니까?" }).getByRole("button", { name: "해제" }).click();
  await expect(row).toHaveCount(0);
});

test("방송 진행 권한이 없는 직원: 메뉴가 없고 주소로 들어와도 화면이 없다", async ({ page }) => {
  await login(page, "demo-none@example.com", "/seller/hit-cards");
  await expect(page.getByText("필요한 권한: 방송 진행")).toBeVisible();
  await expect(page.getByRole("link", { name: "HIT 카드 이력" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "HIT 카드 등록" })).toHaveCount(0);
});
