import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { NICKS, cleanupBroadcastQueue, moveQueueOrdersToNow, purgeE2eHitCards, resetBroadcastQueue } from "./seller-broadcast-db";

// SA-054 방송 이력 · SA-055 방송 상세: 방송을 진행하고 끝낸 뒤 이력 목록에서 찾고, 상세에서 요약·HIT 카드·주문을 확인한다.
// 기간 검색, 없는 방송, 권한 없는 직원. 실제 API(/api/seller/broadcast/history·{id})를 부른다(폐기용 테스트 DB).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const [A, B] = NICKS;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
test.beforeEach(async () => resetBroadcastQueue());
const RUN_STARTED = new Date();
test.afterAll(async () => {
  await purgeE2eHitCards();
  await cleanupBroadcastQueue(RUN_STARTED);
});

async function login(page: Page, email: string, next: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}

test("방송을 끝낸 뒤 이력 목록에서 찾아 상세로 들어가 요약·HIT 카드·주문을 본다", async ({ page }) => {
  const title = `e2e-방송-${Date.now()}`;
  const card = `e2e-카드-${Date.now()}`;
  await login(page, "demo-owner@example.com", "/seller/broadcast");
  await page.getByLabel("방송 제목").fill(title);
  await page.getByRole("button", { name: "방송 시작" }).click();
  await expect(page.getByTestId("bc-live-badge")).toBeVisible();
  await moveQueueOrdersToNow([A, B]);

  // HIT 카드 등록(대상 주문이 개봉 중이 아니면 직접 입력)
  await page.locator("body").press("Control+h");
  const hit = page.getByRole("dialog", { name: "HIT 카드 기록하기" });
  await hit.getByLabel("카드를 받은 주문").selectOption({ label: "닉네임 직접 쓰기" });
  await hit.getByLabel("카드명").fill(card);
  await hit.getByLabel("구매자 닉네임").fill(A);
  await hit.getByRole("button", { name: "HIT 카드 기록하기" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 방송 종료
  await page.getByRole("button", { name: "방송 끝내기" }).click();
  await page.getByRole("dialog", { name: "방송을 끝내시겠습니까?" }).getByRole("button", { name: "방송 끝내기" }).click();
  await expect(page.getByTestId("bc-live-badge")).toHaveCount(0);

  // 메뉴로 이력 목록 → 방송 찾기
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("link", { name: "방송", exact: true }).click();
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "방송 이력" }).click();
  await expect(page).toHaveURL(/\/seller\/broadcasts$/);
  const row = page.getByTestId("bh-list").locator("tr", { hasText: title });
  await expect(row).toContainText("종료");
  await expect(row.locator("td").nth(3)).toHaveText("2");

  // 상세: 요약(주문 2건·HIT 1장), HIT 카드, 주문 2건
  await row.getByTestId("bh-link").click();
  await expect(page).toHaveURL(/\/seller\/broadcasts\/[0-9a-f-]+$/);
  await expect(page.getByTestId("bd-title")).toHaveText(title);
  await expect(page.getByTestId("bd-summary")).toContainText("2건");
  await expect(page.getByTestId("bd-summary")).toContainText("1장");
  await expect(page.getByTestId("bd-hits")).toContainText(card);
  await expect(page.getByTestId("bd-hits")).toContainText(A);
  await expect(page.getByTestId("bd-orders").locator("tr")).toHaveCount(2);
  await expect(page.getByTestId("bd-orders")).toContainText(B);
  await page.getByRole("link", { name: "목록" }).click();
  await expect(page).toHaveURL(/\/seller\/broadcasts$/);
});

test("기간으로 걸러 보고, 잘못된 기간은 조회하지 않으며, 없는 방송은 안내만 보인다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/broadcasts");
  await page.getByLabel("시작일").fill("2020-01-01");
  await page.getByLabel("종료일").fill("2020-01-02");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByTestId("bh-empty")).toContainText("조건에 맞는 방송이 없습니다");
  await page.getByLabel("시작일").fill("2020-02-01");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByText("시작일을 끝일보다 앞 날짜로 바꿔 주십시오")).toBeVisible();

  await page.goto("/seller/broadcasts/00000000-0000-4000-8000-000000000000");
  await expect(page.getByTestId("bd-notfound")).toContainText("방송을 찾을 수 없습니다");
});

test("방송 진행 권한이 없는 직원: 메뉴가 없고 주소로 들어와도 화면이 없다", async ({ page }) => {
  await login(page, "demo-none@example.com", "/seller/broadcasts");
  await expect(page.getByText("필요한 권한: 방송 진행")).toBeVisible();
  await expect(page.getByRole("link", { name: "방송 이력" })).toHaveCount(0);
});
