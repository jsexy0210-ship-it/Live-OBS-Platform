import { expect, test, type Page } from "@playwright/test";
import { addFillerProducts, removeFillerProducts } from "./cartDb";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { png } from "../unit/shopContentFixtures";

// SH-002 숫자 페이저 · 목록 끝 안내 · 정렬 드롭다운: 고유 소유 쇼핑몰의 28개 상품을 세 쪽으로 확인하고 정리한다.
const SLUG = `list-ten-${randomBytes(5).toString("hex")}`;
let db: PrismaClient;
let sellerId: string | undefined;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const seller = await db.seller.create({ data: { slug: SLUG, shopName: "상품 목록 검수", status: "ACTIVE", approvedAt: new Date(), trialEndsAt: new Date(Date.now() + 10 * 86_400_000) } });
  sellerId = seller.id;
  await addFillerProducts(SLUG, 28); // 소유 tenant만 28개 → 10·10·8개, 세 쪽
});
test.afterAll(async () => {
  try {
    if (sellerId) {
      await removeFillerProducts(SLUG);
      await db.seller.delete({ where: { id: sellerId } });
    }
  } finally { await db?.$disconnect(); }
});

async function capture(page: Page, name: string) {
  const sha = process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const folder = `tests/e2e/screenshots/current-shell-${sha}`;
  await mkdir(folder, { recursive: true });
  const metrics = await page.evaluate(() => {
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    return { url: location.pathname + location.search, innerWidth, innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null, scrollWidth: document.documentElement.scrollWidth,
      heading: document.querySelector("#list-title")?.textContent, cards: Array.from(document.querySelectorAll(".pc")).map(el => ({ name: el.querySelector(".pc-name")?.textContent, price: el.querySelector(".pc-price")?.textContent, ...rect(el) })) };
  });
  await writeFile(`${folder}/SH-002-${name}.json`, JSON.stringify({ sha, role: "anonymous buyer", tenant: SLUG, state: name, browserZoom: "unverified", ...metrics }, null, 2));
  await page.screenshot({ path: `tests/e2e/screenshots/SH-002-${name}.png` });
}

