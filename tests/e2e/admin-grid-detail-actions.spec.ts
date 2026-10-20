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
  await expect(page.locator("main form").getByRole("alert")).toContainText("다른 곳에서 수정됐습니다.");
  await expect(page.getByLabel("제목", { exact: true })).toHaveValue("보관할 입력");
  expect(writes[0].expectedVersion).toBe(1);
  page.once("dialog", d => void d.accept());
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


test("계정 상세의 목록·sidebar·Back·취소를 dismiss하면 입력이 남는다", async ({ page }) => {
  const writes: unknown[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/admins") { await json(route, { admins: [account(1)] }); return true; }
    if (route.request().method() !== "GET") { writes.push(route.request().postDataJSON()); await json(route, { ok: true }); return true; }
    return false;
  });
  await page.goto("/admin/accounts");
  await page.getByTestId("account-row").getByRole("link", { name: "상세" }).click();
  await page.getByLabel("이름", { exact: true }).fill("보관할 계정 이름");
  const detail = page.url();
  page.once("dialog", d => void d.dismiss());
  await page.locator("main").getByRole("link", { name: "목록", exact: true }).click();
  await expect(page).toHaveURL(detail);
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue("보관할 계정 이름");
  page.once("dialog", d => void d.dismiss());
  await page.locator('.lnb a[href="/admin/accounts"]').first().click();
  await expect(page).toHaveURL(detail);
  const pop = page.waitForEvent("dialog");
  await page.evaluate(() => history.back());
  await (await pop).dismiss();
  await expect(page).toHaveURL(detail);
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue("보관할 계정 이름");
  page.once("dialog", d => void d.dismiss());
  await page.locator("main form").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue("보관할 계정 이름");
  page.once("dialog", d => void d.accept());
  await page.locator("main form").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page).toHaveURL(/accounts(?:\?|$)/);
  expect(writes).toEqual([]);
});

test("요금제 편집 중 다른 작업은 막고 취소를 dismiss하면 금액을 보존한다", async ({ page }) => {
  await mockAdmin(page, async (route, path) => { if (path === "/api/admin/plans") { await json(route, { plans: [plan] }); return true; } return false; });
  await page.goto("/admin/billing/plans/INTEGRATED");
  await page.getByRole("button", { name: "가격 변경", exact: true }).click();
  await page.getByLabel("판매가", { exact: true }).fill("180000");
  await expect(page.getByRole("button", { name: "체험 한도 변경", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "월 무료 메일 수량 변경", exact: true })).toBeDisabled();
  page.once("dialog", d => void d.dismiss());
  await page.locator("main form").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("판매가", { exact: true })).toHaveValue("180000");
  page.once("dialog", d => void d.accept());
  await page.locator("main form").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "체험 한도 변경", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "체험 한도 변경", exact: true }).click();
  await expect(page.getByLabel("저장 용량", { exact: true })).toBeVisible();
});

test("업체 수정 중 다른 변경을 막고 취소 후에만 사용 업체 선택을 연다", async ({ page }) => {
  const vendor = { id: id(1), name: "검수 업체", logoUrl: null, active: true, recommended: false, selected: false, referenceFee: null, memo: null, features: [], ratings: { fee: 8 }, score: 80, ratedCount: 1 };
  const writes: unknown[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/service-vendors") { await json(route, { categories: [{ category: "PG", featureKeys: [], criteria: [{ key: "fee", weight: 100 }], vendors: [vendor] }] }); return true; }
    if (route.request().method() !== "GET") { writes.push(route.request().postDataJSON()); await json(route, { ok: true }); return true; }
    return false;
  });
  await page.goto(`/admin/settings/vendors/${id(1)}`);
  await page.getByLabel("업체 이름", { exact: true }).fill("보관할 업체 이름");
  await expect(page.getByRole("button", { name: "사용 업체로 선택", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "추천으로 지정", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "로고 올리기", exact: true })).toBeDisabled();
  page.once("dialog", d => void d.dismiss());
  await page.locator("main").getByRole("link", { name: "목록", exact: true }).click();
  await expect(page.getByLabel("업체 이름", { exact: true })).toHaveValue("보관할 업체 이름");
  page.once("dialog", d => void d.accept());
  await page.locator("main form").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.locator("main form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "사용 업체로 선택", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "사용 업체로 선택", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  expect(writes).toEqual([]);
});

