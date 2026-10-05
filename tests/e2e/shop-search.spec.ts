import { expect, test } from "@playwright/test";

// IA ⑥ 검색: 자동완성 → 검색, 최근 검색어(이 기기)·삭제, 인기 검색어(결과가 나온 검색어만 센다). 데모 시드 상품 이름에 「박스」가 들어간다.
const SLUG = "demo-shop";

test("검색 화면: 자동완성으로 검색 → 최근·인기 검색어에 남고 삭제할 수 있다", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/search`);
  await expect(page.getByRole("heading", { name: "최근 검색어" })).toHaveCount(0); // 처음에는 없음

  const box = page.getByRole("combobox", { name: "검색어" });
  await box.fill("박스");
  const list = page.getByRole("listbox", { name: "검색어 추천" });
  await expect(list).toBeVisible();
  const first = list.getByRole("option").first();
  const term = ((await first.locator("span").innerText()) ?? "").trim();
  expect(term.length).toBeGreaterThan(0);
  await first.getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${encodeURIComponent(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.getByRole("heading", { name: `‘${term}’ 검색 결과` })).toBeVisible();

  // 검색어 없는 화면: 최근 검색어와 인기 검색어
  await page.goto(`/shop/${SLUG}/search`);
  const recent = page.getByRole("region", { name: "최근 검색어" });
  await expect(recent.getByRole("link", { name: term, exact: true })).toBeVisible();
  const popular = page.getByRole("region", { name: "인기 검색어" });
  await expect(popular.getByRole("link", { name: new RegExp(term) })).toBeVisible();

  await recent.getByRole("button", { name: `${term} 삭제` }).click();
  await expect(page.getByRole("heading", { name: "최근 검색어" })).toHaveCount(0);

  // 직접 입력해 검색 → 다시 최근 검색어에 남고 「전체 삭제」로 비운다
  await page.getByRole("combobox", { name: "검색어" }).fill("부스터");
  await page.getByRole("search").filter({ has: page.getByRole("combobox") }).getByRole("button", { name: "검색" }).click();
  await expect(page).toHaveURL(/q=%EB%B6%80%EC%8A%A4%ED%84%B0$/);
  await page.goto(`/shop/${SLUG}/search`);
  await expect(page.getByRole("region", { name: "최근 검색어" }).getByRole("link", { name: "부스터", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "전체 삭제" }).click();
  await expect(page.getByRole("heading", { name: "최근 검색어" })).toHaveCount(0);
});

test("자동완성은 키보드로 고를 수 있고 Esc로 닫힌다", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/search`);
  const box = page.getByRole("combobox", { name: "검색어" });
  await box.fill("박스");
  const list = page.getByRole("listbox", { name: "검색어 추천" });
  await expect(list).toBeVisible();
  await box.press("ArrowDown");
  await expect(list.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await box.press("Escape");
  await expect(list).toHaveCount(0);
});
