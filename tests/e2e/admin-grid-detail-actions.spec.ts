import { expect, test, type Page, type Route } from "@playwright/test";

// Every API is fulfilled in the browser. These cases never call DB, billing, mail or live services.
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const at = "2026-10-19T10:00:00.000Z";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function mockAdmin(page: Page, handler: (route: Route, path: string) => Promise<boolean>, role = "SUPER_ADMIN") {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/me") { await json(route, { id: id(900), name: "검수 관리자", email: "review@example.com", role }); return; }
    if (await handler(route, path)) return;
    // A mutation not explicitly expected by the case is a failure, including hidden list writes.
    expect(route.request().method(), `unexpected API ${path}`).toBe("GET");
    await json(route, { items: [], notifications: [], unread: 0, unreadCount: 0, count: 0, enabled: false, maintenance: null });
  });
}
const account = (n: number) => ({ id: id(n), email: `admin${n}@example.com`, name: `관리자${n}`, role: "READ_ONLY", status: "ACTIVE", lastLoginAt: null, createdAt: at });
const plan = { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 200000, salePrice: 179000, mailMonthlyQuota: 100, trialDays: 0, trialMessageLimit: 0, trialIdentityLimit: 0, trialStorageMb: 0, next: null };

test("계정 목록은 상세로 이동하고 첫 쪽 밖 계정도 직접 열어 기존 PATCH를 보낸다", async ({ page }) => {
  const accounts = Array.from({ length: 25 }, (_, i) => account(i + 1));
  const writes: unknown[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/admins") { await json(route, { admins: accounts }); return true; }
    if (path === `/api/admin/admins/${id(25)}` && route.request().method() === "PATCH") { const body = route.request().postDataJSON(); writes.push(body); await json(route, { admin: { ...accounts[24], ...body } }); return true; }
    return false;
  });
  await page.goto("/admin/accounts");
  await expect(page.getByTestId("account-row")).toHaveCount(10);
  await expect(page.locator("main").getByRole("button", { name: /수정|저장|정지/ })).toHaveCount(0);
  await expect(page.getByTestId("account-row").first().getByRole("link", { name: "상세" })).toHaveAttribute("href", /accounts\/00000000.*returnTo=/);
  expect(writes).toEqual([]);
  await page.goto(`/admin/accounts/${id(25)}?returnTo=${encodeURIComponent("/admin/accounts?page=3")}`);
  await expect(page.locator("main form").getByLabel("이름")).toHaveValue("관리자25");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("이름", { exact: true }).fill("변경 관리자");
  await page.locator("main form").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page).toHaveURL(/accounts\?page=3$/);
  expect(writes).toEqual([{ name: "변경 관리자" }]);
});

test("가격 상세는 기존 금액 검증과 두 번째 확정을 유지하고 목록에서는 결제 변경을 보내지 않는다", async ({ page }) => {
  const writes: unknown[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/plans") { await json(route, { plans: [plan] }); return true; }
    if (path.endsWith("/plans/INTEGRATED/price")) { writes.push(route.request().postDataJSON()); await json(route, { ok: true }); return true; }
    return false;
  });
  await page.goto("/admin/billing/plans");
  await expect(page.getByTestId("plan-row").getByRole("button")).toHaveCount(0);
  await page.getByTestId("plan-row").getByRole("link", { name: "상세" }).click();
  await page.getByRole("button", { name: "가격 변경", exact: true }).click();
  const form = page.locator("main form");
  await form.getByLabel("판매가").fill("200001");
  await expect(form.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await form.getByLabel("판매가").fill("180000");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  expect(writes).toEqual([]);
  await expect(form.getByTestId("price-diff")).toContainText("179,000원 → 180,000원");
  await form.getByRole("button", { name: "가격 변경 확정" }).click();
  await expect(page).toHaveURL(/billing\/plans(?:\?|$)/);
  expect(writes).toEqual([{ listPrice: 200000, salePrice: 180000 }]);
});

test("도우미 상세의 409는 입력과 기존 version을 보존하고 명시적으로 최신 자료를 다시 읽는다", async ({ page }) => {
  let version = 1; const writes: { expectedVersion: number }[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/assistant/docs") { await json(route, { items: [{ id: id(1), title: version === 1 ? "원본 문서" : "다른 곳의 수정", body: "공개 자료", published: false, version, updatedAt: at }] }); return true; }
    if (path === `/api/admin/assistant/docs/${id(1)}`) { writes.push(route.request().postDataJSON()); version = 2; await json(route, { error: "version_conflict", message: "다른 곳에서 수정됐습니다.", currentVersion: 2 }, 409); return true; }
    return false;
  });
  await page.goto(`/admin/support/assistant/${id(1)}`);
  await page.getByLabel("제목", { exact: true }).fill("보관할 입력");
  await page.locator("main form").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("다른 곳에서 수정됐습니다.");
  await expect(page.getByLabel("제목", { exact: true })).toHaveValue("보관할 입력");
  expect(writes[0].expectedVersion).toBe(1);
  await page.getByRole("button", { name: "최신 내용을 다시 불러오기" }).click();
  await expect(page.getByLabel("제목", { exact: true })).toHaveValue("다른 곳의 수정");
});