for (const action of ["hide", "delete"] as const) test(`도우미 ${action} 확인 취소·서버 실패는 초안과 읽기 횟수를 보존한다`, async ({ page }) => {
  let reads = 0;
  const writes: unknown[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/assistant/docs") { reads++; await json(route, { items: [{ id: id(1), title: "원본 문서", body: "저장된 내용", published: action === "hide", version: 7, updatedAt: at }] }); return true; }
    if (path === `/api/admin/assistant/docs/${id(1)}`) { writes.push({ method: route.request().method(), body: route.request().postDataJSON(), version: new URL(route.request().url()).searchParams.get("expectedVersion") }); await json(route, { message: "보존 검증 실패" }, 500); return true; }
    return false;
  });
  await page.goto(`/admin/support/assistant/${id(1)}`);
  await page.getByLabel("제목", { exact: true }).fill("보관할 제목");
  await page.getByLabel("내용", { exact: true }).fill("보관할 내용");
  const trigger = page.locator("main").getByRole("button", { name: action === "hide" ? "숨기기" : "삭제", exact: true });
  await trigger.click();
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("제목", { exact: true })).toHaveValue("보관할 제목");
  await expect(page.getByLabel("내용", { exact: true })).toHaveValue("보관할 내용");
  expect(reads).toBe(1); expect(writes).toEqual([]);
  await trigger.click();
  await page.getByRole("dialog").getByRole("button", { name: action === "hide" ? "숨기기" : "지우기", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("보존 검증 실패");
  await expect(page.getByLabel("제목", { exact: true })).toHaveValue("보관할 제목");
  await expect(page.getByLabel("내용", { exact: true })).toHaveValue("보관할 내용");
  expect(reads).toBe(1);
  expect(writes).toEqual([action === "hide" ? { method: "PUT", body: { title: "원본 문서", body: "저장된 내용", published: false, expectedVersion: 7 }, version: null } : { method: "DELETE", body: null, version: "7" }]);
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  page.once("dialog", d => void d.dismiss());
  await page.locator("main form").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("내용", { exact: true })).toHaveValue("보관할 내용");
});

test("도우미 상세의 dirty 목록·sidebar·Back·취소를 보존하고 저장 성공은 보호 기록을 소비한다", async ({ page }) => {
  let title = "원본 문서"; const writes: unknown[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/assistant/docs") { await json(route, { items: [{ id: id(1), title, body: "저장된 내용", published: false, version: 1, updatedAt: at }] }); return true; }
    if (path === "/api/admin/assistant/questions") { await json(route, { items: [] }); return true; }
    if (path === `/api/admin/assistant/docs/${id(1)}`) { const body = route.request().postDataJSON(); writes.push(body); title = body.title; await json(route, { ok: true }); return true; }
    return false;
  });
  const back = "/admin/support/assistant?q=보존";
  await page.goto(back);
  await page.goto(`/admin/support/assistant/${id(1)}?returnTo=${encodeURIComponent(back)}`);
  await page.getByLabel("제목", { exact: true }).fill("저장할 제목");
  const detail = page.url();
  page.once("dialog", d => void d.dismiss());
  await page.locator("main").getByRole("link", { name: "목록", exact: true }).click();
  await expect(page).toHaveURL(detail);
  page.once("dialog", d => void d.dismiss());
  await page.locator('.lnb a[href="/admin/support/assistant"]').first().click();
  await expect(page).toHaveURL(detail);
  const backPrompt = page.waitForEvent("dialog");
  await page.evaluate(() => history.back());
  await (await backPrompt).dismiss();
  await expect(page.getByLabel("제목", { exact: true })).toHaveValue("저장할 제목");
  page.once("dialog", d => void d.dismiss());
  await page.locator("main form").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByLabel("제목", { exact: true })).toHaveValue("저장할 제목");
  expect(writes).toEqual([]);
  await page.locator("main form").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`support/assistant\\?q=${encodeURIComponent("보존")}$`));
  expect(writes).toEqual([{ title: "저장할 제목", body: "저장된 내용", published: false, expectedVersion: 1 }]);
  expect(await page.evaluate(() => !!history.state?.unsavedGuard)).toBe(false);
});

