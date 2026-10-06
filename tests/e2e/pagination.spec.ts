import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let server: Server, origin: string, dir: string;
test.use({ channel: "chrome" });
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "onq-pagination-"));
  await build({ entryPoints: ["tests/e2e/fixtures/pagination.tsx"], outfile: join(dir, "fixture.js"), bundle: true, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  server = createServer((req, res) => {
    const file = req.url === "/fixture.js" || req.url === "/fixture.css" ? join(dir, req.url.slice(1)) : ["/tokens.css", "/lop.css", "/seller.css", "/shop.css"].includes(req.url!) ? `styles${req.url}` : null;
    if (file) { res.setHeader("Content-Type", req.url!.endsWith(".css") ? "text/css" : "text/javascript"); res.end(readFileSync(file)); }
    else res.end('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/lop.css"><link rel="stylesheet" href="/seller.css"><link rel="stylesheet" href="/shop.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true }); });
for (const width of [1440, 1024, 390]) {
  test(`total boundaries and geometry ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto(origin);
    const nav = page.getByRole("region", { name: "전체 건수" });
    await expect(nav.getByRole("button", { name: "처음", exact: true })).toBeDisabled();
    await nav.getByRole("button", { name: "마지막", exact: true }).click();
    await expect(nav.locator('[aria-current="page"]')).toHaveText("23");
    await expect(nav.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
    await nav.getByRole("button", { name: "처음", exact: true }).click();
    await nav.getByRole("button", { name: "다음", exact: true }).click();
    await expect(nav.locator('[aria-current="page"]')).toHaveText("2");
    const m = await nav.locator(".onq-pagination").evaluate(el => {
      const controls = [...el.querySelectorAll<HTMLElement>(".onq-page-control")].filter(e => getComputedStyle(e).display !== "none");
      const r = el.getBoundingClientRect();
      return { heights: controls.map(e => e.getBoundingClientRect().height), overflow: controls.some(e => { const b = e.getBoundingClientRect(); return b.left < r.left || b.right > r.right; }), margins: controls.map(e => getComputedStyle(e).marginLeft), gap: [...el.children].map(e => getComputedStyle(e).gap) };
    });
    expect(m.heights, JSON.stringify(m)).toEqual(Array(m.heights.length).fill(width < 768 ? 44 : 40)); expect(m.heights.every(h => h === (width < 768 ? 44 : 40))).toBe(true); expect(m.overflow).toBe(false); expect(m.margins.every(v => v === "0px")).toBe(true); expect(m.gap.every(v => v === "4px")).toBe(true);
    await page.goto(`${origin}/?page=18`);
    await expect(nav.locator('[aria-current="page"]')).toHaveText("18");
    await expect(nav.getByRole("button", { name: "18페이지", exact: true })).toBeVisible();
    await expect(nav.locator(".onq-page-numbers .onq-page-control:visible")).toHaveCount(width < 768 ? 5 : 10);
    await page.screenshot({ path: `tests/e2e/screenshots/pagination/runtime-${width}.png`, fullPage: true });
  });
  test(`cursor history and link filters keyboard ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`${origin}/?shop=1&sort=price&q=보존`);
    const cursor = page.getByRole("region", { name: "방문 커서" });
    await expect(cursor.getByRole("button", { name: "마지막", exact: true })).toHaveCount(0);
    await cursor.getByRole("button", { name: "다음", exact: true }).click();
    await cursor.getByRole("button", { name: "다음", exact: true }).click();
    await expect(cursor.getByRole("button", { name: "4페이지", exact: true })).toHaveCount(0);
    await expect(cursor.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
    await cursor.getByRole("button", { name: "1페이지", exact: true }).click();
    await expect(cursor.locator('[aria-current="page"]')).toHaveText("1");
    await expect(cursor.getByRole("button", { name: "3페이지", exact: true })).toBeVisible();
    await cursor.getByRole("button", { name: "다음", exact: true }).click();
    await expect(cursor.locator('[aria-current="page"]')).toHaveText("2");
    await cursor.getByRole("button", { name: "3페이지", exact: true }).click();
    await expect(cursor.locator('[aria-current="page"]')).toHaveText("3");
    const links = page.getByRole("region", { name: "쇼핑몰 링크" });
    await links.getByRole("link", { name: "마지막", exact: true }).focus();
    await page.keyboard.press("Enter"); await expect(page).toHaveURL(/page=23/); await expect(page).toHaveURL(/sort=price/); await expect(page).toHaveURL(/q=/);
  });
}
test("zero one and invalid boundaries", async ({ page }) => {
  const nav = page.getByRole("region", { name: "전체 건수" });
  await page.goto(`${origin}/?count=0`); await expect(nav.locator("nav")).toHaveCount(0);
  await page.goto(`${origin}/?count=1&page=-10`); await expect(nav.locator("button:disabled")).toHaveCount(4); await expect(nav.locator('[aria-current="page"]')).toHaveText("1");
  await page.goto(`${origin}/?count=23&page=999`); await expect(nav.locator('[aria-current="page"]')).toHaveText("23");
});