test("선택 메모 상세는 정확한 ID와 일부 실패 결과를 유지한다", async ({ page }) => {
  const writes: { sellerIds: string[]; body: string }[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === `/api/admin/sellers/${id(1)}` || path === `/api/admin/sellers/${id(2)}`) { await json(route, { seller: { shopName: path.endsWith(id(1)) ? "첫 번째 몰" : "두 번째 몰" } }); return true; }
    if (path === "/api/admin/sellers/notes/bulk") { writes.push(route.request().postDataJSON()); await json(route, { created: 1, results: [{ sellerId: id(1), ok: true }, { sellerId: id(2), ok: false, error: "not_found" }] }); return true; }
    return false;
  });
  await page.goto(`/admin/partners/bulk-note?ids=${id(1)},${id(2)}`);
  await expect(page.getByRole("heading", { name: "대상 2곳" })).toBeVisible();
  const form = page.locator("main section").filter({ has: page.getByLabel("메모", { exact: true }) });
  await form.getByLabel("메모", { exact: true }).fill("확인할 메모");
  await form.getByRole("button", { name: "메모 남기기" }).click();
  await expect(page.getByRole("status")).toContainText("1곳에 메모를 남겼습니다 · 1곳은 남기지 못했습니다.");
  expect(writes).toEqual([{ sellerIds: [id(1), id(2)], body: "확인할 메모" }]);
  await expect(form).toHaveCount(0);
});

test("선택 승인은 부분 결과와 10초 되돌리기를 상세에 보존한다", async ({ page }) => {
  const now = new Date(); await page.clock.install({ time: now });
  const writes: string[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === `/api/admin/sellers/${id(1)}` || path === `/api/admin/sellers/${id(2)}`) { await json(route, { seller: { shopName: path.endsWith(id(1)) ? "승인 몰" : "실패 몰" } }); return true; }
    if (path === "/api/admin/sellers/applications/bulk-approve") { writes.push(...route.request().postDataJSON().ids); await json(route, { results: [{ id: id(1), ok: true, undoableUntil: new Date(now.getTime() + 10000).toISOString() }, { id: id(2), ok: false, message: "다른 곳에서 처리됐습니다" }] }); return true; }
    if (path.endsWith("/approve/undo")) { writes.push("undo"); await json(route, { ok: true }); return true; }
    return false;
  });
  await page.goto(`/admin/partners/applications/bulk?ids=${id(1)},${id(2)}&mode=approve`);
  await page.getByRole("button", { name: "선택 승인", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("성공 1건 · 실패 1건");
  await expect(page.getByRole("button", { name: /승인 몰 되돌리기/ })).toBeVisible();
  expect(writes).toEqual([id(1), id(2)]);
  await page.getByRole("button", { name: /승인 몰 되돌리기/ }).click();
  await expect(page.getByRole("status")).toContainText("되돌림 1건");
  expect(writes).toEqual([id(1), id(2), "undo"]);
  await expect(page.getByRole("button", { name: /승인 몰 되돌리기/ })).toHaveCount(0);
  await page.getByRole("button", { name: "남은 신청 승인", exact: true }).click();
  await expect(page.getByRole("button", { name: /승인 몰 되돌리기/ })).toBeVisible();
  await page.clock.runFor(10_001);
  await expect(page.getByRole("button", { name: /승인 몰 되돌리기/ })).toHaveCount(0);
});

test("방송 상세 직접 진입은 단건을 읽고 사유를 확인한 뒤 종료한다", async ({ page }) => {
  const writes: unknown[] = []; const reads: string[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === `/api/admin/ops/live-broadcasts/${id(1)}`) { reads.push(path); await json(route, { broadcast: { broadcastId: id(1), sellerId: id(2), shopName: "방송 몰", title: "확인 방송" } }); return true; }
    if (path.endsWith(`/${id(1)}/end`)) { writes.push(route.request().postDataJSON()); await json(route, { ok: true }); return true; }
    if (path === "/api/admin/ops/live-broadcasts") { await json(route, { at, items: [], orderRate: { total: 0 } }); return true; }
    return false;
  });
  await page.goto(`/admin/ops/live/${id(1)}`);
  const form = page.locator("main section").filter({ has: page.getByLabel("사유 (필수)") });
  await expect(form.getByRole("button", { name: "강제 종료", exact: true })).toBeDisabled();
  await form.getByLabel("사유 (필수)").fill("송출 중단 요청");
  await form.getByRole("button", { name: "강제 종료", exact: true }).click();
  await expect(page).toHaveURL(/ops\/live$/);
  expect(reads).toEqual([`/api/admin/ops/live-broadcasts/${id(1)}`]);
  expect(writes).toEqual([{ reason: "송출 중단 요청" }]);
});

test("청구 재시도 상세는 현재 단건 상태를 다시 읽고 가능한 ID만 확인 후 보낸다", async ({ page }) => {
  let sent = false; const writes: unknown[] = [];
  await mockAdmin(page, async (route, path) => {
    const n = path === `/api/admin/payments/${id(1)}` ? 1 : path === `/api/admin/payments/${id(2)}` ? 2 : 0;
    if (n) { await json(route, { payment: { id: id(n), seller: { id: id(3), shopName: `청구 몰${n}` }, amount: 179000, canRetry: n === 1 && !sent, retryUnavailableReason: n === 2 ? "not_latest" : "too_soon" } }); return true; }
    if (path === "/api/admin/billing/invoices/retry") { writes.push(route.request().postDataJSON()); sent = true; await json(route, { results: [{ paymentId: id(1), ok: true }], succeeded: 1, failed: 0 }); return true; }
    return false;
  });
  await page.goto(`/admin/billing/invoices/retry?ids=${id(1)},${id(2)}`);
  await expect(page.getByText("최신 청구가 아닙니다", { exact: false })).toBeVisible();
  await page.locator("main").getByRole("button", { name: "다시 결제", exact: true }).click();
  expect(writes).toEqual([]);
  await page.getByRole("dialog").getByRole("button", { name: "다시 결제", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("성공 1건 · 실패 0건");
  expect(writes).toEqual([{ paymentIds: [id(1)] }]);
  await expect(page.locator("main").getByRole("button", { name: "다시 결제", exact: true })).toBeDisabled();
});
