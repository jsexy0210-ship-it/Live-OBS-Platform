import { expect, request, test, type Page } from "@playwright/test";
import { jpeg, png } from "../unit/shopContentFixtures";
import { submitSellerLogin } from "./sellerLogin";

// SA-060 쇼핑몰 정보 · 로고(파트너스 관리자)와 구매자 쇼핑몰 머리 표시. 실행 시작·끝에 데모 쇼핑몰 로고를 지운다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SHOT = "tests/e2e/screenshots";

async function clearLogo() {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
  try {
    expect((await ctx.post("/api/seller/auth/login", { data: { email: "demo-owner@example.com", password: PASSWORD } })).ok()).toBe(true);
    expect((await ctx.delete("/api/seller/shop-content/logo")).ok()).toBe(true);
  } finally {
    await ctx.dispose();
  }
}

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await clearLogo();
});
test.afterAll(clearLogo);

// 브라우저 캔버스로 만든 실제 PNG 로고(둥근 배경 + 글자)
async function canvasLogo(page: Page, size: number): Promise<Buffer> {
  const b64 = await page.evaluate((s) => {
    const cv = document.createElement("canvas");
    cv.width = s;
    cv.height = s;
    const g = cv.getContext("2d")!;
    g.fillStyle = "#1f1147";
    g.fillRect(0, 0, s, s);
    g.fillStyle = "#ffc451";
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.36, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#1f1147";
    g.font = `bold ${Math.round(s * 0.42)}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("★", s / 2, s / 2);
    return cv.toDataURL("image/png").split(",")[1];
  }, size);
  return Buffer.from(b64, "base64");
}
const file = (name: string, buffer: Buffer, mimeType = "image/png") => ({ name, mimeType, buffer });
const loaded = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0);

test.describe.serial("SA-060 쇼핑몰 로고", () => {
  test("대표자: 쇼핑몰 설정 탭에서 로고를 올리고(검사 안내 포함) 구매자 머리에 보인다", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fshipping");
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await page.getByRole("link", { name: "쇼핑몰 정보" }).click();
    await expect(page).toHaveURL(/\/seller\/settings\/shop$/);
    await expect(page.getByRole("link", { name: "쇼핑몰 정보" })).toHaveAttribute("aria-current", "page");
    // 로고가 없으면 쇼핑몰 이름 첫 글자
    await expect(page.getByText("로고 없음 · 쇼핑몰 이름 첫 글자로 표시")).toBeVisible();
    await expect(page.getByTestId("logo-preview")).toContainText("카");

    const fileInput = page.getByLabel("로고 파일");
    await fileInput.setInputFiles(file("logo.png", jpeg(600, 600)));
    await expect(page.getByText("PNG 파일만 올릴 수 있습니다")).toBeVisible();
    await fileInput.setInputFiles(file("logo.png", png(800, 600)));
    await expect(page.getByText("로고는 가로와 세로가 같은 정사각형이어야 합니다")).toBeVisible();
    await fileInput.setInputFiles(file("logo.png", png(300, 300)));
    await expect(page.getByText("로고는 512~1440px 정사각형이어야 합니다")).toBeVisible();
    await fileInput.setInputFiles(file("logo.png", await canvasLogo(page, 512)));
    await expect(page.getByText("로고를 바꿨습니다 · 쇼핑몰에 바로 반영")).toBeVisible();
    await expect(page.getByText(/^512 × 512px · PNG/)).toBeVisible();
    expect(await loaded(page, '[data-testid="logo-box"] img')).toBe(true);
    expect(await loaded(page, '[data-testid="logo-preview"] img')).toBe(true);
    await page.screenshot({ path: `${SHOT}/SA-060-logo-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByTestId("logo-box").locator("img")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOT}/SA-060-logo-390.png`, fullPage: true });
  });

  test("구매자: 홈·가입 화면 머리에 로고가 보이고, 지우면 첫 글자로 돌아간다", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/shop/demo-shop");
    expect(await loaded(page, ".shop-top img")).toBe(true);
    await page.screenshot({ path: `${SHOT}/SA-060-shop-header-logo-1440.png`, clip: { x: 0, y: 0, width: 1440, height: 120 } });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/shop/demo-shop/signup");
    expect(await loaded(page, ".shop-top img")).toBe(true);
    await page.screenshot({ path: `${SHOT}/SA-060-shop-header-logo-390.png`, clip: { x: 0, y: 0, width: 390, height: 120 } });

    await clearLogo();
    await page.goto("/shop/demo-shop");
    await expect(page.locator(".shop-top img")).toHaveCount(0);
    await expect(page.locator(".shop-top")).toContainText("카");
  });

  test("로그인이 풀린 채 로고·배너 이미지를 올리면 로그인 화면으로 간다(401)", async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fshop");
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/settings\/shop$/);
    await context.clearCookies();
    await page.getByLabel("로고 파일").setInputFiles(file("logo.png", png(512, 512)));
    await expect(page).toHaveURL(/\/seller\/login\?next=%2Fseller%2Fsettings%2Fshop$/);

    await page.goto("/seller/login?next=%2Fseller%2Fbanners");
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/banners$/);
    await page.getByRole("button", { name: "배너 추가" }).first().click();
    await context.clearCookies();
    await page.getByRole("dialog", { name: "배너 추가" }).getByLabel("PC 이미지", { exact: true }).setInputFiles(file("pc.png", png(1200, 400)));
    await expect(page).toHaveURL(/\/seller\/login\?next=%2Fseller%2Fbanners$/);
    // 로고는 그대로(아무것도 저장되지 않음)
    await clearLogo();
  });

  test("「쇼핑몰 설정」 권한 없는 직원: 메뉴 → 쇼핑몰 정보 탭으로 들어가 보기만(올리기·지우기 없음, 볼 수 없는 탭은 안 보임)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/seller/login");
    await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
    await page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "쇼핑몰 설정" }).click();
    await expect(page).toHaveURL(/\/seller\/settings\/shop$/);
    const tabs = page.getByRole("navigation", { name: "쇼핑몰 설정" });
    await expect(tabs.getByRole("link", { name: "쇼핑몰 정보" })).toHaveAttribute("aria-current", "page");
    for (const hidden of ["배송비 정책", "주문 설정", "회원 정책"]) await expect(tabs.getByRole("link", { name: hidden })).toHaveCount(0);
    await expect(page.getByText("보기만 할 수 있습니다. 로고 변경은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.")).toBeVisible();
    await expect(page.getByRole("button", { name: "올리기" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "로고 올리기" })).toHaveCount(0);
    const status = await page.evaluate(async () => (await fetch("/api/seller/shop-content/logo", { method: "DELETE" })).status);
    expect(status).toBe(403);
    await page.screenshot({ path: `${SHOT}/SA-060-staff-readonly-1440.png` });
  });
});
