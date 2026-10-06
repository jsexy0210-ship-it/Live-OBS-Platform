import { expect, test } from "@playwright/test";

// PF-005·006 공지: 목록은 공지가 없거나 불러오지 못해도 화면이 열리고, 없는 공지는 공통 404다.
test("공지 목록이 열리고 머리에서 현재 메뉴가 표시된다", async ({ page }) => {
  await page.goto("/notices");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("공지");
  await expect(page.getByRole("navigation", { name: "주요 메뉴" }).getByRole("link", { name: "공지" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("notices-list").or(page.getByTestId("notices-empty")).or(page.getByTestId("notices-failed"))).toBeVisible();
});

test("없는 공지는 공통 404를 보여 준다", async ({ page }) => {
  const res = await page.goto("/notices/00000000-0000-4000-8000-000000000000");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("페이지를 찾을 수 없어요");
});

// 시험 DB에 공지를 넣고 돌릴 때만 확인한다(E2E_NOTICE_SEED=1): 고정 공지가 맨 위, 파트너스 전용·임시 저장은 보이지 않고, 상세는 줄바꿈이 살아 있다.
test("게시된 공개 공지만 보이고 상세가 열린다", async ({ page }) => {
  test.skip(!process.env.E2E_NOTICE_SEED, "시험 DB에 공지를 넣은 경우에만 실행");
  await page.goto("/notices");
  const rows = page.getByTestId("notices-list").getByRole("link");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("고정");
  await expect(rows.first()).toContainText("고정 점검 안내");
  await expect(page.getByText("파트너스 전용 공지")).toHaveCount(0);
  await expect(page.getByText("임시 저장 공지")).toHaveCount(0);
  await rows.first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("고정 점검 안내");
  await expect(page.getByTestId("notice-body")).toContainText("점검 중에는 쇼핑몰을 이용할 수 없어요.");
  await expect(page.getByRole("link", { name: "목록으로" })).toBeVisible();
  for (const id of ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"]) {
    const res = await page.goto(`/notices/${id}`);
    expect(res?.status(), id).toBe(404);
  }
});
