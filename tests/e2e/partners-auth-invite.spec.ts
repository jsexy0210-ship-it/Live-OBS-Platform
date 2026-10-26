import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { hashToken } from "../../lib/server/auth/token";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

const fixtureToken = "invite-ui-fixture-not-a-real-token";
const password = "invite-ui-password";
const acceptPath = "/api/seller/invite/accept";
const fill = async (page: Page, value = password) => {
  await page.getByLabel("새 비밀번호", { exact: true }).fill(value);
  await page.getByLabel("새 비밀번호 확인", { exact: true }).fill(value);
};
const submit = (page: Page) => page.getByRole("button", { name: "비밀번호 정하기", exact: true }).click();

test.describe("AU-013 응답 대역 UI", () => {
  test("빈 fragment·query 토큰은 무효이고 입력과 요청이 없다", async ({ page }) => {
    let calls = 0;
    await page.route(`**${acceptPath}`, (route) => { calls++; return route.abort(); });
    await page.goto("/seller/invite?token=not-accepted");
    await expect(page.locator(".login-card").getByRole("alert")).toContainText("이 초대 링크는 쓸 수 없습니다");
    await expect(page.getByLabel("새 비밀번호", { exact: true })).toHaveCount(0);
    expect(calls).toBe(0);
    await page.getByRole("link", { name: "로그인으로", exact: true }).click();
    await expect(page).toHaveURL(/\/seller\/login$/);
  });

  test("8자 미만·불일치는 제출 전 차단하고 비밀번호 상한은 200자다", async ({ page }) => {
    let calls = 0;
    await page.route(`**${acceptPath}`, (route) => { calls++; return route.abort(); });
    await page.goto(`/seller/invite#${fixtureToken}`);
    await fill(page, "short");
    await submit(page);
    await expect(page.locator(".login-card").getByRole("alert")).toHaveText("8자 이상 써 주십시오");
    await fill(page);
    await page.getByLabel("새 비밀번호 확인", { exact: true }).fill("different");
    await submit(page);
    await expect(page.locator(".login-card").getByRole("alert")).toHaveText("위에 적은 비밀번호와 다릅니다");
    await expect(page.getByLabel("새 비밀번호", { exact: true })).toHaveAttribute("maxlength", "200");
    expect(calls).toBe(0);
  });

  test("서버 무효 응답은 공통 안내로 바꾸고 비밀번호 칸을 감춘다", async ({ page }) => {
    await page.route(`**${acceptPath}`, (route) => route.fulfill({ status: 400, json: { error: "invalid_invite" } }));
    await page.goto(`/seller/invite#${fixtureToken}`);
    await fill(page);
    await submit(page);
    await expect(page.locator(".login-card").getByRole("alert")).toContainText("만료됐거나 이미 썼거나 잘못된 링크입니다");
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test("응답 유실 뒤 같은 요청 재전송·처리 중 중복 차단·정상 로그인 연결", async ({ page }) => {
    let calls = 0;
    let finish: (() => void) | undefined;
    await page.route(`**${acceptPath}`, async (route) => {
      calls++;
      const body = route.request().postDataJSON();
      expect(body.token === fixtureToken && body.newPassword === password).toBe(true);
      expect(new URL(route.request().url()).search).toBe("");
      if (calls === 1) return route.abort("failed");
      await new Promise<void>((resolve) => { finish = resolve; });
      await route.fulfill({ json: { ok: true, shopSlug: "invite-fixture" } });
    });
    await page.goto(`/seller/invite#${fixtureToken}`);
    await fill(page);
    await submit(page);
    await expect(page.locator(".login-card").getByRole("alert")).toContainText("결과를 확인하지 못했습니다");
    await expect(page.getByLabel("새 비밀번호", { exact: true })).toHaveValue(password);
    await submit(page);
    await expect(page.getByRole("button", { name: "비밀번호를 정하고 있습니다" })).toBeDisabled();
    await expect(page.getByLabel("새 비밀번호", { exact: true })).toBeDisabled();
    await expect.poll(() => !!finish).toBe(true);
    finish!();
    await expect(page.locator(".login-card").getByRole("status")).toContainText("비밀번호를 정했습니다");
    expect(calls).toBe(2);
    expect(new URL(page.url()).hash).toBe("");
    expect((await page.context().cookies()).some((cookie) => cookie.name === "lo_seller")).toBe(false);
    await page.getByRole("link", { name: "로그인", exact: true }).click();
    await expect(page.getByLabel("쇼핑몰 주소(가입할 때 정한 영문 이름)")).toHaveValue("invite-fixture");
    await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue("");
    await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeDisabled();
  });

  test("1440·1024에서 정본 카드 위치와 폭을 유지한다", async ({ page }) => {
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/seller/invite#${fixtureToken}`);
      await expect(page.getByLabel("새 비밀번호", { exact: true })).toBeVisible();
      const box = await page.locator(".login-card").boundingBox();
      expect(box?.width).toBe(420);
      expect(box?.y).toBe(56);
      expect(box?.x).toBe((width - 420) / 2);
      if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `tests/e2e/screenshots/AU-013-${width}.png`, fullPage: true });
    }
  });
});

