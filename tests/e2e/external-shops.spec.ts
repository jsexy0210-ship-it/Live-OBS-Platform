import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-006 외부 쇼핑몰 연동. 폐기용 테스트 DB의 데모 파트너스(dev-seed). 서버는 연동 키 환경변수(시험용 임의값)와 BILLING_KEY_SECRET이 있는 개발 서버.
// 쇼핑몰 쪽 주소로 가는 이동은 가로채서 가짜 화면으로 바꾼다(실제 외부 접속 없음).
const password = process.env.E2E_PASSWORD ?? "";
let db: PrismaClient;
let sellerId = "";
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const u = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com" }, select: { sellerId: true } });
  sellerId = u.sellerId;
  await db.externalOAuthState.deleteMany({ where: { sellerId } });
  await db.externalWebhookEvent.deleteMany({ where: { sellerId } });
  await db.externalShopConnection.deleteMany({ where: { sellerId } });
  const rt = sealBillingKey("RT-e2e", sellerId);
  const mk = async (key: string, status: "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECT_PENDING", extra: object = {}) => {
    const c = await db.externalShopConnection.create({ data: { sellerId, shopKey: key, status, refreshTokenCipher: rt, ...extra } });
    ids[key] = c.id;
  };
  await mk("e2e-connected", "CONNECTED", { lastEventAt: new Date(Date.now() - 2 * 60_000) });
  await mk("e2e-reauth", "REAUTH_REQUIRED");
  await mk("e2e-pending", "DISCONNECT_PENDING");
});
test.afterAll(async () => {
  await db.externalOAuthState.deleteMany({ where: { sellerId } });
  await db.externalShopConnection.deleteMany({ where: { sellerId } });
  await db.$disconnect();
});

async function login(page: Page, email = "demo-owner@example.com") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/login");
  await submitSellerLogin(page, email, password);
  await page.waitForURL((url) => !url.pathname.startsWith("/seller/login") && !url.pathname.startsWith("/seller/identity-link"));
}
const fakeShopSide = (page: Page) => page.route("**/*.cafe24api.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>가짜 인증 화면</title>인증" }));

test("대표자: 목록·상태, 새 연결 시작(지원 밖 주소 거절 포함), 다시 연결, 해제 확인과 해제 대기", async ({ page }) => {
  await fakeShopSide(page);
  await login(page);
  await page.goto("/seller/external-shops");
  const rows = page.getByTestId("external-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "e2e-connected" })).toContainText("이어짐");
  await expect(rows.filter({ hasText: "e2e-connected" })).toContainText("2분 전");
  await expect(rows.filter({ hasText: "e2e-reauth" })).toContainText("다시 이어야 함");
  await expect(rows.filter({ hasText: "e2e-pending" })).toContainText("끊는 중");
  await page.screenshot({ path: "tests/e2e/screenshots/external-shops-sa006-1440.png", fullPage: true });

  // 지원 밖 주소는 인증으로 넘어가기 전에 거절
  await page.getByRole("button", { name: "쇼핑몰 더 이어 두기" }).click();
  await page.getByLabel("쇼핑몰 주소").fill("https://evil.example.com");
  await page.getByRole("button", { name: "이 주소로 연결 시작하기" }).click();
  const startDialog = page.getByRole("dialog", { name: "이 쇼핑몰을 연결하시겠습니까?" });
  await startDialog.getByRole("button", { name: "연결 시작하기" }).click();
  await expect(startDialog.getByRole("alert")).toContainText("아직 연결할 수 없는 쇼핑몰입니다");
  await startDialog.getByRole("button", { name: "취소" }).click();
  expect(await db.externalOAuthState.count({ where: { sellerId } })).toBe(0);

  // 지원 주소: 인증 화면으로 이동하고 1회용 state가 남는다
  await page.getByLabel("쇼핑몰 주소").fill("https://e2e-newshop.cafe24.com");
  await page.getByRole("button", { name: "이 주소로 연결 시작하기" }).click();
  await Promise.all([page.waitForURL(/e2e-newshop\.cafe24api\.com\/api\/v2\/oauth\/authorize\?/), page.getByRole("dialog", { name: "이 쇼핑몰을 연결하시겠습니까?" }).getByRole("button", { name: "연결 시작하기" }).click()]);
  const u = new URL(page.url());
  expect(u.searchParams.get("client_id")).toBe("e2e-client");
  expect(u.searchParams.get("state")?.length).toBeGreaterThan(30);
  expect(await db.externalOAuthState.count({ where: { sellerId, shopKey: "e2e-newshop", usedAt: null } })).toBe(1);

  // 다시 연결: 그 연결의 쇼핑몰로 인증 시작
  await page.goto("/seller/external-shops");
  await page.getByTestId("external-row").filter({ hasText: "e2e-reauth" }).getByRole("button", { name: "다시 연결" }).click();
  await Promise.all([page.waitForURL(/e2e-reauth\.cafe24api\.com\/api\/v2\/oauth\/authorize\?/), page.getByRole("dialog", { name: /e2e-reauth 연결을 다시 하시겠습니까/ }).getByRole("button", { name: "다시 연결하기" }).click()]);

  // 해제: 확인 창 → 유지는 아무 일도 없고, 해제하면 쇼핑몰 응답이 없어 끊는 중이 된다
  await page.goto("/seller/external-shops");
  const row = page.getByTestId("external-row").filter({ hasText: "e2e-connected" });
  await row.getByRole("button", { name: "연결 해제" }).click();
  const offDialog = page.getByRole("dialog", { name: "e2e-connected 연결을 해제하시겠습니까?" });
  await expect(offDialog).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/external-shops-sa006-confirm-1440.png", fullPage: true });
  await offDialog.getByRole("button", { name: "취소" }).click();
  await expect(offDialog).toHaveCount(0);
  expect((await db.externalShopConnection.findUniqueOrThrow({ where: { id: ids["e2e-connected"] } })).status).toBe("CONNECTED");
  await row.getByRole("button", { name: "연결 해제" }).click();
  await offDialog.getByRole("button", { name: "연결 해제" }).click();
  await expect(page.getByTestId("external-row").filter({ hasText: "e2e-connected" })).toContainText("끊는 중");
  expect((await db.externalShopConnection.findUniqueOrThrow({ where: { id: ids["e2e-connected"] } })).status).toBe("DISCONNECT_PENDING");
});

test("인증을 마치고 돌아온 결과(?connected·?error)는 알림으로 보이고 주소에서 지워진다", async ({ page }) => {
  await login(page);
  await page.goto("/seller/external-shops?error=invalid_state");
  await expect(page.getByText("연결 요청이 만료됐거나 맞지 않습니다")).toBeVisible();
  await expect(page).toHaveURL(/\/seller\/external-shops$/);
  await page.goto("/seller/external-shops?connected=1");
  await expect(page.getByText("쇼핑몰을 연결했습니다")).toBeVisible();
});

test("권한 없는 직원은 목록만 보고 연결·해제 버튼이 보이지 않는다", async ({ page }) => {
  await login(page, "demo-staff@example.com");
  await page.goto("/seller/external-shops");
  await expect(page.getByTestId("external-row")).toHaveCount(3);
  await expect(page.getByText("목록만 볼 수 있습니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "쇼핑몰 더 이어 두기" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "연결 해제" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "다시 연결" })).toHaveCount(0);
});
