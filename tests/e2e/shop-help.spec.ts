import { expect, test } from "@playwright/test";
import { setUsageGuide } from "./cartDb";
import { resetNoticesInDb } from "./noticeDb";

// SH-030 고객센터(공지·자주 묻는 질문)·홈 고정 공지 띠(운영 빌드 + 데모 시드). 로그인 없이 보이는 화면이라 구매자 로그인은 쓰지 않는다.
const SLUG = "demo-shop";

test.beforeAll(() => resetNoticesInDb(SLUG, true));
test.afterAll(() => resetNoticesInDb(SLUG, false));

test("홈: 고정 공지 띠가 공지 상세로 이어진다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}`);
  const band = page.locator(".shop-ntc");
  await expect(band).toContainText("공지");
  await expect(band).toContainText("10/3 (토) 20시 문라이트 브레이크 방송해요");
  await band.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/help/notices/[0-9a-f-]+$`));
  const article = page.locator("article");
  await expect(article.getByRole("heading", { level: 2 })).toContainText("문라이트 브레이크");
  await expect(article).toContainText("고정");
  expect(await article.locator(".help-body").evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap"); // 글자 그대로(줄바꿈 유지)
  await expect(article).toContainText("미리 주문하면 방송에서 먼저 열어 드려요.");
  await page.screenshot({ path: "tests/e2e/screenshots/SH-030-notice-1440.png", fullPage: true });
  await page.getByRole("link", { name: "목록으로" }).click();
  await expect(page).toHaveURL(new RegExp(`/shop/${SLUG}/help$`));
});

test("고객센터: 공지 표(열 제목·값 왼쪽)·비공개 공지 숨김, 자주 묻는 질문 분류·검색·펼치기", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/shop/${SLUG}/help`);
  await expect(page.getByRole("heading", { name: "공지 · 이용안내", level: 1 })).toBeVisible();
  const rows = page.locator(".help-tbl tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator(".c-date")).toHaveText(/^\d{4}\.\d{2}\.\d{2}$/);
  await expect(page.getByText("비공개 공지는 보이지 않아요")).toHaveCount(0);
  await expect(rows.first()).toContainText("고정"); // 고정 공지가 먼저
  expect(await page.locator(".help-tbl th").first().evaluate((el) => getComputedStyle(el).textAlign)).toBe("center");
  expect(await rows.first().locator("td").first().evaluate((el) => getComputedStyle(el).textAlign)).toBe("left");
  await page.screenshot({ path: "tests/e2e/screenshots/SH-030-help-1440.png", fullPage: true });

  await page.getByRole("tab", { name: "자주 묻는 질문" }).click();
  const faqs = page.locator(".help-faq");
  await expect(faqs).toHaveCount(2);
  await page.getByRole("button", { name: "결제", exact: true }).click();
  await expect(faqs).toHaveCount(1);
  await expect(faqs).toContainText("무통장 입금");
  await page.getByRole("button", { name: "전체" }).click();
  await faqs.first().locator("summary").click();
  await expect(faqs.first()).toContainText("개봉이 끝난 뒤 2영업일 안에 보내요.");
  await page.getByLabel("자주 묻는 질문 검색").fill("입");
  await page.locator(".help-search").getByRole("button", { name: "검색" }).click();
  await expect(page.getByText("두 글자 이상 적어 주세요")).toBeVisible();
  await page.getByLabel("자주 묻는 질문 검색").fill("무통장");
  await page.locator(".help-search").getByRole("button", { name: "검색" }).click();
  await expect(faqs).toHaveCount(1);
  await page.getByLabel("자주 묻는 질문 검색").fill("없는내용");
  await page.locator(".help-search").getByRole("button", { name: "검색" }).click();
  await expect(page.getByRole("heading", { name: "맞는 질문이 없어요" })).toBeVisible();
});

test("휴대폰 390: 가로 스크롤 없음, 없는 공지는 안내", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/shop/${SLUG}/help`);
  await expect(page.locator(".help-tbl tbody tr")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto(`/shop/${SLUG}/help/notices/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByText("찾을 수 없는 공지예요.")).toBeVisible();
});

// 이용안내 탭: 파트너스가 쓴 안내 글을 줄바꿈 그대로, 없으면 빈 상태(보드 SH-030 v320).
test("고객센터 이용안내 탭: 글은 줄바꿈 그대로, 없으면 빈 상태", async ({ page }) => {
  const prev = await setUsageGuide(SLUG, "주문 · 방송\n결제가 끝난 순서대로 방송에서 열어요.\n\n배송\n개봉이 끝난 뒤 2영업일 안에 보내요.");
  try {
    await page.goto(`/shop/${SLUG}/help`);
    await expect(page.getByRole("tab")).toHaveText(["공지", "이용안내", "자주 묻는 질문"]);
    await page.getByRole("tab", { name: "이용안내" }).click();
    const guide = page.locator(".help-guide");
    await expect(guide).toContainText("결제가 끝난 순서대로 방송에서 열어요.");
    expect(await guide.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
    await page.screenshot({ path: "tests/e2e/screenshots/SH-030-guide-1440.png" });
    await setUsageGuide(SLUG, null);
    await page.goto(`/shop/${SLUG}/help`);
    await page.getByRole("tab", { name: "이용안내" }).click();
    await expect(page.getByRole("heading", { name: "아직 이용안내가 없어요" })).toBeVisible();
  } finally {
    await setUsageGuide(SLUG, prev);
  }
});

test("휴대폰 390: 이용안내 탭 가로 스크롤 없음", async ({ page }) => {
  const prev = await setUsageGuide(SLUG, "배송\n" + "긴안내문".repeat(40));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/shop/${SLUG}/help`);
    await page.getByRole("tab", { name: "이용안내" }).click();
    await expect(page.locator(".help-guide")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "tests/e2e/screenshots/SH-030-guide-390.png" });
  } finally {
    await setUsageGuide(SLUG, prev);
  }
});
