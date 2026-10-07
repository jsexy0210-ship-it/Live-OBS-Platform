import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";
import { renderToStaticMarkup } from "react-dom/server";
import { transpileModule, ModuleKind, JsxEmit } from "typescript";
import { createRequire } from "node:module";

// 기존 데이터를 초기화하지 않고 이번 실행의 별도 tenant와 계정만 만든다.
const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
const run = randomBytes(6).toString("hex");
const password = randomBytes(18).toString("base64url");
const folder = process.env.ONQ_HOME_EVIDENCE_DIR ?? "test-results/home-final";
const emails = { owner: `home-${run}-owner@example.com`, empty: `home-${run}-empty-owner@example.com`, staff: `home-${run}-staff@example.com`, admin: `home-${run}-admin@example.com`, ops: `home-${run}-ops@example.com` };
let sellerId: string;
let otherId: string;
let adminIds: string[];
let emptyId: string;

test.beforeAll(async () => {
  mkdirSync(folder, { recursive: true });
  const passwordHash = await hashPassword(password);
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
  const seller = await db.seller.create({ data: { slug: `home-final-${run}`, shopName: "홈 정본 검증 상점", status: "ACTIVE", planId: plan.id, trialEndsAt: new Date("2999-12-31") } });
  sellerId = seller.id;
  const other = await db.seller.create({ data: { slug: `home-other-${run}`, shopName: "다른 홈 검증 상점", status: "ACTIVE", planId: plan.id, trialEndsAt: new Date("2999-12-31") } });
  otherId = other.id;
  const empty = await db.seller.create({ data: { slug: `home-empty-${run}`, shopName: "처리할 일 없는 상점", status: "ACTIVE", planId: plan.id } });
  emptyId = empty.id;
  // 생성 직후 식별 메타부터 기록하여 중간 실패에도 소유분을 찾을 수 있다.
  writeFileSync(`${folder}/fixture-${run}.json`, JSON.stringify({ run, sellerId, otherId, emptyId, slug: seller.slug, emails, createdAt: new Date().toISOString() }));
  await db.sellerUser.create({ data: { sellerId, email: emails.owner, passwordHash, name: "홈 검증 대표자", isOwner: true } });
  await db.sellerUser.create({ data: { sellerId, email: emails.staff, passwordHash, name: "홈 검증 직원", permissions: ["ORDER_SHIPPING"] } });
  await db.sellerUser.create({ data: { sellerId: emptyId, email: emails.empty, passwordHash, name: "빈 홈 검증 대표자", isOwner: true } });
  const admins = await Promise.all([db.platformAdmin.create({ data: { email: emails.admin, passwordHash, name: "홈 검증 관리자", role: "SUPER_ADMIN" } }), db.platformAdmin.create({ data: { email: emails.ops, passwordHash, name: "홈 검증 운영", role: "OPERATIONS" } })]);
  adminIds = admins.map((a) => a.id);
  writeFileSync(`${folder}/fixture-${run}.json`, JSON.stringify({ run, sellerId, otherId, emptyId, slug: seller.slug, adminIds, emails, createdAt: new Date().toISOString() }));
  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + 30 * 86400000);
  for (const id of [sellerId, emptyId]) {
    await db.seller.update({ where: { id }, data: { trialEndsAt: null } });
    const subscription = await db.sellerSubscription.create({ data: { sellerId: id, planId: plan.id, status: "ACTIVE", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd } });
    await db.subscriptionPayment.create({ data: { sellerId: id, subscriptionId: subscription.id, amount: 199000, status: "PAID", periodStart, periodEnd, paidAt: periodStart } });
  }
  await db.sellerOnboarding.create({ data: { sellerId, dismissedAt: new Date() } });
  await db.sellerOnboarding.create({ data: { sellerId: emptyId, dismissedAt: new Date() } });
  const grade = await db.memberGrade.create({ data: { sellerId, displayName: "일반", sortOrder: 0, systemKey: "BASIC" } });
  const otherGrade = await db.memberGrade.create({ data: { sellerId: otherId, displayName: "일반", sortOrder: 0, systemKey: "BASIC" } });
  const buyer = await db.buyerMember.create({ data: { sellerId, gradeId: grade.id, identityVerifiedAt: new Date(), loginId: `home-${run}`, passwordHash, name: "홈 검증 구매자", phone: "01000000000", broadcastNickname: "검증", ciHash: `home-${run}` } });
  const otherBuyer = await db.buyerMember.create({ data: { sellerId: otherId, gradeId: otherGrade.id, identityVerifiedAt: new Date(), loginId: `other-${run}`, passwordHash, name: "분리 검증", phone: "01000000000", broadcastNickname: "분리", ciHash: `other-${run}` } });
  const now = new Date();
  const old = new Date(now.getTime() - 3 * 86400000);
  const todayStart = new Date(`${new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10)}T00:00:00+09:00`);
  for (const [orderNo, amount, createdAt] of [[4, 5000, new Date(todayStart.getTime() - 86400000 + 60000)], [5, 7000, new Date(todayStart.getTime() - 60000)]] as const) await db.order.create({ data: { sellerId, buyerMemberId: buyer.id, orderNo, broadcastNicknameSnapshot: "검증", totalAmount: amount, status: "PAID", createdAt, paidAt: createdAt } });
  for (const [orderNo, status, createdAt] of [[1, "PENDING_PAYMENT", old], [2, "PENDING_PAYMENT", now], [3, "PAID", now]] as const) await db.order.create({ data: { sellerId, buyerMemberId: buyer.id, orderNo, broadcastNicknameSnapshot: "검증", totalAmount: 5000, status, createdAt, ...(status === "PAID" ? { paidAt: now } : {}) } });
  await db.order.create({ data: { sellerId: otherId, buyerMemberId: otherBuyer.id, orderNo: 1, broadcastNicknameSnapshot: "분리", totalAmount: 9000, status: "PENDING_PAYMENT", createdAt: old } });
  await db.buyerInquiry.create({ data: { sellerId, buyerMemberId: buyer.id, kind: "GENERAL", authorNickname: "검증", title: "검증 문의", body: "검증 문의 본문", status: "WAITING", createdAt: old } });
  const product = await db.product.create({ data: { sellerId, name: "재고 검증", price: 5000, status: "ON_SALE" } });
  await db.productOption.create({ data: { sellerId, productId: product.id, name: "기본", stock: 2 } });
  const soldOut = await db.product.create({ data: { sellerId, name: "품절 검증", price: 5000, status: "ON_SALE" } });
  await db.productOption.create({ data: { sellerId, productId: soldOut.id, name: "기본", stock: 0 } });
  await db.youtubeLiveLink.create({ data: { sellerId, videoId: "homefixture", title: "예정된 검증 방송", status: "UPCOMING", scheduledStartAt: new Date(now.getTime() + 86400000) } });
  await db.broadcastSession.create({ data: { sellerId, title: "진행 중인 검증 방송", status: "LIVE", startedAt: now } });
  await db.broadcastSession.create({ data: { sellerId, title: "종료한 검증 방송", status: "ENDED", startedAt: old, endedAt: new Date(old.getTime() + 3600000) } });
});
test.afterAll(async () => { await db.$disconnect(); }); // 독립 검수 반환 뒤 정확한 소유분만 회수한다.

