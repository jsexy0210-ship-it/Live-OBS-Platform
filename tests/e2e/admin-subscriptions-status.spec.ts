import { expect, test, type Page } from "@playwright/test";
import { recentRange } from "../../lib/client/dateInput";

// 실제 목록의 상태·주소·입력 계약만 확인한다. 모든 API는 합성 GET 응답이고 변경 요청과 외부 접근은 거부한다.
const base = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3100");
if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("loopback 주소에서만 실행합니다.");
test.use({ channel: process.platform === "win32" ? "chrome" : undefined });
const counts = { trial: 0, paid: 1, charging: 0, grace: 9, expired: 2, locked: 1, cancelling: 1 };
const rows = Array.from({ length: 12 }, (_, index) => ({
  seller: { id: `ui-${index}`, slug: `ui-${index}`, shopName: `검증 ${index}`, status: "ACTIVE" },
  access: index === 0 || index === 2 ? "expired" : index === 1 ? "paid" : "grace", locked: index === 0, cancelling: index === 1,
  plan: { code: "INTEGRATED", name: "통합", listPrice: 179000, salePrice: null }, trialEndsAt: null,
  subscription: { status: index === 1 ? "ACTIVE" : index === 2 ? "CANCELED" : "PAST_DUE", cardLabel: null, currentPeriodEnd: index === 1 ? "2099-01-01T00:00:00Z" : "2000-01-01T00:00:00Z", nextChargeAt: null, cancelAtPeriodEnd: index === 1 || index === 2, graceUntil: index === 0 ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z", retryCount: 0 },
}));
async function mock(page: Page) {
  const reads: URL[] = [], writes: string[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (route.request().method() !== "GET") { writes.push(url.pathname); return route.fulfill({ status: 409, json: { error: "ui_test_write_blocked" } }); }
    if (url.pathname === "/api/admin/me") return route.fulfill({ json: { id: "ui-admin", name: "검증 관리자", email: "ui@example.com", role: "READ_ONLY" } });
    if (url.pathname === "/api/maintenance") return route.fulfill({ json: { active: false, scheduled: null } });
    if (url.pathname === "/api/admin/subscriptions") {
      reads.push(url);
      const selected = url.searchParams.get("access")?.split(",") ?? [];
      const filtered = rows.filter((row) => !selected.length || selected.some((status) => status === "locked" ? row.locked : status === "cancelling" ? row.cancelling : row.access === status));
      const start = url.searchParams.has("cursor") ? 10 : 0;
      return route.fulfill({ json: { counts, subscriptions: filtered.slice(start, start + 10), nextCursor: start + 10 < filtered.length ? "ui-next" : null } });
    }
    return route.fulfill({ status: 500, json: { error: "ui_unconfigured_read" } });
  });
  return { reads, writes, errors };
}

test("MA023: 겹치는 상태를 중복 합산하지 않고 행 flag·복수 상태·주소·기간·커서를 보존한다", async ({ page }) => {
  const result = await mock(page);
  await page.goto("/admin/billing/subscriptions?access=locked,cancelling&period=all&q=검증&plan=INTEGRATED");
  const list = page.getByTestId("subscription-row");
  await expect(list).toHaveCount(2);
  await expect(list.first().locator("td").nth(1)).toHaveText("잠금");
  await expect(list.nth(1).locator("td").nth(1)).toContainText("이용 중");
  await expect(list.nth(1).locator("td").nth(1)).toContainText("해지 예정");
  const statuses = page.getByRole("group", { name: "이용 상태", exact: true });
  await expect(statuses.getByRole("checkbox")).toHaveCount(7);
  await expect(statuses.locator("label")).toHaveText(["체험 0", "이용 중 1", "결제 진행 중 0", "유예 9", "잠금 1", "해지 예정 1", "해지 2"]);
  await expect(statuses.getByRole("button", { name: "전체 12", exact: true })).toBeVisible();
  await expect(statuses.getByRole("checkbox", { name: /^잠금\s/ })).toBeChecked();
  await expect(statuses.getByRole("checkbox", { name: /^해지 예정\s/ })).toBeChecked();
  const q = page.getByLabel("쇼핑몰 이름 · 주소");
  await q.fill("입력 중인 검색어");
  await statuses.getByRole("checkbox", { name: /^유예\s/ }).check();
  await expect.poll(() => result.reads.at(-1)?.searchParams.get("access")).toBe("grace,locked,cancelling");
  await expect(q).toHaveValue("입력 중인 검색어");
  await expect(list).toHaveCount(10);
  expect(result.reads.at(-1)?.searchParams.get("q")).toBe("검증");
  expect(result.reads.at(-1)?.searchParams.has("nextFrom")).toBe(false);
  await page.getByRole("textbox", { name: "다음 결제 시작일", exact: true }).fill("2026.10.01");
  await page.getByRole("textbox", { name: "다음 결제 종료일", exact: true }).fill("2026.10.31");
  await page.getByRole("search").getByRole("button", { name: "검색", exact: true }).click();
  await expect.poll(() => result.reads.at(-1)?.searchParams.get("nextTo")).toBe("2026-10-31");
  expect(result.reads.at(-1)?.searchParams.get("nextFrom")).toBe("2026-10-01");
  expect(result.reads.at(-1)?.searchParams.get("plan")).toBe("INTEGRATED");
  expect(result.reads.at(-1)?.searchParams.get("q")).toBe("입력 중인 검색어");
  await page.getByRole("navigation", { name: "페이지 이동" }).getByRole("button", { name: "다음", exact: true }).click();
  await expect(list).toHaveCount(1);
  expect(result.reads.at(-1)?.searchParams.get("limit")).toBe("10");
  expect(result.reads.at(-1)?.searchParams.get("cursor")).toBe("ui-next");
  await page.reload();
  await expect(list).toHaveCount(10);
  await expect(q).toHaveValue("입력 중인 검색어");
  await expect(statuses.getByRole("checkbox", { name: /^잠금\s/ })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  expect(result.writes).toEqual([]); expect(result.errors).toEqual([]);
});

test("MA023: 기본·초기화는 최근 1개월이고 전체 기간 선택만 날짜 조건을 비운다", async ({ page }) => {
  const result = await mock(page);
  await page.goto("/admin/billing/subscriptions");
  await expect(page.getByTestId("subscription-row")).toHaveCount(10);
  await expect(page.getByTestId("subscription-row").filter({ hasText: "검증 2" }).locator("td").nth(5)).not.toContainText("해지 예정");
  const range = recentRange(1);
  expect(result.reads.at(-1)?.searchParams.get("nextFrom")).toBe(range.from);
  expect(result.reads.at(-1)?.searchParams.get("nextTo")).toBe(range.to);
  await page.getByRole("group", { name: "기간 빠른 선택" }).getByRole("button", { name: "전체", exact: true }).click();
  await page.getByRole("search").getByRole("button", { name: "검색", exact: true }).click();
  await expect.poll(() => result.reads.at(-1)?.searchParams.has("nextFrom")).toBe(false);
  await page.getByRole("search").getByRole("button", { name: "초기화", exact: true }).click();
  await expect.poll(() => result.reads.at(-1)?.searchParams.get("nextFrom")).toBe(range.from);
  expect(result.reads.at(-1)?.searchParams.get("nextTo")).toBe(range.to);
  expect(result.writes).toEqual([]); expect(result.errors).toEqual([]);
});
