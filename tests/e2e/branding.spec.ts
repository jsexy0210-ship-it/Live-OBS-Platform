import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 사이트 설정 > 파비콘·공유 카드(마스터 관리자). 마스터 관리자 계정은 시드에 없어 폐기용 테스트 DB(이름이 _test로 끝남)에
// 실행마다 새로 만든다(비밀번호도 실행마다 새로). 브랜딩 값은 처음 상태(기본값)로 지우고 시작한다.
// 확인: 최고관리자가 올린 파비콘·공유 카드가 해당 관리자 화면 head(<link rel="icon">, og:*, twitter:card)에만 들어가는지,
// 형식이 틀린 파일은 안내만 보이고 바뀌지 않는지, 조회 전용 관리자는 바꿀 수 없는지.

const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const superEmail = `super-${run}@example.com`;
const readOnlyEmail = `readonly-${run}@example.com`;

test.beforeAll(async () => {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const passwordHash = await hashPassword(password);
    await db.platformAdmin.createMany({
      data: [
        { email: superEmail, passwordHash, name: "대표", role: "SUPER_ADMIN" },
        { email: readOnlyEmail, passwordHash, name: "조회", role: "READ_ONLY" },
      ],
    });
    await db.siteBranding.deleteMany({});
  } finally {
    await db.$disconnect();
  }
});

async function login(page: Page, email: string) {
  await page.goto("/admin/settings/branding");
  await expect(page).toHaveURL(/\/admin\/login\?next=/);
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("heading", { name: "파비콘 · 공유 카드" })).toBeVisible();
}

const head = async (page: Page, path: string) => {
  await page.goto(path);
  return page.evaluate(() => ({
    icons: [...document.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute("href")),
    ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content"),
    ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute("content"),
    ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute("content"),
    twitterCard: document.querySelector('meta[name="twitter:card"]')?.getAttribute("content"),
  }));
};

