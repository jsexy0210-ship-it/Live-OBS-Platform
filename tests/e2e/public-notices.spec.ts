import { expect, test } from "@playwright/test";
import { cleanupPublicNoticePagesInDb, seedPublicNoticePagesInDb } from "./platformDb";

// PF-005·006 공개 공지 UI. 데이터는 폐기용 E2E DB에만 준비하고 종료 뒤 정리한다.
let fixture: Awaited<ReturnType<typeof seedPublicNoticePagesInDb>>;
test.beforeAll(async () => {
  fixture = await seedPublicNoticePagesInDb();
});
test.afterAll(async () => {
  await cleanupPublicNoticePagesInDb();
});

test("공지 목록은 고정·첫·중간·마지막 페이지를 구분하고 숨겨진 글을 제외한다", async ({ page }) => {
  await page.goto("/notices");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("공지");
  await expect(page.getByRole("navigation", { name: "주요 메뉴" }).getByRole("link", { name: "공지" })).toHaveAttribute("aria-current", "page");
  const rows = page.getByTestId("notices-list").getByRole("link");
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText("E2E-PF-PIN");
  await expect(rows.first()).toContainText("고정");
  const pager = page.getByRole("navigation", { name: "공지 페이지 이동" });
  await expect(pager.getByRole("link", { name: "1", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(pager.getByRole("link", { name: "2", exact: true })).toHaveAttribute("href", "/notices?page=2");
  for (const hidden of ["PARTNERS", "UNPUBLISHED", "DELETED", "FUTURE"]) await expect(page.getByText(`E2E-PF-${hidden}`)).toHaveCount(0);

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px notice list overflow`).toBe(true);
  }

  await pager.getByRole("link", { name: "2", exact: true }).click();
  await expect(page).toHaveURL(/\/notices\?page=2$/);
  await expect(page.getByTestId("notices-list").getByRole("link")).toHaveCount(5);
  await expect(page.getByText("E2E-PF-PIN")).toHaveCount(0);
  await page.getByRole("navigation", { name: "공지 페이지 이동" }).getByRole("link", { name: "3", exact: true }).click();
  await expect(page).toHaveURL(/\/notices\?page=3$/);
  await expect(page.getByTestId("notices-list").getByRole("link")).toHaveCount(1);
  await expect(page.getByTestId("notices-list")).toContainText("E2E-PF-MAINTENANCE-10");
});

test("분류·상세·브라우저 뒤로 가기가 원래 페이지 상태를 보존한다", async ({ page }) => {
  await page.goto("/notices?category=FEATURE");
  await expect(page.getByRole("link", { name: "새 기능" })).toHaveAttribute("aria-current", "true");
  const pager = page.getByRole("navigation", { name: "공지 페이지 이동" });
  await expect(pager.getByRole("link", { name: "2", exact: true })).toHaveAttribute("href", "/notices?category=FEATURE&page=2");
  await pager.getByRole("link", { name: "2", exact: true }).click();
  await expect(page).toHaveURL(/\/notices\?category=FEATURE&page=2$/);
  const row = page.getByTestId("notices-list").getByRole("link");
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E-PF-FEATURE-05");
  await expect(page.getByText("ONQ 운영팀")).toBeVisible();
  await expect(page.getByTestId("notice-body")).toContainText("첫 줄 5");
  const neighbors = page.getByRole("navigation", { name: "이전·다음 공지" });
  await expect(neighbors.getByRole("link", { name: /이전: E2E-PF-POLICY-06/ })).toHaveAttribute("href", /category=FEATURE&page=2/);
  await expect(neighbors.getByRole("link", { name: /다음: E2E-PF-FEATURE-04/ })).toHaveAttribute("href", /category=FEATURE&page=2/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "390px notice detail overflow").toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(/\/notices\?category=FEATURE&page=2$/);
  await expect(page.getByRole("link", { name: "새 기능" })).toHaveAttribute("aria-current", "true");

  await page.getByTestId("notices-list").getByRole("link").click();
  await page.getByRole("link", { name: "← 공지 목록" }).click();
  await expect(page).toHaveURL(/\/notices\?category=FEATURE&page=2$/);
});

test("공개 공지는 직접 열리고, 파트너스 전용·임시·삭제·미래 공지는 404다", async ({ page }) => {
  const visible = await page.goto(`/notices/${fixture.visibleIds[5]}`);
  expect(visible?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E-PF-FEATURE-05");
  for (const id of fixture.hiddenIds) {
    const res = await page.goto(`/notices/${id}`);
    expect(res?.status(), id).toBe(404);
  }
});
