import type { APIResponse, Page, Response, TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

type Read = { pathname: string; status: number; contentType: string | null; shortError?: string };
const reads = new WeakMap<Page, Read[]>();
export async function recordBrandingRead(page: Page, response: Response | APIResponse) {
  try {
    const row: Read = { pathname: new URL(response.url()).pathname, status: response.status(), contentType: response.headers()["content-type"] ?? null };
    if (row.status >= 400) {
      row.shortError = "non-json-error";
      if (row.contentType?.includes("application/json")) {
        const error = (await response.json()).error;
        row.shortError = typeof error === "string" && /^[a-z0-9_-]{1,80}$/i.test(error) ? error : "non-code-json-error";
      }
    }
    const list = reads.get(page) ?? [];
    list.push(row); reads.set(page, list.slice(-12));
  } catch { /* 진단 실패가 원 시험 실패를 바꾸지 않는다. */ }
}
export function observeBrandingReads(page: Page) {
  reads.set(page, []);
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() === "GET" && (path.startsWith("/api/branding/") || path === "/api/admin/branding/card-preview")) void recordBrandingRead(page, response);
  });
}
export async function captureBrandingFailure(page: Page, info: TestInfo, label: string) {
  if (info.status === info.expectedStatus || process.env.CI !== "true" || process.env.GITHUB_JOB !== "e2e-smoke" || process.env.NODE_ENV === "production") return;
  try {
    const base = new URL(String(info.project.use.baseURL));
    if (!/^(localhost|127\.0\.0\.1)$/.test(base.hostname) || base.port !== "3100") return;
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const folder = `tests/e2e/screenshots/current-shell-${sha}`;
    mkdirSync(folder, { recursive: true });
    const images = await page.evaluate(() => Array.from(document.images).slice(0, 12).map(img => ({ pathname: img.currentSrc.startsWith("blob:") ? "blob:" : img.currentSrc ? new URL(img.currentSrc, location.href).pathname : "", complete: img.complete, width: img.naturalWidth, height: img.naturalHeight })));
    writeFileSync(`${folder}/${label}-failure.json`, JSON.stringify({ sha, route: new URL(page.url()).pathname, error: "original-test-failure-preserved", responses: reads.get(page) ?? [], images }, null, 2));
    await page.screenshot({ path: `${folder}/${label}-failure.png`, fullPage: true });
  } catch { /* best effort: 원 오류·기대·timeout을 보존한다. */ }
}