test("최고관리자가 파트너스 관리자 파비콘·공유 카드를 바꾸면 파트너스 화면 head에만 반영된다", async ({ page, request }) => {
  await login(page, superEmail);
  await page.getByRole("tab", { name: "파트너스 관리자" }).click();

  // SVG(스크립트 위험)는 안내만 보이고 바뀌지 않는다
  await page.getByLabel("파비콘 파일").setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await page.getByRole("button", { name: "파비콘 변경" }).click();
  await expect(page.getByText("파비콘은 PNG 파일만 업로드할 수 있습니다.")).toBeVisible();
  // 안내가 떠 있는 동안에는 다시 올릴 수 없다
  await expect(page.getByRole("button", { name: "파비콘 변경" })).toBeDisabled();
  await page.getByRole("button", { name: "취소" }).click();

  const icon = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ff3b30" } }).png().toBuffer();
  // 맞는 파일을 고른 뒤 너무 큰 파일로 바꾸면 이전 선택도 지워진다(Codex 지적: 안내와 다른 파일이 올라가지 않게)
  await page.getByLabel("파비콘 파일").setInputFiles({ name: "first.png", mimeType: "image/png", buffer: icon });
  await expect(page.getByRole("button", { name: "파비콘 변경" })).toBeEnabled();
  await page.getByLabel("파비콘 파일").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.concat([icon, Buffer.alloc(300 * 1024)]) });
  await expect(page.getByText("파비콘이 256KB를 넘습니다. 256KB 이하 PNG로 줄여 주십시오.")).toBeVisible();
  await expect(page.getByRole("button", { name: "파비콘 변경" })).toHaveCount(0);
  await expect(page.getByText("first.png")).toHaveCount(0);

  await page.getByLabel("파비콘 파일").setInputFiles({ name: "partners.png", mimeType: "image/png", buffer: icon });
  await page.getByRole("button", { name: "파비콘 변경" }).click();
  await expect(page.getByText("파비콘을 변경했습니다.")).toBeVisible();

  await page.getByLabel("제목").fill("온큐 파트너스 센터");
  await page.getByLabel("설명").fill("방송 주문을 한곳에서 관리합니다");
  // 저장 전 미리보기: 입력한 제목으로 그린 카드
  const preview = page.getByAltText("공유 카드 이미지 미리보기");
  await expect(preview).toHaveAttribute("src", /card-preview\?title=%EC%98%A8%ED%81%90/);
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1200);
  await expect(page.getByText("파비콘을 변경했습니다.")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "tests/e2e/screenshots/branding-settings-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // 좁은 화면에서는 메뉴가 서랍으로 들어간다(옮겨 가는 동안 찍지 않게 기다림)
  await expect.poll(async () => (await page.locator("aside.side").boundingBox())?.x ?? 0).toBeLessThan(-200);
  await page.screenshot({ path: "tests/e2e/screenshots/branding-settings-390.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "공유 카드 저장" }).click();
  await expect(page.getByText("공유 카드를 저장했습니다.")).toBeVisible();

  const seller = await head(page, "/seller/login");
  expect(seller.icons).toEqual([expect.stringMatching(/^\/api\/branding\/seller\/favicon\?v=[0-9a-f]{12}$/)]);
  expect(seller).toMatchObject({ ogTitle: "온큐 파트너스 센터", ogDescription: "방송 주문을 한곳에서 관리합니다", twitterCard: "summary_large_image" });
  expect(seller.ogImage).toMatch(/^http:\/\/localhost:\d+\/api\/branding\/seller\/og\?v=[0-9a-f]{12}$/);
  const fav = await request.get(seller.icons[0]!);
  expect(fav.headers()["content-type"]).toBe("image/png");
  expect(fav.headers()["x-content-type-options"]).toBe("nosniff");
  expect(Buffer.from(await fav.body()).equals(icon)).toBe(true);
  const card = await request.get(seller.ogImage!);
  expect(card.headers()["content-type"]).toBe("image/png");
  const png = Buffer.from(await card.body());
  expect(await sharp(png).metadata()).toMatchObject({ width: 1200, height: 630 });
  await page.screenshot({ path: "tests/e2e/screenshots/branding-seller-login-1440.png" });
  await sharp(png).toFile("tests/e2e/screenshots/branding-og-card-seller.png");

  // 마스터 관리자 화면은 그대로(기본값)
  const admin = await head(page, "/admin/login");
  expect(admin.icons.some((h) => h?.includes("/api/branding/"))).toBe(false);
  expect(admin.ogTitle).toBe("ONQ 마스터 관리자");
});

test("마스터 관리자 공유 카드에 1200×630 이미지를 올리면 og:image가 그 이미지가 되고, 크기가 틀리면 막힌다", async ({ page, request }) => {
  await login(page, superEmail);
  // 정확한 크기를 고르기 전에 먼저 알려 준다(MASTER 결정)
  await expect(page.getByText("PNG 파일만 올릴 수 있습니다. 카드 이미지 크기는 1200×630이며 2MB까지 업로드할 수 있습니다.")).toBeVisible();
  await page.getByRole("radio", { name: "이미지 업로드" }).click();
  const wrong = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#222" } }).png().toBuffer();
  await page.getByLabel("공유 카드 이미지 파일").setInputFiles({ name: "wrong.png", mimeType: "image/png", buffer: wrong });
  await expect(page.getByText("1200×630 크기 이미지를 선택해 주십시오. 선택한 이미지: 800×600")).toBeVisible();
  await expect(page.getByRole("button", { name: "공유 카드 저장" })).toBeDisabled();
  const image = await sharp({ create: { width: 1200, height: 630, channels: 3, background: "#1f4fff" } }).png().toBuffer();
  await page.getByLabel("공유 카드 이미지 파일").setInputFiles({ name: "card.png", mimeType: "image/png", buffer: image });
  await page.getByRole("button", { name: "공유 카드 저장" }).click();
  await expect(page.getByText("공유 카드를 저장했습니다.")).toBeVisible();
  const admin = await head(page, "/admin/login");
  expect(admin.ogImage).toMatch(/\/api\/branding\/admin\/og\?v=[0-9a-f]{12}$/);
  const got = await request.get(admin.ogImage!);
  expect(got.headers()["content-type"]).toBe("image/png");
  expect(Buffer.from(await got.body()).equals(image)).toBe(true);
  // 제목으로 만들기로 돌리면 다시 그린 카드
  await page.goto("/admin/settings/branding");
  await page.getByRole("radio", { name: "제목으로 생성" }).click();
  await page.getByRole("button", { name: "공유 카드 저장" }).click();
  await expect(page.getByText("공유 카드를 저장했습니다.")).toBeVisible();
  const back = await request.get((await head(page, "/admin/login")).ogImage!);
  expect(back.headers()["content-type"]).toBe("image/png");
});

test("조회 전용 관리자는 지금 값만 보고 바꿀 수 없다", async ({ page }) => {
  // 로그인 실패 문구도 합니다체(대표님 지시 2026-10-04)
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(readOnlyEmail);
  await page.getByLabel("비밀번호").fill("wrong-password");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("이메일 또는 비밀번호가 올바르지 않습니다.")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/branding-login-error-1440.png" });
  await login(page, readOnlyEmail);
  await expect(page.getByText("최고관리자만 변경할 수 있습니다. 현재는 조회만 가능합니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "공유 카드 저장" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "파일 선택" })).toHaveCount(0);
  await expect(page.getByLabel("제목")).toBeDisabled();
  await page.screenshot({ path: "tests/e2e/screenshots/branding-readonly-1440.png", fullPage: true });
});
