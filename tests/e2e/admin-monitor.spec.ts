import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 실시간 감시(MA-100, GET /api/admin/ops/monitor). 계정·사건은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { super: `mon-super-${run}@example.com`, ops: `mon-ops-${run}@example.com` };
const source = `e2e-${run}`;
const job = `e2e.job.${run}`;
const privateError = `시험 내부 오류 ${run}`;
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.super, passwordHash, name: "대표", role: "SUPER_ADMIN" },
      { email: emails.ops, passwordHash, name: "운영", role: "OPERATIONS" },
    ],
  });
  const now = new Date();
  await db.opsInstance.create({ data: { name: source, generation: run, registeredAt: now } });
  await db.opsHeartbeat.create({ data: { instance: source, generation: run, job, lastRunAt: now, lastStatus: "failed", lastError: privateError } });
  await db.opsEvent.createMany({
    data: [
      { source, eventId: `${run}-1`, kind: "incident_open", key: `down-${run}`, severity: "critical", message: `시험 장애 ${run}`, occurredAt: now },
      { source, eventId: `${run}-2`, kind: "incident_open", key: `slow-${run}`, severity: "warning", message: `시험 지연 ${run}`, occurredAt: now },
      { source, eventId: `${run}-3`, kind: "incident_close", key: `slow-${run}`, severity: "info", message: `지연 해소 ${run}`, occurredAt: now },
    ],
  });
  await db.auditLog.create({ data: { actorType: "SYSTEM", action: `e2e.auto.${run}`, targetType: "시험대상" } });
});
test.afterAll(async () => {
  await db.opsEvent.deleteMany({ where: { source } });
  await db.auditLog.deleteMany({ where: { action: `e2e.auto.${run}` } });
  await db.opsHeartbeat.deleteMany({ where: { instance: source, generation: run } });
  await db.opsInstance.deleteMany({ where: { name: source, generation: run } });
  await db.$disconnect();
});

async function login(page: Page, email: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("최고관리자: 열린 장애는 심각도와 함께 보이고 해소된 장애는 빠지며, 자동 조치 기록과 웹훅 「측정 안 함」이 보인다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto("/admin/ops/monitor");
  await expect(page.getByTestId("monitor-status")).toContainText("감시 중");
  const incident = page.getByTestId("monitor-incident").filter({ hasText: `시험 장애 ${run}` });
  await expect(incident).toContainText("긴급");
  await expect(page.getByTestId("monitor-incident").filter({ hasText: `시험 지연 ${run}` })).toHaveCount(0);
  await expect(page.getByTestId("monitor-action").filter({ hasText: `e2e.auto.${run}` })).toBeVisible();
  await expect(page.getByTestId("monitor-webhook")).toContainText("확인하지 않음");
  await expect(page.getByTestId("monitor-paycheck")).toHaveCount(4);
  await expect(page.getByTestId("monitor-job").filter({ hasText: job })).toContainText(privateError);
  // 심각도 거르기: 주의로 바꾸면 긴급 장애는 빠진다
  await page.getByRole("button", { name: "주의", exact: true }).click();
  await expect(incident).toHaveCount(0);
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await expect(incident).toHaveCount(1);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-monitor-1440.png" });
});

test("지표를 못 읽으면 「감시 끊김」과 마지막 갱신 시각을 알리고, 마지막으로 읽은 장애는 그대로 둔다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto("/admin/ops/monitor");
  await expect(page.getByTestId("monitor-status")).toContainText("감시 중");
  await page.route("**/api/admin/ops/monitor", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await page.getByRole("button", { name: "지금 갱신" }).click();
  await expect(page.getByTestId("monitor-status")).toContainText("감시 끊김");
  await expect(page.getByTestId("monitor-status")).toContainText("마지막 갱신");
  await expect(page.getByTestId("monitor-incident").first()).toBeVisible();
});

test("운영 담당: 감시를 조회하고 갱신하되 쓰기 동작과 내부 오류 상세는 보이지 않는다", async ({ page }) => {
  await login(page, emails.ops);
  await page.getByRole("navigation", { name: "주 메뉴", exact: true }).getByRole("link", { name: "운영", exact: true }).click();
  const writes: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/admin/ops/monitor" && !["GET", "HEAD"].includes(request.method())) writes.push(request.method());
  });
  const menu = page.getByRole("link", { name: "실시간 감시", exact: true });
  await expect(menu).toHaveAttribute("href", "/admin/ops/monitor");
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/ops/monitor" && r.request().method() === "GET");
  await menu.click();
  await expect(page).toHaveURL(/\/admin\/ops\/monitor$/);
  const loaded = await response;
  expect(loaded.ok()).toBe(true);
  const data = await loaded.json();
  const ownJob = data.jobs.find((entry: { job: string }) => entry.job === job);
  expect(ownJob).toMatchObject({ job, lastStatus: "failed", healthy: false });
  expect(ownJob).not.toHaveProperty("lastError");
  await expect(page.getByRole("heading", { name: "실시간 감시", exact: true })).toBeVisible();
  await expect(page.getByTestId("monitor-status")).toContainText("감시 중");
  await expect(page.getByTestId("monitor-incident").filter({ hasText: `시험 장애 ${run}` })).toContainText("긴급");
  const jobRow = page.getByTestId("monitor-job").filter({ hasText: job });
  await expect(jobRow).toContainText("실패");
  await expect(jobRow.locator("td").last()).toHaveText("-");
  await expect(page.getByText(privateError, { exact: true })).toHaveCount(0);
  const main = page.locator("main.main");
  await expect(main.locator("form, input, textarea, select")).toHaveCount(0);
  await expect(main.locator("button:not(.bk)")).toHaveText(["지금 갱신", "전체", "긴급", "주의"]);
  const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/ops/monitor" && r.request().method() === "GET");
  await page.getByRole("button", { name: "지금 갱신", exact: true }).click();
  expect((await refreshed).ok()).toBe(true);
  await expect(jobRow.locator("td").last()).toHaveText("-");
  expect(writes).toEqual([]);
});
