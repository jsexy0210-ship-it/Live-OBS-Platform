import { expect, test } from "@playwright/test";
import { pricingIntro } from "../../components/public/pricingCopy";

// /about은 서비스 소개(PF-001)다(루트 /는 로그인 이동 유지, 대표님 지시 2026-10-04). 로그인·가입 진입이 보인다.
test("/about은 서비스 소개가 열리고 로그인·가입 진입이 있다", async ({ page }) => {
  await page.goto("/about");
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("방송 화면에 줄이 서요");
  await page.getByRole("link", { name: "로그인" }).first().click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await expect(page.locator(".login-card")).toBeVisible();
});

test("PF-001 요금제 조회 실패에는 원인을 알려 주고 빈 이름 문구를 숨긴다", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { name: "요금", exact: true })).toBeVisible();
  const intro = page.getByTestId("pricing-intro");
  const message = (await intro.textContent())?.trim() ?? "";
  expect(message).not.toContain("두 가지 이용권 · 중에 골라요.");
  expect(["요금 정보를 불러오지 못했어요.", "지금 가입할 수 있는 이용권이 없어요."].includes(message) || /이용권 · .+ 중에 골라요\.|두 가지 이용권 · .+ 중에 골라요\./.test(message)).toBeTruthy();
});

test("PF-001 요금 안내 문구가 실제 이용권 이름이나 상태를 반영한다", () => {
  expect(pricingIntro(["쇼핑몰 통합", "오버레이 전용"], "available")).toBe("두 가지 이용권 · 쇼핑몰 통합과 오버레이 전용 중에 골라요.");
  expect(pricingIntro([], "error")).toBe("요금 정보를 불러오지 못했어요.");
  expect(pricingIntro([], "unavailable")).toBe("지금 가입할 수 있는 이용권이 없어요.");
});

test("PF-001 모바일 메뉴 링크에서 Escape를 누르면 초점을 메뉴 버튼으로 돌린다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/about");
  const menuButton = page.getByRole("button", { name: "메뉴" });
  await menuButton.press("Enter");
  const featureLink = page.getByRole("navigation", { name: "모바일 주요 메뉴" }).getByRole("link", { name: "기능", exact: true });
  await featureLink.focus();
  await expect(featureLink).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "모바일 주요 메뉴" })).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  await expect(page).toHaveURL(/\/about$/);
});

test("서비스 소개의 가입 신청은 파트너스 가입으로 간다", async ({ page }) => {
  await page.goto("/about");
  await page.getByRole("link", { name: "파트너스 가입 신청" }).first().click();
  await expect(page).toHaveURL(/\/seller\/signup/);
});

test("PF-001 정본은 세 화면 폭과 모바일 메뉴를 지원한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/about");
  await page.screenshot({ path: "tests/e2e/screenshots/PF-001-1440.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: "tests/e2e/screenshots/PF-001-1024.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "tests/e2e/screenshots/PF-001-390.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", { name: "메뉴" })).toBeVisible();
  await expect(page.getByRole("link", { name: "파트너스 가입 신청" }).first()).toBeVisible();

  const menuButton = page.getByRole("button", { name: "메뉴" });
  await menuButton.press("Enter");
  await expect(page.getByRole("navigation", { name: "모바일 주요 메뉴" })).toBeVisible();
  await menuButton.press("Escape");
  await expect(page.getByRole("navigation", { name: "모바일 주요 메뉴" })).toHaveCount(0);
  await menuButton.press("Enter");
  await page.getByRole("navigation", { name: "모바일 주요 메뉴" }).getByRole("link", { name: "기능", exact: true }).click();
  await expect(page).toHaveURL(/\/features$/);
});

test("PF-007-1은 정본 헤더와 모바일 메뉴를 유지한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/signup");
  await expect(page.getByTestId("signup-step-count")).toHaveText("1 / 5");
  await page.screenshot({ path: "tests/e2e/screenshots/PF-007-1-1440.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: "tests/e2e/screenshots/PF-007-1-1024.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "tests/e2e/screenshots/PF-007-1-390.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", { name: "메뉴" })).toBeVisible();
  await expect(page.locator('.pf-head-r a[href="/seller/signup"]')).toBeHidden();

  const menuButton = page.getByRole("button", { name: "메뉴" });
  await menuButton.press("Enter");
  await expect(page.getByRole("navigation", { name: "모바일 주요 메뉴" })).toBeVisible();
  await menuButton.press("Escape");
  await expect(page.getByRole("navigation", { name: "모바일 주요 메뉴" })).toHaveCount(0);
});
