import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { test, expect } from "@playwright/test";

const repo = path.resolve(process.cwd());
let previewProcess: ChildProcess | undefined;
let previewUrl = "";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("미리보기 포트를 확인하지 못했습니다.");
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test.beforeAll(async () => {
  const port = await freePort();
  previewUrl = `http://127.0.0.1:${port}`;
  previewProcess = spawn(process.execPath, [path.join(repo, "node_modules/next/dist/bin/next"), "dev", "design/preview", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repo,
    stdio: "ignore",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", SCHEDULER_DISABLED: "1" },
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (previewProcess.exitCode !== null) throw new Error(`PF-003 미리보기가 ${previewProcess.exitCode} 코드로 종료됐습니다.`);
    try {
      const response = await fetch(previewUrl);
      if (response.ok) return;
    } catch { /* Next 개발 서버가 준비될 때까지 기다립니다. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  previewProcess.kill();
  throw new Error("PF-003 미리보기가 90초 안에 준비되지 않았습니다.");
});

test.afterAll(async () => {
  if (!previewProcess || previewProcess.exitCode !== null) return;
  previewProcess.kill();
  await Promise.race([
    new Promise<void>((resolve) => previewProcess?.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
});

test("PF-003 TSX는 legacy v331의 문구와 1440 레이아웃을 보존한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${previewUrl}/design/project/PF-003.dc.html`);
  await page.addStyleTag({ url: `${previewUrl}/design-assets/styles/wanted-sans.css` });
  const legacy = page.locator(".app");
  await expect(legacy).toBeVisible();
  const legacyText = (await legacy.innerText()).replace(/\s+/g, " ").trim();
  const legacyBounds = await page.locator(".app").evaluate((app) => {
    const bounds = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map((value) => Math.round(value));
    };
    return [app, ...app.querySelectorAll(":scope > header, :scope > section, :scope > footer")].map(bounds);
  });
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: "tests/e2e/screenshots/pf003-legacy-1440.png", fullPage: true });

  await page.goto(previewUrl);
  const canonical = page.locator(".app");
  await expect(canonical).toBeVisible();
  const canonicalText = (await canonical.innerText()).replace(/\s+/g, " ").trim();
  expect(canonicalText).toBe(legacyText);
  const canonicalBounds = await canonical.evaluate((app) => {
    const bounds = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map((value) => Math.round(value));
    };
    return [app, ...app.querySelectorAll(":scope > header, :scope > section, :scope > footer")].map(bounds);
  });
  expect(canonicalBounds).toEqual(legacyBounds);
  await expect(canonical.getByRole("button", { name: "결제가 실패하면 어떻게 되나요?" })).toHaveAttribute("aria-expanded", "true");
  await canonical.getByRole("button", { name: "결제가 실패하면 어떻게 되나요?" }).click();
  await expect(canonical.getByRole("button", { name: "결제가 실패하면 어떻게 되나요?" })).toHaveAttribute("aria-expanded", "false");
  await canonical.getByRole("button", { name: "결제가 실패하면 어떻게 되나요?" }).click();
  await canonical.getByRole("link", { name: "요금", exact: true }).click();
  await expect(page).toHaveURL(`${previewUrl}/`);
  const afterNav = page.locator(".app");
  await expect(afterNav.getByRole("button", { name: "결제가 실패하면 어떻게 되나요?" })).toHaveAttribute("aria-expanded", "true");
  await afterNav.getByRole("link", { name: "요금 보기" }).click();
  await expect(page).toHaveURL(`${previewUrl}/`);
  await expect(page.locator(".app").getByRole("button", { name: "결제가 실패하면 어떻게 되나요?" })).toBeVisible();
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: "tests/e2e/screenshots/pf003-tsx-1440.png", fullPage: true });

  if (process.env.E2E_SCREENSHOTS) {
    const productionUrl = process.env.E2E_BASE_URL ?? "http://localhost:3100";
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(previewUrl);
      await page.screenshot({ path: `tests/e2e/screenshots/pf003-tsx-viewport-${width}.png` });
      await page.goto(`${productionUrl}/pricing`);
      await page.screenshot({ path: `tests/e2e/screenshots/pf003-production-viewport-${width}.png`, ...(width === 1440 ? { fullPage: true } : {}) });
    }
  }
});
