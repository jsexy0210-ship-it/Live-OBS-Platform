import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { hashPassword } from "../../lib/server/auth/password";

// owned CI 계정만 사용한다. runner 실행 API는 mock이며 실제 서버/정리/외부 dispatch는 호출하지 않는다.
const run = randomBytes(6).toString("hex"), password = randomBytes(12).toString("base64url");
const email = `safe-disk-${run}@example.com`;
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = `tests/e2e/screenshots/current-shell-${sha}`;
let db: PrismaClient, adminId: string | undefined;
test.beforeAll(async ({}, info) => {
  expect(process.env.CI).toBe("true"); expect(process.env.GITHUB_JOB).toBe("e2e-smoke"); expect(process.env.NODE_ENV).not.toBe("production"); expect(info.config.workers).toBe(1);
  const url = assertTestDatabaseUrl(process.env.DATABASE_URL);
  expect(new URL(url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/); expect(new URL(url).pathname).toBe("/live_obs_test");
  const base = new URL(String(info.project.use.baseURL)); expect(base.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/); expect(base.port).toBe("3100");
  db = new PrismaClient({ datasources: { db: { url } } });
  adminId = (await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "수동 정리 검수", role: "SUPER_ADMIN" } })).id;
  mkdirSync(evidence, { recursive: true });
});
test.afterAll(async () => {
  if (!db) return;
  try {
    if (adminId) {
      await db.adminSession.deleteMany({ where: { adminId } });
      await db.auditLog.deleteMany({ where: { actorId: adminId, actorType: "PLATFORM_ADMIN" } });
      await db.platformAdmin.delete({ where: { id: adminId } });
    }
  } finally { await db.$disconnect(); }
});
async function login(page: Page) {
  await page.goto("/admin/login"); await page.getByLabel("이메일").fill(email); await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click(); await expect(page).toHaveURL(/\/admin$/);
}
async function capture(page: Page, state: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const section = page.getByRole("region", { name: "디스크 수동 정리", exact: true });
    await section.scrollIntoViewIfNeeded();
    expect(await section.evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1)).toBe(true);
    const name = `MA-120-${state}-${width}`;
    await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
    writeFileSync(`${evidence}/${name}.json`, JSON.stringify({ sha, role: "SUPER_ADMIN", route: "/admin/ops/infra", state, viewport: { width, height: 1000 }, execution: "OWNED_MOCK_ONLY" }));
  }
}
test("미연결 원천은503·자동꺼짐·실행불가를 표시하고 actual job을 만들지 않는다", async ({ page }) => {
  await login(page); await page.goto("/admin/ops/infra");
  const section = page.getByRole("region", { name: "디스크 수동 정리", exact: true });
  await expect(section).toBeVisible(); await expect(section).toContainText("자동 정리는 꺼져 있습니다");
  await expect(section.getByRole("button", { name: "정리 실행", exact: true })).toBeDisabled();
  const result = page.waitForResponse(r => new URL(r.url()).pathname === "/api/admin/infra/disk-optimization/preview" && r.request().method() === "POST");
  await section.getByRole("button", { name: "정리 대상 확인", exact: true }).click();
  expect((await result).status()).toBe(503);
  await expect(section).toContainText("대상 확인과 실행을 사용할 수 없습니다"); await expect(section).not.toContainText("실제 회수");
  await expect(section.getByRole("button", { name: "정리 실행", exact: true })).toBeDisabled();
  await capture(page, "unconnected");
});
test("owned mock만으로 두 범주 확인·정확 요청·실제job 상태 표시를 검수한다", async ({ page }) => {
  const fingerprint = "a".repeat(64), expiresAt = new Date(Date.now() + 60_000).toISOString();
  let executeCount = 0;
  await page.route("**/api/admin/infra/disk-optimization/preview", route => route.fulfill({ status: 200, json: { candidates: [{ category: "OLD_ONQ_NON_ROLLBACK_IMAGES", bytes: 100 }, { category: "RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS", bytes: 20 }], candidateFingerprint: fingerprint, expiresAt, estimatedReclaimedBytes: 120 } }));
  await page.route("**/api/admin/infra/disk-optimization/execute", route => {
    executeCount++;
    expect(route.request().postDataJSON()).toEqual({ actionId: "OPTIMIZE_APPROVED_ARTIFACTS_V1", policyVersion: "ONQ_DISK_SAFE_V1", candidateFingerprint: fingerprint, previewExpiresAt: expiresAt, idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    return route.fulfill({ status: 202, json: { job: { id: "12345", state: "QUEUED", completedAt: null, reclaimedBytes: null, errorCode: null } } });
  });
  await page.route("**/api/admin/infra/disk-optimization/jobs/12345", route => route.fulfill({ status: 200, json: { job: { id: "12345", state: "SUCCEEDED", completedAt: new Date().toISOString(), reclaimedBytes: 90, errorCode: null } } }));
  await login(page); await page.goto("/admin/ops/infra");
  const section = page.getByRole("region", { name: "디스크 수동 정리", exact: true });
  await section.getByRole("button", { name: "정리 대상 확인", exact: true }).click();
  await expect(section).toContainText("롤백 보호 밖 오래된 앱 이미지"); await expect(section).toContainText("14일 초과 러너 진단 로그");
  await section.getByRole("button", { name: "정리 실행", exact: true }).click();
  const actualResult = page.waitForResponse(r => new URL(r.url()).pathname === "/api/admin/infra/disk-optimization/jobs/12345" && r.request().method() === "GET");
  await page.getByRole("button", { name: "정리 실행", exact: true }).last().click();
  expect((await actualResult).status()).toBe(200);
  await expect(section).toContainText("작업 12345 · 완료 · 실제 회수"); expect(executeCount).toBe(1);
  await capture(page, "owned-result");
});
test("owned 읽기 전용 후보는 실행 승인 전 CTA를 막고 완료를 표시하지 않는다", async ({ page }) => {
  let executeCount = 0;
  await page.route("**/api/admin/infra/disk-optimization/preview", route => route.fulfill({ status: 200, json: { executionEnabled: false, candidates: [{ category: "RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS", bytes: 20 }], candidateFingerprint: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), estimatedReclaimedBytes: 20 } }));
  await page.route("**/api/admin/infra/disk-optimization/execute", route => { executeCount++; return route.fulfill({ status: 503, json: { error: "disk_execution_not_approved" } }); });
  await login(page); await page.goto("/admin/ops/infra");
  const section = page.getByRole("region", { name: "디스크 수동 정리", exact: true });
  await section.getByRole("button", { name: "정리 대상 확인", exact: true }).click();
  await expect(section).toContainText("실행 연결은 별도 승인이 필요해 실행할 수 없습니다");
  await expect(section.getByRole("button", { name: "정리 실행", exact: true })).toBeDisabled();
  await expect(section).not.toContainText("실제 회수");
  expect(executeCount).toBe(0);
  await capture(page, "owned-readonly");
});