for (const action of ["hide", "delete"] as const) test(`도우미 ${action} 성공만 초안 보호를 해제하고 정상 상태로 이동한다`, async ({ page }) => {
  let reads = 0, hidden = false;
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/assistant/docs") { reads++; await json(route, { items: hidden && action === "delete" ? [] : [{ id: id(1), title: "원본 문서", body: "원본 내용", published: action === "hide" && !hidden, version: 1, updatedAt: at }] }); return true; }
    if (path === "/api/admin/assistant/questions") { await json(route, { items: [] }); return true; }
    if (path === `/api/admin/assistant/docs/${id(1)}`) { hidden = true; await json(route, { ok: true }); return true; }
    return false;
  });
  await page.goto(`/admin/support/assistant/${id(1)}`);
  await page.getByLabel("제목", { exact: true }).fill("작성 중 제목");
  await page.locator("main").getByRole("button", { name: action === "hide" ? "숨기기" : "삭제", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: action === "hide" ? "숨기기" : "지우기", exact: true }).click();
  if (action === "hide") { await expect(page.getByText("자료를 숨겼습니다.", { exact: true })).toBeVisible(); expect(reads).toBe(2); }
  else await expect(page).toHaveURL(/support\/assistant$/);
  expect(await page.evaluate(() => !!history.state?.unsavedGuard)).toBe(false);
});

