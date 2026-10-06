import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-053 HIT 카드 기록: 메뉴에서 들어가 등록·기간 조회·해제까지 실제 API(/api/seller/hit-cards)로 처리된다.
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
  // 새 메뉴: 왼쪽 「방송 기록」(방송별 · HIT 카드 화면 탭)에서 HIT 카드 탭으로 간다
  await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "방송 기록" }).click();
  await page.getByRole("navigation", { name: "화면 탭" }).getByRole("link", { name: "HIT 카드" }).click();
  await expect(page).toHaveURL(/\/seller\/hit-cards$/);

  // 등록: 대상 주문이 없으면 「직접 입력」(닉네임을 적음). 필수 칸이 비면 등록 버튼이 꺼져 있다
  await page.getByRole("button", { name: "HIT 카드 기록하기" }).click();
  const add = page.getByRole("dialog", { name: "HIT 카드 기록하기" });
  await expect(add.getByRole("button", { name: "HIT 카드 기록하기" })).toBeDisabled();
  await add.getByLabel("카드명").fill(card);
  await add.getByLabel("구매자 닉네임").fill("hit-e2e-buyer");
  // 등급은 자유 입력(추천 값 SAR·SR·UR·SE·SP·AA는 목록으로 제안): 목록에 없는 「L-P」도 받는다
  await expect(add.locator("datalist#hit-grade-list option")).toHaveCount(6);
  await add.getByLabel("등급").fill("L-P");
  await add.getByLabel("메모").fill("e2e 메모");
  await add.getByRole("button", { name: "HIT 카드 기록하기" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.getByTestId("hit-list").locator("tr", { hasText: card });
  await expect(row).toContainText("hit-e2e-buyer");
  await expect(row).toContainText("e2e 메모");
  await expect(row.getByTestId("hit-grade")).toHaveText("L-P");
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-053-1440.png", fullPage: true });

  // 등급 필터: 다른 등급이면 안 보이고, 같은 등급(자유 입력 값 포함)이면 보인다
  await expect(page.locator("datalist#hit-grade-filter-list option")).toHaveCount(6);
  await page.getByRole("combobox", { name: "등급" }).fill("UR");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByTestId("hit-empty")).toContainText("조건에 맞는 HIT 카드가 없습니다");
  await page.getByRole("combobox", { name: "등급" }).fill("L-P");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "초기화" }).click();
  await expect.poll(() => new URL(page.url()).search).toBe(""); // 주소가 깨끗해진 뒤(입력 칸 동기화 뒤) 다음 입력을 한다
  await expect(row).toBeVisible();

  // 기간: 과거 하루만 고르면 방금 등록한 카드는 없다. 잘못된 기간(시작 > 끝)은 조회하지 않는다
  await page.getByLabel("시작일").fill("2020-01-01");
  await page.getByLabel("종료일").fill("2020-01-02");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByTestId("hit-empty")).toContainText("조건에 맞는 HIT 카드가 없습니다");
  await page.getByLabel("시작일").fill("2020-02-01");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByText("시작일을 끝일보다 앞 날짜로 바꿔 주십시오")).toBeVisible();
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(row).toBeVisible();

  // 해제: 확인 창에서 닫으면 그대로, 해제하면 사라진다
  await row.getByRole("button", { name: "카드 지우기" }).click();
  const del = page.getByRole("dialog", { name: "이 HIT 카드를 지우시겠습니까?" });
  await del.getByRole("button", { name: "취소" }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "카드 지우기" }).click();
  await page.getByRole("dialog", { name: "이 HIT 카드를 지우시겠습니까?" }).getByRole("button", { name: "카드 지우기" }).click();
  await expect(row).toHaveCount(0);
});

test("방송 진행 권한이 없는 직원: 메뉴가 없고 주소로 들어와도 화면이 없다", async ({ page }) => {
  await login(page, "demo-none@example.com", "/seller/hit-cards");
  await expect(page.getByText("필요한 권한: 방송 진행")).toBeVisible();
  await expect(page.getByRole("link", { name: "방송 기록" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "HIT 카드 기록하기" })).toHaveCount(0);
});

// 열 순서(카드 → 일시 → …)·기본 기간 최근 1개월 뒤에도 1440·1024·390폭에서 가로로 넘치지 않는다(캡처는 E2E_SCREENSHOTS=1)
test("HIT 카드 기록: 1440·1024·390폭에서 가로로 넘치지 않고 기본 기간이 채워져 있다", async ({ page }) => {
  await login(page, "demo-owner@example.com", "/seller/hit-cards");
  await expect(page.getByLabel("시작일")).toHaveValue(/^\d{4}\.\d{2}\.\d{2}$/);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(600); // 좁은 폭에서 메뉴 서랍이 접히는 전환이 끝난 뒤 잰다
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sx: window.scrollX }));
    expect(doc.sw, `${width}px 문서 너비`).toBe(width);
    expect(doc.sx).toBe(0);
    if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/SA-053-list-${width}.png`, fullPage: true });
  }
});
