import { expect, test } from "@playwright/test";
import { expectPublicBrand } from "./publicBrand";
import { pricingIntro } from "../../components/public/pricingCopy";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// /about은 서비스 소개(PF-001)다(루트 /는 로그인 이동 유지, 대표님 지시 2026-10-04). 로그인·가입 진입이 보인다.
test("/about은 서비스 소개가 열리고 로그인·가입 진입이 있다", async ({ page }) => {
  await page.goto("/about");
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("당신의 쇼핑몰이,라이브가 되는 순간");
  await page.getByRole("link", { name: "로그인" }).first().click();
  await expect(page).toHaveURL(/\/seller\/login$/);
  await expect(page.locator(".login-card")).toBeVisible();
});

test("PF-001 요금제 조회 실패에는 원인을 알려 주고 빈 이름 문구를 숨긴다", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { name: "지금 필요한 만큼, 내 판매에 맞는 플랜" })).toBeVisible();
  const intro = page.getByTestId("pricing-intro");
  const message = (await intro.textContent())?.trim() ?? "";
  expect(message).not.toContain("두 가지 이용권 · 중에 골라요");
  expect(["요금 정보를 불러오지 못했어요", "지금 가입할 수 있는 이용권이 없어요"].includes(message) || /^(?:이용권 · .+ 중에 골라요|두 가지 이용권 · .+ 중에 골라요)$/.test(message)).toBeTruthy();
});

test("PF-001 요금 안내 문구가 실제 이용권 이름이나 상태를 반영한다", () => {
  expect(pricingIntro(["쇼핑몰 통합", "오버레이 전용"], "available")).toBe("두 가지 이용권 · 쇼핑몰 통합과 오버레이 전용 중에 골라요");
  expect(pricingIntro([], "error")).toBe("요금 정보를 불러오지 못했어요");
  expect(pricingIntro([], "unavailable")).toBe("지금 가입할 수 있는 이용권이 없어요");
});

test("PF-001 모바일 본문 진입·FAQ 키보드와 모션 감소 설정을 지원한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/about");
  const start = page.getByRole("link", { name: "스트림샵 시작하기" }).first();
  await expect(start).toHaveCSS("transition-duration", "0.18s, 0.18s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(start).toHaveCSS("transition-duration", "0s");
  await expect(start).toHaveCSS("animation-name", "none");
  await expect(start).toHaveCSS("scroll-behavior", "auto");
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "본문 바로가기" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeInViewport();
  await skipLink.press("Enter");
  await expect(page).toHaveURL(/\/about#main-content$/);
  await expect(page.locator("#main-content")).toBeFocused();
  await page.goto("/about");
  const faq = page.locator("#faq details").first();
  const summary = faq.locator("summary");
  await summary.focus();
  await expect(summary).toBeFocused();
  await summary.press("Enter");
  await expect(faq).toHaveAttribute("open", "");
  await expect(faq.locator("p")).toBeVisible();
  await summary.press("Enter");
  await expect(faq).not.toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
  await expect(page).toHaveURL(/\/about$/);
});

test("서비스 소개의 가입 신청은 파트너스 가입으로 간다", async ({ page }) => {
  await page.goto("/about");
  await page.locator("header").getByRole("link", { name: "시작하기" }).click();
  await expect(page).toHaveURL(/\/seller\/signup/);
});