// Direct entry and reload have no in-app previous route: ← must confirm and consume the guard before fallback.
const backCases = [
  { name: "계정", path: `/admin/accounts/${id(1)}`, list: "/admin/accounts?q=kept", label: "이름", value: "보관할 이름" },
  { name: "가격", path: "/admin/billing/plans/INTEGRATED", list: "/admin/billing/plans", action: "가격 변경", label: "판매가", value: "180000" },
  { name: "체험", path: "/admin/billing/plans/INTEGRATED", list: "/admin/billing/plans", action: "체험 한도 변경", label: "알림톡·문자", value: "1" },
  { name: "메일 수량", path: "/admin/billing/plans/INTEGRATED", list: "/admin/billing/plans", action: "월 무료 메일 수량 변경", label: "월 주문·배송 안내 메일 무료 수량", value: "101" },
  { name: "방송 종료", path: `/admin/ops/live/${id(1)}`, list: "/admin/ops/live", label: "사유 (필수)", value: "보관할 종료 사유" },
  { name: "선택 메모", path: `/admin/partners/bulk-note?ids=${id(1)}`, list: "/admin/partners?q=kept", label: "메모", value: "보관할 내부 메모" },
  { name: "선택 반려", path: `/admin/partners/applications/bulk?ids=${id(1)}&mode=reject`, list: "/admin/partners/applications?q=kept", label: "추가 안내", value: "보관할 반려 사유" },
  { name: "업체", path: `/admin/settings/vendors/${id(1)}?cat=PG`, list: "/admin/settings/vendors?cat=PG", label: "업체 이름", value: "보관할 업체 이름" },
  { name: "업체 비중", path: "/admin/settings/vendors/weights?cat=PG", list: "/admin/settings/vendors?cat=PG", selector: "#w-fee", value: "99" },
  { name: "도우미 문서", path: `/admin/support/assistant/${id(1)}`, list: "/admin/support/assistant?q=kept", label: "제목", value: "보관할 문서 제목" },
];
for (const entry of ["직접 진입", "새로고침"]) for (const scenario of backCases) test(`${scenario.name} ${entry}의 ←는 취소 시 입력을 보존하고 확인 후 목록으로 돌아간다`, async ({ page }) => {
  const writes: unknown[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const vendor = { id: id(1), name: "검수 업체", logoUrl: null, active: true, recommended: false, selected: false, referenceFee: null, memo: null, features: [], ratings: { fee: 8 }, score: 80, ratedCount: 1 };
  await mockAdmin(page, async (route, path) => {
    if (route.request().method() !== "GET") { writes.push(route.request().postDataJSON()); await json(route, { error: "unexpected_write" }, 409); return true; }
    if (path === "/api/admin/admins") { await json(route, { admins: [account(1)] }); return true; }
    if (path === "/api/admin/plans") { await json(route, { plans: [plan] }); return true; }
    if (path === "/api/admin/service-vendors") { await json(route, { categories: [{ category: "PG", featureKeys: [], criteria: [{ key: "fee", weight: 100 }], vendors: [vendor] }] }); return true; }
    if (path === `/api/admin/ops/live-broadcasts/${id(1)}`) { await json(route, { broadcast: { broadcastId: id(1), sellerId: id(2), shopName: "방송 몰", title: "확인 방송" } }); return true; }
    if (path === "/api/admin/ops/live-broadcasts") { await json(route, { at, items: [], orderRate: { total: 0 } }); return true; }
    if (path === `/api/admin/sellers/${id(1)}`) { await json(route, { seller: { id: id(1), shopName: "선택 몰" } }); return true; }
    if (path === "/api/admin/assistant/docs") { await json(route, { items: [{ id: id(1), title: "원본 문서", body: "공개 자료", published: false, version: 1, updatedAt: at }] }); return true; }
    if (path === "/api/admin/sellers") { await json(route, { sellers: [], total: 0, summary: { total: 0, normal: 0, trial: 0, overdue: 0, locked: 0, suspended: 0, closed: 0, pgError: 0, pgNone: 0, payoutEnabled: 0, live: 0, pendingApplications: 0 } }); return true; }
    if (path === "/api/admin/sellers/applications") { await json(route, { applications: [], industries: [], chips: { all: 0, clear: 0, review: 0, supplement: 0, over48h: 0, today: 0 }, total: 0, nextCursor: null, kpi: { pending: 0, needsReview: 0, clear: 0, supplement: 0, over48h: 0, receivedToday: 0, approvedToday: 0, autoApprovedToday: 0, rejectedToday: 0, avgHandlingHours: { thisWeek: null, lastWeek: null } } }); return true; }
    return false;
  });
  const target = new URL(scenario.path, "http://localhost");
  target.searchParams.set("returnTo", scenario.list);
  await page.goto(target.pathname + target.search);
  if (entry === "새로고침") await page.reload();
  if (scenario.action) await page.getByRole("button", { name: scenario.action, exact: true }).click();
  const field = scenario.selector ? page.locator(scenario.selector) : page.getByLabel(scenario.label!, { exact: true });
  await field.fill(scenario.value);
  await expect.poll(() => page.evaluate(() => !!history.state?.unsavedGuard)).toBe(true);
  const detail = page.url();
  const confirmations: string[] = [];
  page.once("dialog", dialog => { confirmations.push(dialog.message()); void dialog.dismiss(); });
  await page.locator("main").getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(detail);
  await expect(field).toHaveValue(scenario.value);
  await expect.poll(() => page.evaluate(() => !!history.state?.unsavedGuard)).toBe(true);
  page.once("dialog", dialog => { confirmations.push(dialog.message()); void dialog.accept(); });
  await page.locator("main").getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname + url.search === scenario.list);
  expect(confirmations).toEqual(Array(2).fill("저장하지 않은 변경이 있습니다. 이 화면을 나가시겠습니까?"));
  expect(await page.evaluate(() => !!history.state?.unsavedGuard)).toBe(false);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

const infraConnection = { key: "mail", name: "메일 연결", purpose: "발송", expiresOn: "2030-01-01", daysLeft: 20, lastOkAt: null, lastAuthErrorAt: null, lastAuthErrorCode: null, status: "ok", version: 7 };
const messageSettings = { chargingEnabled: false, platformDailyLimit: 100, platformMonthlyLimit: 1000, prices: [{ channel: "SMS", unitPrice: 12, next: null }], plans: [], usage: { today: { used: 0, limit: 100 }, thisMonth: { used: 0, limit: 1000 }, skippedPlatformLimit: 0 } };

test("연결 목록은 쓰기 없이 상세로 이동하고 원 모니터·단가 설정을 유지한다", async ({ page }) => {
  const writes: string[] = [];
  const sample = { takenAt: at, instance: "fixture", disk: { totalBytes: 100, usedBytes: 10, usedPct: 10 }, memory: { totalBytes: 100, usedBytes: 10, usedPct: 10 }, cpu: { count: 2, load1: 0.1, usedPct: 5 }, db: { sizeBytes: 10, connections: 1, maxConnections: 10, connectionsPct: 10 }, backup: { lastAt: at, count: 1, totalBytes: 10 } };
  await mockAdmin(page, async (route, path) => {
    if (route.request().method() !== "GET") writes.push(path);
    if (path === "/api/admin/infra/status") { await json(route, { checkedAt: at, thresholds: { warnPct: 80, criticalPct: 90, backupMaxAgeHours: 24 }, current: sample, signals: [], snapshots: [] }); return true; }
    if (path === "/api/admin/infra/cost") { await json(route, { checkedAt: at, month: "2026-10", prices: {}, priceVersion: 3, items: [], limited: [], totals: { accruedWon: 0, projectedWon: 0 } }); return true; }
    if (path === "/api/admin/infra/connections") { await json(route, { connections: [infraConnection] }); return true; }
    return false;
  });
  await page.goto("/admin/ops/infra?view=connections");
  const row = page.getByTestId("infra-conn-row");
  await expect(row).toContainText("2030-01-01");
  await expect(row.locator("input,button")).toHaveCount(0);
  await expect(row.getByRole("link", { name: "만료일 상세" })).toHaveAttribute("href", /returnTo=%2Fadmin%2Fops%2Finfra%3Fview%3Dconnections/);
  await expect(page.getByLabel("서버 (월 1대) 단가")).toBeVisible();
  await row.getByRole("link", { name: "만료일 상세" }).click();
  await expect(page.getByLabel("메일 연결 만료일")).toHaveValue("2030-01-01");
  expect(writes).toEqual([]);
});

test("만료일 상세는 409 초안을 보존하고 명시 새로고침 뒤 기존 버전·null PUT을 보낸다", async ({ page }) => {
  const writes: unknown[] = [];
  let version = 7;
  let expiry: string | null = "2030-01-01";
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/infra/connections") { await json(route, { connections: [{ ...infraConnection, version, expiresOn: expiry }] }); return true; }
    if (path === "/api/admin/infra/connections/mail/expiry") {
      expect(route.request().method()).toBe("PUT");
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) { version = 8; await json(route, { error: "version_conflict" }, 409); }
      else { expiry = null; version = 9; await json(route, { expiresOn: expiry, version }); }
      return true;
    }
    return false;
  });
  await page.goto("/admin/ops/infra/connections/mail?returnTo=%2Fadmin%2Fops%2Finfra%3Fview%3Dconnections");
  const form = page.locator("main form");
  await form.getByLabel("메일 연결 만료일").fill("2031-02-03");
  await form.getByRole("button", { name: "만료일 저장" }).click();
  await expect(form.getByRole("alert")).toContainText("다른 곳에서 먼저 바뀌었습니다");
  await expect(form.getByLabel("메일 연결 만료일")).toHaveValue("2031-02-03");
  page.once("dialog", d => d.dismiss());
  await form.getByRole("button", { name: "새로 불러오기" }).click();
  await expect(form.getByLabel("메일 연결 만료일")).toHaveValue("2031-02-03");
  page.once("dialog", d => d.accept());
  await form.getByRole("button", { name: "새로 불러오기" }).click();
  await expect(form.getByLabel("메일 연결 만료일")).toHaveValue("2030-01-01");
  await form.getByLabel("메일 연결 만료일").fill("");
  await form.getByRole("button", { name: "만료일 저장" }).click();
  await expect(page.getByText("만료일을 저장했습니다 · 로그 추적에 남겼습니다")).toBeVisible();
  await expect(form.getByLabel("메일 연결 만료일")).toHaveValue("");
  await expect(form.getByRole("button", { name: "만료일 저장" })).toBeDisabled();
  expect(writes).toEqual([{ expiresOn: "2031-02-03", expectedVersion: 7 }, { expiresOn: null, expectedVersion: 8 }]);
});

