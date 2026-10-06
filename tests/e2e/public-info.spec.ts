import { expect, test } from "@playwright/test";

// PF-002 기능 안내 · PF-003 요금 안내 · PF-004 자주 묻는 질문 (로그인 없이 열린다)
test("기능 안내가 열리고 머리에서 현재 메뉴가 표시된다", async ({ page }) => {
  await page.goto("/features");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("기능 안내");
  await expect(page.getByRole("heading", { name: "OBS 방송 화면" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "주요 메뉴" }).getByRole("link", { name: "기능" })).toHaveAttribute("aria-current", "page");
});

// 요금은 서버 요금제 값이다. E2E_PLAN_PRICE가 있으면(시험 DB 값) 그 금액이 화면에 보이는지도 확인한다.
test("요금 안내는 서버 요금제 값을 보여 주거나 불러오지 못했다고 알린다", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("요금");
  const plans = page.locator("[data-plan]");
  if ((await plans.count()) > 0) {
    await expect(plans.first()).toContainText(/\d{1,3}(,\d{3})*원/);
    const price = process.env.E2E_PLAN_PRICE;
    if (price) await expect(page.locator('[data-plan="OVERLAY_ONLY"]')).toContainText(price);
  } else {
    await expect(page.getByRole("status")).toContainText("불러오지 못했어요");
  }
});

test("자주 묻는 질문은 분류와 검색으로 좁혀진다", async ({ page }) => {
  await page.goto("/faq");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("자주 묻는 질문");
  const all = await page.locator("details").count();
  await page.getByRole("button", { name: "적립금" }).click();
  await expect(page.locator("details")).toHaveCount(1);
  await page.getByRole("button", { name: "전체" }).click();
  await expect(page.locator("details")).toHaveCount(all);
  await page.getByLabel("질문 검색").fill("도메인");
  await expect(page.locator("details")).toHaveCount(1);
  await page.getByLabel("질문 검색").fill("없는말없는말");
  await expect(page.getByRole("status")).toContainText("맞는 질문이 없어요");
});