async function login(page: Page, who: keyof typeof emails) {
  if (who === "owner" || who === "staff" || who === "empty") {
    await page.goto("/seller/login");
    await submitSellerLogin(page, emails[who], password);
    await page.waitForURL((u) => u.pathname === "/seller");
  } else {
    await page.goto("/admin/login");
    await page.getByLabel("이메일").fill(emails[who]);
    await page.getByLabel("비밀번호").fill(password);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await page.waitForURL((u) => u.pathname === "/admin");
  }
  await page.context().storageState({ path: `${folder}/${who}-session.json` });
}

test("FINAL PC 정본 DOM의 본문 구조와 카드·표 규격", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const id of ["SA-002", "MA-001"]) {
    await page.setContent(readFileSync(`design/project/${id}-IA.dc.html`, "utf8").replace(/<link[^>]*>/g, "").replace(/<script[\s\S]*?<\/script>/g, ""));
    for (const file of ["ds/wds/tokens.css", "lop.css"]) await page.addStyleTag({ content: readFileSync(`design/project/${file}`, "utf8") });
    const data = await page.locator("main").evaluate((el) => ({ headings: Array.from(el.querySelectorAll(".sec-t")).map((h) => h.textContent), tables: Array.from(el.querySelectorAll("table")).map((t) => Array.from(t.querySelectorAll("th")).map((h) => h.textContent)), cards: Array.from(el.querySelectorAll(".kpi")).map((c) => ({ label: c.querySelector(".k")?.textContent, padding: getComputedStyle(c).padding, size: c.querySelector(".v") && getComputedStyle(c.querySelector(".v")!).fontSize })) }));
    writeFileSync(`${folder}/source-${id}-1440.json`, JSON.stringify(data, null, 2));
    await page.screenshot({ path: `${folder}/source-${id}-1440.png`, fullPage: true });
    if (id === "SA-002") {
      const performance = page.locator(".kpi").filter({ has: page.locator(".k", { hasText: "결제된 매출" }) });
      expect(await performance.evaluate(el => ({ padding: getComputedStyle(el).padding, size: getComputedStyle(el.querySelector(".v")!).fontSize, gap: getComputedStyle(el.parentElement!).gap }))).toEqual({ padding: "16px", size: "22px", gap: "12px" });
    }
    expect(data.tables).toContainEqual(id === "SA-002" ? ["방송", "상태", "시각", "주문", "매출", "바로 가기"] : ["순위", "파트너스", "결제 금액", "결제된 주문"]);
  }
});