test("연결 상세는 읽기 실패를 누락으로 숨기지 않고 재시도하며 잘못된 복귀 경로를 제한한다", async ({ page }) => {
  let reads = 0;
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/infra/connections") { ++reads; await json(route, reads === 1 ? { error: "unavailable" } : { connections: [] }, reads === 1 ? 503 : 200); return true; }
    return false;
  });
  await page.goto("/admin/ops/infra/connections/missing?returnTo=%2Fadmin%2Faccounts%3Fpage%3D2");
  await expect(page.getByText("연결을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: "목록", exact: true })).toHaveAttribute("href", "/admin/ops/infra");
  await page.locator("main").getByRole("button", { name: /다시/ }).click();
  await expect(page.getByText("연결을 찾을 수 없습니다.", { exact: true })).toBeVisible();
  await expect(page.locator("main form")).toHaveCount(0);
});

test("발송 요금 목록은 상세 링크만 제공하며 상세는 원 상한·POST·실패 초안을 보존한다", async ({ page }) => {
  const writes: unknown[] = [];
  await mockAdmin(page, async (route, path) => {
    if (path === "/api/admin/message-settings") { await json(route, messageSettings); return true; }
    if (path === "/api/admin/message-prices/SMS") { expect(route.request().method()).toBe("POST"); writes.push(route.request().postDataJSON()); await json(route, writes.length === 1 ? { message: "다른 곳에서 먼저 수정됐습니다." } : {}, writes.length === 1 ? 409 : 200); return true; }
    return false;
  });
  await page.goto("/admin/settings/messages?view=prices");
  await expect(page.getByTestId("price-row").getByRole("button")).toHaveCount(0);
  await page.getByTestId("price-row").getByRole("link", { name: "요금 상세" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const form = page.locator("main form");
  await form.getByLabel("단가", { exact: true }).fill("100001");
  await expect(form.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await form.getByLabel("단가", { exact: true }).fill("20");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("다른 곳에서 먼저 수정됐습니다.");
  await expect(form.getByLabel("단가", { exact: true })).toHaveValue("20");
  await form.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/settings\/messages\?view=prices$/);
  expect(writes).toEqual([{ unitPrice: 20 }, { unitPrice: 20 }]);
});

for (const reload of [false, true]) {
  for (const kind of ["expiry", "price"] as const) {
    test(`${kind} 상세 ${reload ? "새로고침" : "직접 진입"} 뒤 헤더 취소는 입력을 보존하고 확인은 정확 목록으로 복귀한다`, async ({ page }) => {
      const errors: string[] = [];
      const writes: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      await mockAdmin(page, async (route, path) => {
        if (route.request().method() !== "GET") writes.push(path);
        if (path === "/api/admin/infra/connections") { await json(route, { connections: [infraConnection] }); return true; }
        if (path === "/api/admin/message-settings") { await json(route, messageSettings); return true; }
        return false;
      });
      const list = kind === "expiry" ? "/admin/ops/infra?view=connections" : "/admin/settings/messages?view=prices";
      const detail = kind === "expiry" ? "/admin/ops/infra/connections/mail" : "/admin/settings/messages/SMS";
      await page.goto(`${detail}?returnTo=${encodeURIComponent(list)}`);
      if (reload) await page.reload();
      const field = page.locator("main form").getByLabel(kind === "expiry" ? "메일 연결 만료일" : "단가", { exact: true });
      const draft = kind === "expiry" ? "2031-02-03" : "21";
      await field.fill(draft);
      page.once("dialog", d => d.dismiss());
      await page.getByRole("button", { name: "뒤로", exact: true }).click();
      await expect(field).toHaveValue(draft);
      page.once("dialog", d => d.accept());
      await page.getByRole("button", { name: "뒤로", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(list.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

for (const path of ["/admin/ops/infra/connections/mail", "/admin/settings/messages/SMS"]) {
  test(`${path} 직접 진입에서도 기존 읽기 전용 권한이 저장을 열지 않는다`, async ({ page }) => {
    const writes: string[] = [];
    await mockAdmin(page, async (route, api) => {
      if (route.request().method() !== "GET") writes.push(api);
      if (api === "/api/admin/infra/connections") { await json(route, { connections: [infraConnection] }); return true; }
      if (api === "/api/admin/message-settings") { await json(route, messageSettings); return true; }
      return false;
    }, "READ_ONLY");
    await page.goto(path);
    await expect(page.getByText("이 화면을 볼 권한이 없습니다", { exact: false })).toBeVisible();
    await expect(page.locator("main form")).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}