for (const vp of [
  { name: "1440", w: 1440, h: 900 },
  { name: "1024", w: 1024, h: 800 },
  { name: "390", w: 390, h: 844 },
]) {
  test(`${vp.name}: 숫자 페이저 · 목록 끝 · 정렬 드롭다운`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    try {
    await page.goto(`/shop/${SLUG}/products`);
    const apiResponse = await page.request.get(`/api/shop/${SLUG}/products`);
    expect(apiResponse.status()).toBe(200);
    const api = await apiResponse.json() as { products: { id: string; name: string }[]; total: number; page: number; hasMore: boolean };
    expect(api).toMatchObject({ total: 28, page: 1, hasMore: true });
    expect(api.products).toHaveLength(10);
    await expect(page.locator(".pc .pc-name")).toHaveText(api.products.map(p => p.name));
    await expect(page.locator(".pc-photo [role=img]")).toHaveCount(10);
    const pager = page.getByRole("navigation", { name: "쪽 이동" });
    await expect(pager.getByRole("link", { name: "1페이지" })).toHaveAttribute("aria-current", "page");
    await expect(pager.getByRole("link", { name: "2페이지" })).toBeVisible();
    await expect(pager.getByRole("link", { name: "3페이지" })).toBeVisible();
    await expect(pager.getByRole("link", { name: "다음", exact: true })).toBeVisible();
    await expect(pager.getByRole("button", { name: "처음", exact: true })).toBeDisabled();
    await expect(pager.getByRole("link", { name: "마지막", exact: true })).toBeVisible();
    await expect(page.getByText("상품을 모두 봤어요")).toHaveCount(0); // 첫 쪽에는 끝 안내 없음
    // 정렬 드롭다운 열린 상태
    await page.getByRole("navigation", { name: "정렬" }).locator("summary").click();
    await expect(page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    await capture(page, `list-p1-sort-open-${vp.name}`);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" })).toBeHidden(); // Esc로 닫힘
    await page.getByRole("navigation", { name: "정렬" }).locator("summary").click();
    await page.getByRole("heading", { name: /전체 상품/ }).click(); // 바깥을 누르면 닫힘
    await expect(page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" })).toBeHidden();
    await page.getByRole("navigation", { name: "정렬" }).locator("summary").click(); // 연 채로 쪽을 옮겨도 새 쪽에서는 닫혀 있다
    // 중간 쪽도 10개, 끝 쪽은 8개
    await pager.getByRole("link", { name: "2페이지" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByRole("navigation", { name: "쪽 이동" }).getByRole("link", { name: "2페이지" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".pc")).toHaveCount(10);
    const second = await page.request.get(`/api/shop/${SLUG}/products?page=2`);
    expect(second.status()).toBe(200);
    const secondPage = await second.json() as typeof api;
    expect(secondPage).toMatchObject({ total: 28, page: 2, hasMore: true });
    await expect(page.locator(".pc .pc-name")).toHaveText(secondPage.products.map(p => p.name));
    await expect(pager.getByRole("link", { name: "이전", exact: true })).toHaveAttribute("href", `/shop/${SLUG}/products`);
    await expect(pager.getByRole("link", { name: "다음", exact: true })).toHaveAttribute("href", `/shop/${SLUG}/products?page=3`);
    await pager.getByRole("link", { name: "마지막", exact: true }).click();
    await expect(page).toHaveURL(/page=3/);
    await expect(page.locator(".pc")).toHaveCount(8);
    const last = await page.request.get(`/api/shop/${SLUG}/products?page=3`);
    expect(last.status()).toBe(200);
    const lastPage = await last.json() as typeof api;
    expect(lastPage).toMatchObject({ total: 28, page: 3, hasMore: false });
    await expect(page.locator(".pc .pc-name")).toHaveText(lastPage.products.map(p => p.name));
    await expect(pager.getByRole("link", { name: "3페이지" })).toHaveAttribute("aria-current", "page");
    await expect(pager.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
    await expect(pager.getByRole("button", { name: "마지막", exact: true })).toBeDisabled();
    await expect(page.getByRole("navigation", { name: "정렬" }).getByRole("link", { name: "높은 가격" })).toBeHidden();
    await expect(page.getByText("상품을 모두 봤어요 · 28개")).toBeVisible();
    await expect(page.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", `/shop/${SLUG}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // 링크 모양 보조 버튼은 마우스를 올려도 글자가 보인다(예전에는 흰 글자로 바뀌어 사라졌음)
    const home = page.getByRole("link", { name: "홈으로" });
    await home.hover();
    expect(await home.evaluate((el) => getComputedStyle(el).color)).not.toBe("rgb(255, 255, 255)");
    await page.goto(`/shop/${SLUG}/products?page=3`); // 증거 캡처는 주소로 바로 열어 찍는다(쪽 이동 직후에는 새로 쓰인 글자의 글꼴 조각이 늦게 받아져 일부 글자가 비어 찍힘)
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // 끝까지 내려 아래 고정 바에 가린 것이 없는지 본다
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    await page.locator(".onq-pagination").locator("xpath=..").locator(".shop-listend").screenshot({ path: `tests/e2e/screenshots/SH-002-list-end-note-${vp.name}.png` }); // 목록 끝 안내만 따로(보이는 화면 캡처에서는 이 버튼 글자가 비어 찍혀 요소 캡처를 함께 둔다)
    await page.waitForTimeout(300);
    await capture(page, `list-p2-end-${vp.name}`); // 원래 끝 쪽 캡처 이름을 보존한다
    } catch (error) {
      try { await capture(page, `failure-${vp.name}`); } catch { /* 최초 오류를 보존한다 */ }
      throw error;
    }
  });
}

test("검색도 10개씩 이동하며 상품명 alt·이미지 실패 fallback·빈 결과 접근성을 유지한다", async ({ page }) => {
  test.setTimeout(60_000);
  const product = await db.product.findFirstOrThrow({ where: { sellerId, name: "채움상품 01" } });
  const imageBytes = png(200, 200);
  const image = await db.productImage.create({ data: { sellerId: product.sellerId, productId: product.id, storageKey: `list-ten-${product.id}`, contentType: "image/png", byteSize: imageBytes.length, width: 200, height: 200, sha256: "0".repeat(64), thumbnail: true } });
  const path = `/api/shop/${SLUG}/products/${product.id}/images/${image.id}`;
  try {
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "image/png", body: imageBytes }));
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`/shop/${SLUG}/search?q=${encodeURIComponent("채움상품")}&sort=low`);
      await expect(page.locator(".pc")).toHaveCount(10);
      const loaded = page.getByRole("img", { name: "채움상품 01", exact: true });
      await expect(loaded).toBeVisible();
      await expect.poll(() => loaded.evaluate(el => el instanceof HTMLImageElement && el.complete && el.naturalWidth === 200)).toBe(true);
      const pager = page.getByRole("navigation", { name: "쪽 이동" });
      await expect(pager.getByRole("link", { name: "다음", exact: true })).toHaveAttribute("href", `/shop/${SLUG}/search?q=${encodeURIComponent("채움상품")}&sort=low&page=2`);
      await capture(page, `search-first-${width}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await pager.getByRole("link", { name: "다음", exact: true }).click();
      await expect(page).toHaveURL(/sort=low&page=2$/);
      await expect(page.locator(".pc")).toHaveCount(10);
    }
    await page.unroute(`**${path}*`);
    await page.route(`**${path}*`, route => route.fulfill({ status: 404 }));
    await page.goto(`/shop/${SLUG}/search?q=${encodeURIComponent("채움상품")}&sort=low`);
    await expect(page.getByRole("img", { name: "채움상품 01 상품 이미지 없음", exact: true })).toBeVisible();
    await expect(page.locator(".pc-photo img")).toHaveCount(0);
    await page.goto(`/shop/${SLUG}/search?q=${encodeURIComponent("없는 검색어")}`);
    await expect(page.getByRole("status")).toHaveText("찾는 상품이 없어요. 다른 검색어로 찾아보세요.");
    await expect(page.locator(".pc")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "쪽 이동" })).toHaveCount(0);
    await capture(page, "search-empty-390");
  } catch (error) {
    try { await capture(page, "search-failure"); } catch { /* 최초 오류를 보존한다 */ }
    throw error;
  } finally { await db.productImage.delete({ where: { id: image.id } }); }
});