test.describe("MA-017 응답 대역 UI", () => {
  let role = "SUPER_ADMIN";
  test.beforeEach(async ({ page }) => {
    role = "SUPER_ADMIN";
    await page.route("**/api/maintenance", (route) => route.fulfill({ json: { active: false, scheduled: false } }));
    await page.route("**/api/admin/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/admin/me") return route.fulfill({ json: { id: "fixture-admin", name: "대표자", email: "fixture@example.com", role } });
      if (path === "/api/admin/plans") return route.fulfill({ json: { plans: [{ code: "INTEGRATED", name: "쇼핑몰 통합" }, { code: "OVERLAY_ONLY", name: "오버레이 전용" }] } });
      if (path === "/api/admin/notifications") return route.fulfill({ json: { items: [], unreadCount: 0 } });
      if (path === "/api/admin/impersonation") return route.fulfill({ json: { active: null } });
      if (path === "/api/admin/sellers") return route.fulfill({ json: { sellers: [], total: 0, summary: { pendingApplications: 0 } } });
      return route.fulfill({ status: 500, json: { error: "fixture_unavailable" } });
    });
  });
  const fillPartner = async (page: Page) => {
    await page.getByLabel("쇼핑몰 이름", { exact: true }).fill("초대 시험몰");
    await page.getByLabel("쇼핑몰 주소", { exact: true }).fill("invite-ui");
    await page.getByLabel("대표자 이름", { exact: true }).fill("대표자");
    await page.getByLabel("로그인 이메일", { exact: true }).fill("invite-ui@example.com");
    await page.getByLabel("사유", { exact: true }).fill("첫 계정 생성 시험");
  };

  test("운영·CS·조회 전용은 진입 버튼과 입력·생성 요청이 없다", async ({ page }) => {
    let creates = 0;
    page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/direct-create")) creates++; });
    for (const other of ["OPERATIONS", "CS", "READ_ONLY"]) {
      role = other;
      await page.goto("/admin/partners");
      await expect(page.getByRole("heading", { name: "파트너스 목록", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "파트너스 직접 추가", exact: true })).toHaveCount(0);
      await page.goto("/admin/partners/new");
      await expect(page.getByRole("main")).toContainText("최고관리자만 할 수 있습니다");
      await expect(page.getByLabel("쇼핑몰 이름", { exact: true })).toHaveCount(0);
    }
    expect(creates).toBe(0);
  });

  test("최고관리자 기본 생성은 서버 기본값·지원 필드만 전송하고 링크는 현재 화면에만 둔다", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/admin/sellers/direct-create", async (route) => {
      calls++;
      const body = route.request().postDataJSON();
      expect(Object.keys(body).sort()).toEqual(["shopName", "slug", "ownerName", "ownerEmail", "reason"].sort());
      await route.fulfill({ status: 201, json: { sellerId: "fixture-seller", trialEndsAt: "2999-01-01T03:30:00Z", invite: { path: `/seller/invite#${fixtureToken}`, url: null, expiresAt: "2999-01-01T03:30:00Z" } } });
    });
    await page.goto("/admin/partners");
    await page.getByRole("link", { name: "파트너스 직접 추가", exact: true }).click();
    await fillPartner(page);
    await expect(page.getByLabel("휴대폰", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "파트너스 만들기", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("지금부터 7일");
    await page.getByRole("dialog").getByRole("button", { name: "파트너스 만들기", exact: true }).click();
    await expect(page.getByTestId("created-invite-link")).toContainText("/seller/invite#");
    expect(calls).toBe(1);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes("invite-ui-fixture"))).toBe(false);
    await page.reload();
    await expect(page.getByLabel("쇼핑몰 이름", { exact: true })).toBeVisible();
    await expect(page.getByTestId("created-invite-link")).toHaveCount(0);
  });

  test("커스텀 날짜는 시각 명시 전 생성할 수 없고 확인한 KST 일시를 전송한다", async ({ page }) => {
    let submitted: Record<string, unknown> | null = null;
    await page.route("**/api/admin/sellers/direct-create", (route) => {
      submitted = route.request().postDataJSON();
      return route.fulfill({ status: 400, json: { error: "invalid_trial", message: "체험 종료일을 확인해 주십시오" } });
    });
    await page.goto("/admin/partners/new");
    await fillPartner(page);
    await page.getByLabel("체험 종료 날짜", { exact: true }).fill("2999.01.01");
    await page.getByLabel("체험 종료 날짜", { exact: true }).press("Tab");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("체험 종료 시각(KST)을 선택해 주십시오");
    await expect(page.getByRole("button", { name: "파트너스 만들기", exact: true })).toBeDisabled();
    await page.getByLabel("체험 종료 시각(KST)", { exact: true }).fill("12:30");
    await page.getByLabel("체험 종료 시각(KST)", { exact: true }).press("Tab");
    await page.getByRole("button", { name: "파트너스 만들기", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("2999.01.01 12:30 KST");
    await page.getByRole("dialog").getByRole("button", { name: "파트너스 만들기", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("체험 종료일을 확인해 주십시오");
    expect(submitted?.["trialEndsAt"]).toBe("2999-01-01T03:30:00.000Z");
    await expect(page.getByLabel("쇼핑몰 이름", { exact: true })).toHaveValue("초대 시험몰");
  });

  test("new 경로에는 상세 탭·상세 조회가 없고 실제 ID의 상세 탭은 유지된다", async ({ page }) => {
    let mistaken = false;
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/admin/sellers/new") mistaken = true; });
    await page.goto("/admin/partners/new");
    await expect(page.getByLabel("쇼핑몰 이름", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "파트너스 정보", exact: true })).toHaveCount(0);
    expect(mistaken).toBe(false);
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.getByRole("main").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (process.env.E2E_SCREENSHOTS === "1") await page.screenshot({ path: `tests/e2e/screenshots/MA-017-${width}.png`, fullPage: true });
    }
    await page.goto("/admin/partners/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(page.getByRole("navigation", { name: "파트너스 정보", exact: true })).toBeVisible();
  });
});

test.describe("첫 계정 실제 API·폐기용 DB", () => {
  const makeDb = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  async function fixture(db: PrismaClient, kind: "fresh" | "expired" | "used") {
    const run = randomBytes(5).toString("hex");
    const token = randomBytes(32).toString("base64url");
    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
    const seller = await db.seller.create({ data: {
      slug: `invite-${run}`, shopName: "초대 시험몰", status: "ACTIVE", trialEndsAt: new Date(Date.now() + 86400_000),
      directCreatedByAdminId: randomUUID(), directCreatedAt: new Date(), planId: plan.id,
    } });
    const user = await db.sellerUser.create({ data: { sellerId: seller.id, email: `invite-${run}@example.com`, name: "대표자", isOwner: true, passwordHash: await hashPassword(password) } });
    await db.sellerInvite.create({ data: {
      sellerId: seller.id, sellerUserId: user.id, tokenHash: hashToken(token), createdByAdminId: randomUUID(),
      expiresAt: new Date(Date.now() + (kind === "expired" ? -86400_000 : 86400_000)),
      usedAt: kind === "used" ? new Date(Date.now() - 11 * 60_000) : null,
    } });
    return { seller, user, token };
  }

  test("실제 만료·사용됨은 같은 안내이고 세션을 만들지 않는다", async ({ page }) => {
    const db = makeDb();
    try {
      for (const kind of ["expired", "used"] as const) {
        const invite = await fixture(db, kind);
        await page.goto(`/seller/invite#${invite.token}`);
        await fill(page);
        const response = page.waitForResponse((r) => r.url().endsWith(acceptPath));
        await submit(page);
        expect((await response).status()).toBe(400);
        await expect(page.locator(".login-card").getByRole("alert")).toContainText("이 초대 링크는 쓸 수 없습니다");
        await expect(page.locator('input[type="password"]')).toHaveCount(0);
        expect(await db.sellerSession.count({ where: { sellerId: invite.seller.id } })).toBe(0);
      }
    } finally { await db.$disconnect(); }
  });

  test("실제 수락 응답 유실 재전송 뒤 자동 로그인 없이 본인확인 대기 계정으로 로그인한다", async ({ page }) => {
    const db = makeDb();
    try {
      const run = randomBytes(5).toString("hex");
      const admin = await db.platformAdmin.create({ data: { email: `invite-admin-${run}@example.com`, name: "대표", role: "SUPER_ADMIN", passwordHash: await hashPassword(password) } });
      await page.goto("/admin/login");
      await page.getByLabel("이메일", { exact: true }).fill(admin.email);
      await page.getByLabel("비밀번호", { exact: true }).fill(password);
      const adminLogin = page.waitForResponse((r) => r.url().endsWith("/api/admin/auth/login"));
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      expect((await adminLogin).status()).toBe(200);
      await expect(page).not.toHaveURL(/\/admin\/login/);
      await page.goto("/admin/partners");
      await page.getByRole("link", { name: "파트너스 직접 추가", exact: true }).click();
      await page.getByLabel("쇼핑몰 이름", { exact: true }).fill("첫 계정 시험몰");
      await page.getByLabel("쇼핑몰 주소", { exact: true }).fill(`invite-${run}`);
      await page.getByLabel("대표자 이름", { exact: true }).fill("대표자");
      await page.getByLabel("로그인 이메일", { exact: true }).fill(`invite-${run}@example.com`);
      await page.getByLabel("사유", { exact: true }).fill("첫 계정 전체 흐름 시험");
      await page.getByRole("button", { name: "파트너스 만들기", exact: true }).click();
      const creation = page.waitForResponse((r) => r.url().endsWith("/api/admin/sellers/direct-create"));
      await page.getByRole("dialog").getByRole("button", { name: "파트너스 만들기", exact: true }).click();
      const creationResponse = await creation;
      expect(creationResponse.status()).toBe(201);
      const { sellerId } = await creationResponse.json();
      await expect(page.getByTestId("created-invite-link")).toBeVisible();
      const href = (await page.getByTestId("created-invite-link").textContent())!;
      const invite = { seller: await db.seller.findUniqueOrThrow({ where: { id: sellerId } }), user: await db.sellerUser.findFirstOrThrow({ where: { sellerId, isOwner: true } }), token: new URL(href).hash.slice(1) };
      let calls = 0;
      await page.route(`**${acceptPath}`, async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        if (++calls === 1) return route.abort("failed");
        await route.fulfill({ response });
      });
      await page.goto(`/seller/invite#${invite.token}`);
      await fill(page);
      await submit(page);
      await expect(page.locator(".login-card").getByRole("alert")).toContainText("결과를 확인하지 못했습니다");
      await submit(page);
      await expect(page.locator(".login-card").getByRole("status")).toContainText("비밀번호를 정했습니다");
      expect(calls).toBe(2);
      expect(await db.sellerSession.count({ where: { sellerId: invite.seller.id } })).toBe(0);
      expect((await page.request.get("/api/seller/me")).status()).toBe(401);
      await page.getByRole("link", { name: "로그인", exact: true }).click();
      await expect(page.getByLabel("쇼핑몰 주소(가입할 때 정한 영문 이름)")).toHaveValue(invite.seller.slug);
      await page.getByLabel("이메일", { exact: true }).fill(invite.user.email);
      await page.getByLabel("비밀번호", { exact: true }).fill(password);
      const loginResponse = page.waitForResponse((r) => r.url().endsWith("/api/seller/auth/login"));
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      expect((await loginResponse).status()).toBe(200);
      await expect(page).not.toHaveURL(/\/seller\/login/);
      expect((await page.request.get("/api/seller/me")).status()).toBe(200);
      expect((await db.seller.findUniqueOrThrow({ where: { id: invite.seller.id } })).representativeVerifiedAt).toBeNull();
      const blocked = await page.request.post("/api/seller/staff", {
        headers: { origin: new URL(page.url()).origin },
        data: { email: `staff-${randomBytes(5).toString("hex")}@example.com`, name: "직원", password, permissions: [] },
      });
      expect(blocked.status()).toBe(403);
      expect((await blocked.json()).error).toBe("identity_pending");
    } finally { await db.$disconnect(); }
  });
});