test("PF-001 정본은 세 화면 폭과 모바일 가입·기능 진입을 지원한다", async ({ page }) => {
  const waitForPhotos = async () => {
    const hero = page.getByRole("region", { name: "방송 예시 슬라이드" });
    await hero.getByRole("button", { name: "쇼핑 방송 보기", exact: true }).click();
    const photos = page.getByAltText(/^가상 한국인 성인 진행자/);
    await expect(photos).toHaveCount(3);
    for (const photo of await photos.all()) {
      await photo.scrollIntoViewIfNeeded();
      await expect.poll(() => photo.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
    }
    await expect.poll(() => hero.locator("img").evaluate((image) => image.getAnimations().every((animation) => animation.playState === "finished"))).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    const caption = await page.locator('[class*="wideCanvas"] [class*="canvasTitle"]').boundingBox();
    const order = await page.locator('[class*="wideCanvas"] [class*="canvasOrder"]').boundingBox();
    if (!caption || !order) throw new Error("가로 방송 제목과 주문 표시가 보이지 않습니다");
    expect(caption.y + caption.height).toBeLessThanOrEqual(order.y);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/about");
  await expect(page.locator("header").getByText("streamshop", { exact: true })).toBeVisible();
  expect(await page.locator("main").textContent()).not.toMatch(/[↗✳]/);
  await waitForPhotos();
  await page.screenshot({ path: "tests/e2e/screenshots/PF-001-1440.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);

  await page.setViewportSize({ width: 1024, height: 768 });
  await waitForPhotos();
  await page.screenshot({ path: "tests/e2e/screenshots/PF-001-1024.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);

  await page.setViewportSize({ width: 390, height: 844 });
  await waitForPhotos();
  await page.screenshot({ path: "tests/e2e/screenshots/PF-001-390.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator("header").getByRole("link", { name: "시작하기" })).toBeVisible();
  await expect(page.locator("#pricing")).toBeVisible();
  await expect(page.locator("#faq summary")).toHaveCount(5);
  await page.getByRole("link", { name: "스트림샵 기능 자세히 보기" }).click();
  await expect(page).toHaveURL(/\/features$/);
});

test("PF-001 방송 예시 슬라이드는 수동 조작과 자동 전환의 접근성을 지원한다", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/about");
  const hero = page.getByRole("region", { name: "방송 예시 슬라이드" });
  const selected = (name: string) => hero.getByRole("button", { name: `${name} 방송 보기`, exact: true });
  await expect(selected("쇼핑")).toHaveAttribute("aria-pressed", "true");
  await expect(hero.getByRole("button", { name: "방송 예시 자동 전환 일시정지", exact: true })).toBeEnabled();
  await page.clock.runFor(6600);
  await expect(selected("FPS")).toHaveAttribute("aria-pressed", "true");
  await expect(hero.getByText("FPS 방송", { exact: true })).toBeVisible();
  await hero.getByRole("button", { name: "방송 예시 자동 전환 일시정지", exact: true }).click();
  await page.getByRole("link", { name: "스트림샵 시작하기", exact: true }).first().focus();
  await page.mouse.move(0, 0);
  await page.clock.runFor(7000);
  await expect(selected("FPS")).toHaveAttribute("aria-pressed", "true");
  const next = hero.getByRole("button", { name: "다음 방송 예시", exact: true });
  await next.click();
  await expect(selected("TCG")).toHaveAttribute("aria-pressed", "true");
  await expect(hero.locator("img")).toHaveCSS("animation-duration", "0.45s");
  await expect(hero.locator("img")).not.toHaveCSS("animation-name", "none");
  await expect(next).toBeFocused();
  await next.press("ArrowLeft");
  await expect(selected("FPS")).toHaveAttribute("aria-pressed", "true");
  await hero.getByRole("button", { name: "이전 방송 예시", exact: true }).press("Enter");
  await expect(selected("쇼핑")).toHaveAttribute("aria-pressed", "true");
  await selected("TCG").click();
  await expect(selected("TCG")).toHaveAttribute("aria-pressed", "true");
  await page.clock.runFor(7000);
  await expect(selected("TCG")).toHaveAttribute("aria-pressed", "true");
  await selected("쇼핑").click();
  await hero.getByRole("button", { name: "방송 예시 자동 전환 재개", exact: true }).click();
  await page.getByRole("link", { name: "스트림샵 시작하기", exact: true }).first().focus();
  await page.mouse.move(0, 0);
  await page.clock.runFor(6600);
  await expect(selected("FPS")).toHaveAttribute("aria-pressed", "true");
  await hero.hover();
  await page.clock.runFor(7000);
  await expect(selected("FPS")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await selected("FPS").focus();
  await page.clock.runFor(7000);
  await expect(selected("FPS")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: "스트림샵 시작하기", exact: true }).first().focus();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(7000);
  await expect(selected("FPS")).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(hero.getByRole("button", { name: "방송 예시 자동 전환 재개", exact: true })).toBeDisabled();
  await expect(hero.locator("img")).toHaveCSS("animation-name", "none");
  await expect(hero.locator("img")).toHaveCSS("animation-duration", "0s");
  await page.clock.runFor(7000);
  await expect(selected("FPS")).toHaveAttribute("aria-pressed", "true");
  await selected("TCG").press("Space");
  await expect(selected("TCG")).toHaveAttribute("aria-pressed", "true");
  await expect(hero.locator("img")).toHaveCSS("animation-name", "none");
});

test("PF-001 FPS·TCG 예시는 세 폭에서 로드되고 이미지 실패 시 안전하게 대체된다", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/about");
  const hero = page.getByRole("region", { name: "방송 예시 슬라이드" });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const name of ["FPS", "TCG"]) {
      await hero.getByRole("button", { name: `${name} 방송 보기`, exact: true }).click();
      await expect(hero.getByText(`${name} 방송`, { exact: true })).toBeVisible();
      await expect(hero.locator("img")).toHaveAttribute("src", new RegExp(`live-${name.toLowerCase()}-20261011`));
      await expect.poll(() => hero.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await expect(hero.getByText(`${name} 방송 예시 · AI 이미지 · 상품과 주문 정보는 샘플이에요`, { exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveJSProperty("scrollWidth", width);
      await page.screenshot({ path: `tests/e2e/screenshots/PF-001-${name}-${width}.png`, fullPage: true });
    }
  }
  await page.route((url) => url.pathname === "/_next/image" && !!url.searchParams.get("url")?.includes("live-fps-20261011"), (route) => route.abort());
  await page.reload();
  await hero.getByRole("button", { name: "FPS 방송 보기", exact: true }).click();
  await expect(hero.locator("img")).toHaveAttribute("src", /live-host-landscape/);
  await expect.poll(() => hero.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(hero.getByText(/이미지를 불러오지 못해 쇼핑 방송 예시로 대신 보여줘요/)).toBeVisible();
  await page.route((url) => url.pathname === "/_next/image" && !!url.searchParams.get("url")?.includes("live-host-landscape"), (route) => route.abort());
  await page.reload();
  await hero.getByRole("button", { name: "FPS 방송 보기", exact: true }).click();
  await expect(hero.getByRole("status")).toHaveText("방송 예시 이미지를 불러오지 못했어요");
  await expect(hero.locator("img")).toHaveCount(0);
  await expect(page.getByText("방송 화면과 주문 관리 예시 · 상품과 주문 정보는 샘플이에요", { exact: true })).toBeVisible();
});

test("PF-007-1은 정본 헤더와 모바일 메뉴를 유지한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/signup");
  await expectPublicBrand(page, "/branding/streamshop-partners-32-20261010.png");
  await expect(page.getByTestId("signup-step-count")).toHaveText("1 / 5");
  await page.screenshot({ path: "tests/e2e/screenshots/PF-007-1-1440.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: "tests/e2e/screenshots/PF-007-1-1024.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "tests/e2e/screenshots/PF-007-1-390.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", { name: "메뉴" })).toBeVisible();
  await expect(page.locator('.pf-head-r a[href="/seller/signup"]')).toBeHidden();

  const menuButton = page.getByRole("button", { name: "메뉴" });
  await menuButton.press("Enter");
  await expect(page.getByRole("navigation", { name: "모바일 주요 메뉴" })).toBeVisible();
  await menuButton.press("Escape");
  await expect(page.getByRole("navigation", { name: "모바일 주요 메뉴" })).toHaveCount(0);
});

test("최고관리자가 소개 파비콘·공유 카드를 저장하면 공개 소개 head와 이미지에 반영된다", async ({ page, request }) => {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const run = randomBytes(4).toString("hex");
  const password = randomBytes(12).toString("base64url");
  const email = `landing-brand-${run}@example.com`;
  const title = `스트림샵 소개 ${run}`;
  try {
    // 이 hosted 폐기용 fixture에서만 landing 행을 소유한다. 기존 행이 있으면 덮어쓰지 않는다.
    expect(await db.siteBranding.findUnique({ where: { target: "landing" } })).toBeNull();
    await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "소개 브랜딩 검수", role: "SUPER_ADMIN" } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/login");
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호").fill(password);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto("/admin/settings/branding");
    await page.getByRole("radio", { name: "소개 랜딩", exact: true }).click();
    await expect(page.locator('img[src="/branding/streamshop-symbol.png"]').first()).toBeVisible();
    const icon = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#80E8C1" } }).png().toBuffer();
    await page.getByLabel("파비콘 파일").setInputFiles({ name: "landing.png", mimeType: "image/png", buffer: icon });
    await page.getByRole("button", { name: "파비콘 저장", exact: true }).click();
    await expect(page.getByText("파비콘을 저장했습니다.", { exact: true })).toBeVisible();
    await page.getByLabel("제목", { exact: true }).fill(title);
    await page.getByLabel("설명", { exact: true }).fill("소개 공유 설명");
    await page.getByRole("button", { name: "공유 카드 저장", exact: true }).click();
    await expect(page.getByText("공유 카드를 저장했습니다.", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("radio", { name: "소개 랜딩", exact: true }).click();
    await expect(page.getByLabel("제목", { exact: true })).toHaveValue(title);
    await page.screenshot({ path: "tests/e2e/screenshots/PF-001-branding-master-1440.png", fullPage: true });

    await page.goto("/about");
    await expect(page).toHaveTitle(title);
    const iconLink = page.locator('link[rel="icon"][href*="/api/branding/landing/favicon"]');
    await expect(iconLink).toHaveAttribute("href", /^http:\/\/localhost:\d+\/api\/branding\/landing\/favicon\?v=[0-9a-f]{12}$/);
    const og = page.locator('meta[property="og:image"]');
    await expect(og).toHaveAttribute("content", /^http:\/\/localhost:\d+\/api\/branding\/landing\/og\?v=[0-9a-f]{12}$/);
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", "소개 공유 설명");
    const favicon = await request.get((await iconLink.getAttribute("href"))!);
    expect(favicon.status()).toBe(200);
    expect(Buffer.from(await favicon.body())).toEqual(icon);
    const card = await request.get((await og.getAttribute("content"))!);
    expect(card.status()).toBe(200);
    expect(card.headers()["content-type"]).toBe("image/png");
    expect(await sharp(await card.body()).metadata()).toMatchObject({ width: 1200, height: 630 });
    await sharp(await card.body()).toFile("tests/e2e/screenshots/PF-001-branding-og.png");
    await page.goto("/seller/login");
    await expect(page.locator('link[href*="/api/branding/landing/"]')).toHaveCount(0);
  } finally {
    await db.siteBranding.deleteMany({ where: { target: "landing", ogTitle: title } });
    await db.$disconnect();
  }
});
