import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let server: Server, origin: string, dir: string;
test.use({ channel: "chrome" });
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "onq-common-"));
  await build({ entryPoints: ["tests/e2e/fixtures/common-list.tsx"], outfile: join(dir, "fixture.js"), bundle: true, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" }, plugins: [{ name: "navigation-fixture", setup(builder) {
    // Only the navigation side effect is stubbed: this test validates production UI and CSS, not Next routing.
    builder.onResolve({ filter: /lib\/client\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const useSmartBack=()=>()=>{};", loader: "js" }));
  } }] });
  server = createServer((req, res) => {
    if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(join(dir, "fixture.js"))); }
    else if (["/tokens.css", "/seller.css", "/lop.css"].includes(req.url!)) { res.setHeader("Content-Type", "text/css"); res.end(readFileSync(`styles${req.url}`)); }
    else res.end('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/lop.css"><link rel="stylesheet" href="/seller.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); rmSync(dir, { recursive: true, force: true }); });
for (const width of [1440, 1024, 390]) test(`common source layout ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await page.goto(origin);
  const title = page.getByRole("heading", { name: "주문 목록" });
  await expect(title).toHaveAccessibleDescription("검색 조건을 확인하고 선택한 주문을 처리합니다.");
  const description = page.locator(".au-ph-description").first();
  expect((await description.boundingBox())!.y).toBeGreaterThan((await title.boundingBox())!.y);
  const grid = page.getByRole("region", { name: "주문 목록 표" });
  expect(await grid.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("1px");
  expect(await page.locator(".au-list-section").evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("0px");
  expect(await page.locator(".au-lh").evaluate(el => el.closest(".au-lt-wrap"))).toBeNull();
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(width);
  expect(await page.getByLabel("읽기 전용").evaluate(el => getComputedStyle(el).color)).not.toBe(await page.getByLabel("검색어").evaluate(el => getComputedStyle(el).color));
  await grid.focus(); await expect(grid).toBeFocused();
  await page.screenshot({ path: `tests/e2e/screenshots/common-list/layout-${width}.png` });
});