test("FINAL 모바일 React 정본 본문을 직접 렌더한다", async ({ page }) => {
  const localRequire = createRequire(`${process.cwd()}/package.json`);
  const canonical = { exports: {} as { default: () => React.ReactNode } };
  const compiled = transpileModule(readFileSync("design/project/SA-002-M.dc.tsx", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  new Function("require", "exports", compiled)((name: string) => name === "./sa-mobile-links" ? { mobileDesignHref: () => "#" } : localRequire(name), canonical.exports);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.setContent(renderToStaticMarkup(canonical.exports.default()).replace(/<link[^>]*>/g, ""));
  for (const file of ["ds/wds/tokens.css", "lop.css"]) await page.addStyleTag({ content: readFileSync(`design/project/${file}`, "utf8") });
  const body = page.locator(".c24.mob .body").first();
  expect(await body.locator(".todo > a").count()).toBe(5);
  expect(await body.locator(".todo").evaluate(el => getComputedStyle(el).flexDirection)).toBe("column");
  expect(await body.locator("h2").allTextContents()).toEqual(["오늘 처리할 일", "오늘 성과", "방송"]);
  await page.screenshot({ path: `${folder}/source-SA-002-M-390.png`, fullPage: true });
});

test("파트너스 정상 홈 3폭·tenant 숫자·기존 처리 링크", async ({ page }) => {
  await login(page, "owner");
  await expect(page.getByTestId("home-performance")).toBeVisible();
  await expect(page.getByTestId("home-broadcasts").getByRole("link", {name:"준비하기"})).toBeVisible();
  const tasksResponse = await page.request.get("/api/seller/today-tasks");
  expect(tasksResponse.status(), await tasksResponse.text()).toBe(200);
  const tasks = await tasksResponse.json();
  expect(tasks.items.find((t: { key: string }) => t.key === "depositPending")).toMatchObject({ count: 2, overTwoDays: 1 });
  expect(tasks.items.find((t: { key: string }) => t.key === "inquiryWaiting").oldestAt).toBeTruthy();
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const elapsed = await (await page.request.get(`/api/seller/stats/overview?from=${today}&to=${today}&compare=elapsed`)).json();
  expect(elapsed.summary.previous.revenue).toBe(5000);
  const ordinary = await (await page.request.get(`/api/seller/stats/overview?from=${today}&to=${today}`)).json();
  expect(ordinary.summary.previous.revenue).toBe(12000);
  expect((await page.request.get("/api/seller/stats/overview?from=2020-01-01&to=2020-01-01&compare=elapsed")).status()).toBe(400);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if(width < 1024) await expect.poll(() => page.locator(".lnb").evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await expect(page.getByTestId("home-tasks").locator(".home-task")).toHaveCount(5);
    await expect(page.getByTestId("home-task-stockLow").locator("a.l")).toHaveAttribute("href", /stock=low/);
    await expect(page.getByTestId("home-task-stockLow").getByRole("link", { name: /품절.*보기/ })).toHaveAttribute("href", /stock=out/);
    await expect(page.getByTestId("home-broadcasts").locator("th")).toHaveText(["방송", "상태", "시각", "주문", "매출", "바로 가기"]);
    const data = await page.locator(".home").evaluate((el) => ({ headings: Array.from(el.querySelectorAll(".home-sec h2")).map((h) => h.textContent?.trim()), taskLabels: Array.from(el.querySelectorAll(".home-task .l")).map((h) => h.textContent), taskColumns: getComputedStyle(el.querySelector(".home-tasks")!).gridTemplateColumns.split(" ").length, overflow: document.documentElement.scrollWidth > innerWidth, gap: getComputedStyle(el).gap }));
    expect(data.headings).toEqual(["오늘 처리할 일", "오늘 성과", "방송"]);
    expect(data.taskLabels).toEqual(["입금 확인 필요", "배송 준비 필요", "문의 답변 필요", "재고 부족 상품", "반품 요청 답변 필요"]);
    expect(data.overflow).toBe(false);
    expect(data.taskColumns).toBe(width === 390 ? 1 : 5);
    const copy = await page.locator(".home").evaluate(el => ({ instruction: (el.querySelector(".home-sec-h .sub") as HTMLElement).innerText, average: (el.querySelectorAll(".home-performance .stat .t-l2")[2] as HTMLElement).innerText }));
    expect(copy.instruction).toContain(width === 390 ? "숫자를 누르면 그 목록으로" : "숫자를 누르면 해당 조건이 걸린 목록으로 이동합니다");
    expect(copy.average).toBe(width === 390 ? "주문 1건당 평균" : "주문 1건당 평균 금액");
    const performance = await page.getByTestId("home-performance").evaluate(el => ({ gap: getComputedStyle(el.querySelector(".sts-kpis")!).gap, padding: getComputedStyle(el.querySelector(".stat")!).padding, size: getComputedStyle(el.querySelector(".v")!).fontSize }));
    expect(performance).toEqual(width === 390 ? { gap: "0px", padding: "12px 16px", size: "18px" } : { gap: "12px", padding: "16px", size: "22px" });
    const widths = await page.getByTestId("home-performance").locator(".stat").evaluateAll(els => els.map(el => el.getBoundingClientRect().width));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    writeFileSync(`${folder}/actual-SA-002-${width}.json`, JSON.stringify({ ...data, copy, performance, widths }, null, 2));
    await page.screenshot({ path: `${folder}/actual-SA-002-${width}.png`, fullPage: true });
  }
  await page.getByTestId("home-task-stockLow").locator("a.l").click();
  await expect(page).toHaveURL(/stock=low/);
  await expect(page.getByTestId("product-card").getByText("재고 검증", { exact: true })).toBeVisible();
  await expect(page.getByText("품절 검증", { exact: true })).toHaveCount(0);
  await page.goto("/seller");
  await page.getByTestId("home-task-stockLow").getByRole("link", { name: /품절.*보기/ }).click();
  await expect(page).toHaveURL(/stock=out/);
  await expect(page.getByTestId("product-card").getByText("품절 검증", { exact: true })).toBeVisible();
  await expect(page.getByText("재고 검증", { exact: true })).toHaveCount(0);
  await page.goto("/seller");
  const href = await page.getByTestId("home-task-depositPending").getAttribute("href");
  expect(href).toBe("/seller/orders/deposits");
  await page.goto(href!);
  await expect(page.locator("main")).toContainText("입금");
});

test("마스터 정상 홈 3폭·기간 선택·4열 상위 표", async ({ page }) => {
  await login(page, "admin");
  await expect(page.getByTestId("dash-sellers-active")).toBeVisible();
  await expect(page.getByTestId("stats-orders").getByTestId("stats-kpi")).toHaveCount(3);
  await expect(page.getByTestId("infra-card-cost")).toBeVisible();
  await expect(page.getByTestId("stats-growth").getByTestId("stats-kpi")).toHaveCount(2);
  await expect(page.getByTestId("stats-subscriptions").getByTestId("stats-kpi")).toHaveCount(1);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if(width < 1024) await expect.poll(() => page.locator(".lnb").evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    const data = await page.locator(".admin-home").evaluate((el) => ({ headings: Array.from(el.querySelectorAll("h2")).map((h) => h.textContent), table: Array.from(el.querySelectorAll("[data-testid=stats-top] th")).map((h) => h.textContent), overflow: document.documentElement.scrollWidth > innerWidth }));
    expect(data.headings).toEqual(["오늘 처리할 일", "인프라 · 비용", "파트너스", "오늘", "구독", "기간별 현황", "주문 · 결제", "파트너스 성장", "상위 5 파트너스", "구독 매출 (최근 6개월)"]);
    expect(data.overflow).toBe(false);
    const metrics = await page.locator(".admin-home-infra-meter-value").evaluateAll(els => els.map(el => ({ text: el.textContent, whiteSpace: getComputedStyle(el).whiteSpace, rects: el.getClientRects().length })));
    for (const metric of metrics) expect(metric).toMatchObject({ whiteSpace: "nowrap", rects: 1 });
    if (data.table.length) expect(data.table).toEqual(["순위", "파트너스", "결제 금액", "결제된 주문"]);
    writeFileSync(`${folder}/actual-MA-001-${width}.json`, JSON.stringify({ ...data, metrics }, null, 2));
    await page.screenshot({ path: `${folder}/actual-MA-001-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "최근 30일", exact: true }).click();
  await expect(page.getByRole("button", { name: "최근 30일", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("stats-orders")).toContainText("지난 30일");
});

test("직원 권한 필터와 운영 관리자 인프라 비노출", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await login(page, "staff");
  await expect(page.getByText("직원 권한 없음", { exact: true })).toBeVisible();
  await expect(page.getByTestId("home-tasks").locator("a")).toHaveCount(3);
  const tasks = await (await page.request.get("/api/seller/today-tasks")).json();
  expect(tasks.items.map((i: { key: string }) => i.key)).toEqual(["depositPending", "shipPending", "returnRequested"]);
  expect((await page.request.get("/api/seller/stats/overview?from=2026-10-07&to=2026-10-07&compare=elapsed")).status()).toBe(403);
  await page.screenshot({ path: `${folder}/actual-SA-002-permission-390.png`, fullPage: true });
  await page.context().clearCookies();
  await login(page, "ops");
  await expect(page.getByTestId("dash-sellers-active")).toBeVisible();
  await expect(page.getByTestId("infra-card")).toHaveCount(0);
  expect((await page.request.get("/api/admin/infra/summary")).status()).toBe(403);
});

test("실제 빈 홈은 처리할 일과 방송이 없음을 보여준다", async ({ page }) => {
  await login(page, "empty");
  await expect(page.getByText("지금 처리할 일이 없습니다. 새 주문이 들어오면 여기에 표시됩니다.")).toBeVisible();
  await expect(page.getByText("진행 · 예정 방송이 없습니다. 방송 대시보드에서 첫 방송을 시작해 주십시오.")).toBeVisible();
  await expect(page.getByTestId("home-performance")).toBeVisible();
  expect((await (await page.request.get("/api/seller/today-tasks")).json()).total).toBe(0);
  await page.screenshot({ path: `${folder}/actual-SA-002-empty.png`, fullPage: true });
});

test("구역 오류가 다른 구역을 숨기지 않고 재시도로 복구된다", async ({ page }) => {
  await login(page, "owner");
  await page.route("**/api/seller/stats/overview?**", (route) => route.fulfill({ status: 500, json: { error: "fixture_failure" } }));
  await page.reload();
  await expect(page.getByText("오늘 성과를 불러오지 못했습니다", { exact: true })).toBeVisible();
  await expect(page.getByTestId("home-tasks")).toBeVisible();
  await page.unroute("**/api/seller/stats/overview?**");
  await page.getByRole("button", { name: /다시/ }).click();
  await expect(page.getByTestId("home-performance")).toBeVisible();
});
