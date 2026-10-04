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
  await expect.poll(async () => (await page.locator("aside.lnb").boundingBox())?.x ?? 0).toBeLessThan(-200);
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
  // 올린 파비콘이 없는 마스터 관리자 화면은 틸 기본 아이콘(파트너스 기본 아이콘과 다름)
  expect(admin.icons).toEqual(["/branding/onq-admin-32.png"]);

  // 「기본값으로 되돌리기」 뒤에는 파트너스 화면도 기본 아이콘으로 돌아오고, 그 주소가 실제 PNG를 준다
  await page.goto("/admin/settings/branding");
  await page.getByRole("tab", { name: "파트너스 관리자" }).click();
  await page.getByRole("button", { name: "기본값으로 되돌리기" }).click();
  await expect(page.getByText("기본 파비콘으로 되돌렸습니다.")).toBeVisible();
  const reset = await head(page, "/seller/login");
  expect(reset.icons).toEqual(["/branding/onq-32.png"]);
  const def = await request.get(reset.icons[0]!);
  expect(def.status()).toBe(200);
  expect(def.headers()["content-type"]).toBe("image/png");
  expect(await sharp(Buffer.from(await def.body())).metadata()).toMatchObject({ width: 32, height: 32 });
  expect((await request.get("/branding/onq-180.png")).status()).toBe(200);
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

test("조회 전용 관리자는 파비콘·공유 카드 화면을 볼 수 없다", async ({ page }) => {
  // 로그인 실패 문구도 합니다체(대표님 지시 2026-10-04)
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(readOnlyEmail);
  await page.getByLabel("비밀번호").fill("wrong-password");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("이메일이나 비밀번호가 맞지 않습니다")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/branding-login-error-1440.png" });
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  // 설정(MA-080대)은 최고관리자만 보인다(MASTER 결정 2026-10-04): 조회 전용은 메뉴가 없고 주소로 들어가도 권한 안내만 본다
  await page.goto("/admin/settings/branding");
  await expect(page.getByTestId("admin-no-access")).toBeVisible();
  await expect(page.getByRole("button", { name: "공유 카드 저장" })).toHaveCount(0);
  await expect(page.getByLabel("제목")).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/branding-readonly-1440.png", fullPage: true });
});

test("이미지를 연달아 고르면 앞 선택의 크기 확인이 늦게 끝나도 마지막 선택이 남는다(Codex 지적 7차)", async ({ page, request }) => {
  // 이름이 slow로 시작하는 파일은 브라우저 크기 확인(new Image)을 1.5초 늦게 끝낸다
  await page.addInitScript(() => {
    const names = new Map<string, string>();
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => {
      const u = create(o);
      if (o instanceof File) names.set(u, o.name);
      return u;
    };
    const Native = window.Image;
    window.Image = function (this: unknown, w?: number, h?: number) {
      const img = new Native(w, h);
      let onload: ((e: Event) => void) | null = null;
      Object.defineProperty(img, "onload", {
        get: () => onload,
        set: (fn) => {
          onload = fn;
          img.addEventListener("load", (e) => setTimeout(() => onload?.(e), (names.get(img.src) ?? "").startsWith("slow") ? 1500 : 0));
        },
      });
      return img;
    } as unknown as typeof Image;
  });
  await login(page, superEmail);

  // 파비콘: 늦게 끝나는 앞 파일 → 바로 다음 파일
  const red = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ff0000" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 48, height: 48, channels: 4, background: "#0000ff" } }).png().toBuffer();
  await page.getByLabel("파비콘 파일").setInputFiles({ name: "slow-red.png", mimeType: "image/png", buffer: red });
  await page.getByLabel("파비콘 파일").setInputFiles({ name: "blue.png", mimeType: "image/png", buffer: blue });
  await page.waitForTimeout(2000);
  await expect(page.getByText("blue.png")).toBeVisible();
  await expect(page.getByText("slow-red.png")).toHaveCount(0);

  // 공유 카드: 늦게 끝나는 크기가 틀린 앞 파일 → 맞는 다음 파일. 앞 결과의 안내가 뒤 선택을 덮어쓰지 않고, 저장하면 뒤 파일이 올라간다
  await page.getByRole("radio", { name: "이미지 업로드" }).click();
  const wrong = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#222" } }).png().toBuffer();
  const good = await sharp({ create: { width: 1200, height: 630, channels: 3, background: "#00aa55" } }).png().toBuffer();
  await page.getByLabel("공유 카드 이미지 파일").setInputFiles({ name: "slow-wrong.png", mimeType: "image/png", buffer: wrong });
  await page.getByLabel("공유 카드 이미지 파일").setInputFiles({ name: "good.png", mimeType: "image/png", buffer: good });
  await page.waitForTimeout(2000);
  await expect(page.getByText("선택한 이미지: 800×600")).toHaveCount(0);
  await page.getByRole("button", { name: "공유 카드 저장" }).click();
  await expect(page.getByText("공유 카드를 저장했습니다.")).toBeVisible();
  const og = await request.get((await head(page, "/admin/login")).ogImage!);
  expect(Buffer.from(await og.body()).equals(good)).toBe(true);
});

test("마스터 관리자 로고 색은 파트너스 관리자 로고 색과 다르다(대표님 지시 2026-10-04)", async ({ page }) => {
  const logoColor = () => page.locator(".logo-sym").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.goto("/seller/login");
  const partners = await logoColor();
  await page.goto("/admin/login");
  const masterLogin = await logoColor();
  expect(masterLogin).not.toBe(partners);
  // 로그인 버튼(주요 버튼)도 같은 마스터 색
  await page.getByLabel("이메일").fill(superEmail);
  await page.getByLabel("비밀번호").fill(password);
  expect(await page.getByRole("button", { name: "로그인" }).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(masterLogin);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.screenshot({ path: `tests/e2e/screenshots/branding-master-logo-login-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, superEmail);
  const shell = await page.locator("header.gnb").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(shell).toBe(masterLogin);
  expect(shell).not.toBe(partners);
  const sideX = async () => (await page.locator("aside.lnb").boundingBox())?.x ?? -1;
  await page.screenshot({ path: "tests/e2e/screenshots/branding-master-logo-shell-1440.png", fullPage: true });
  // 좁은 화면: 메뉴 서랍을 열어 로고를 보인다(옮겨 가는 동안 찍지 않게 서랍이 멈출 때까지 기다림)
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(sideX).toBeLessThan(-200);
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect.poll(sideX).toBe(0);
  await page.screenshot({ path: "tests/e2e/screenshots/branding-master-logo-shell-390.png" });
});

test("저장 전 입력값이 미리보기에 바로 반영된다(제목·설명·카드 이미지·파비콘, 대표님 지시 2026-10-04)", async ({ page }) => {
  await login(page, superEmail);
  await page.getByRole("tab", { name: "파트너스 관리자" }).click();
  const card = page.getByLabel("공유 카드 미리보기");
  const image = page.getByAltText("공유 카드 이미지 미리보기");
  const icon = page.getByAltText("파비콘 미리보기");
  // 제목·설명: 입력하는 대로 글자가 바뀌고, 제목으로 만든 카드 그림도 새 제목으로 다시 그린다
  await page.getByLabel("제목").fill("미리보기 확인 제목");
  await page.getByLabel("설명").fill("미리보기 확인 설명");
  await expect(card.getByText("미리보기 확인 제목")).toBeVisible();
  await expect(card.getByText("미리보기 확인 설명")).toBeVisible();
  await expect(image).toHaveAttribute("src", `/api/admin/branding/card-preview?title=${encodeURIComponent("미리보기 확인 제목")}`);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1200);
  // 글자 수를 넘으면 마지막으로 그릴 수 있던 카드를 그대로 두고 깨진 그림을 보이지 않는다
  await page.getByLabel("제목").fill("가".repeat(61));
  await page.waitForTimeout(600);
  await expect(image).toHaveAttribute("src", `/api/admin/branding/card-preview?title=${encodeURIComponent("미리보기 확인 제목")}`);
  // 파비콘: 고르기만 해도 공유 카드의 사이트 아이콘이 고른 파일로 바뀐다(저장 전)
  const iconBefore = await icon.getAttribute("src");
  await page.getByLabel("파비콘 파일").setInputFiles({ name: "preview.png", mimeType: "image/png", buffer: await sharp({ create: { width: 64, height: 64, channels: 4, background: "#00aaff" } }).png().toBuffer() });
  await expect(icon).toHaveAttribute("src", /^blob:/);
  expect(await icon.getAttribute("src")).not.toBe(iconBefore);
  // 카드 이미지 올리기: 고른 1200×630 PNG가 바로 미리보기에 나온다
  await page.getByRole("radio", { name: "이미지 업로드" }).click();
  await page.getByLabel("공유 카드 이미지 파일").setInputFiles({ name: "preview-card.png", mimeType: "image/png", buffer: await sharp({ create: { width: 1200, height: 630, channels: 3, background: "#aa00ff" } }).png().toBuffer() });
  await expect(image).toHaveAttribute("src", /^blob:/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "tests/e2e/screenshots/branding-preview-live-1440.png", fullPage: true });
});

test("마스터 관리자 기본 파비콘은 틸이고, 올린 파비콘이 있으면 그것이 우선한다(대표님 지시 2026-10-04)", async ({ page, request }) => {
  // 기본 아이콘 PNG의 바탕 색(왼쪽 위 안쪽 화소): 마스터는 틸(#0f766e), 파트너스는 보라(#5b3df6)
  const pixel = async (url: string) => {
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    const { data, info } = await sharp(Buffer.from(await res.body())).raw().toBuffer({ resolveWithObject: true });
    const at = (6 * info.width + 3) * info.channels;
    return [data[at], data[at + 1], data[at + 2]];
  };
  const adminHead = await head(page, "/admin/login");
  expect(adminHead.icons).toEqual(["/branding/onq-admin-32.png"]);
  const sellerHead = await head(page, "/seller/login");
  expect(sellerHead.icons).toEqual(["/branding/onq-32.png"]);
  expect(await pixel(adminHead.icons[0]!)).toEqual([0x0f, 0x76, 0x6e]);
  expect(await pixel(sellerHead.icons[0]!)).toEqual([0x5b, 0x3d, 0xf6]);
  expect((await request.get("/branding/onq-admin-180.png")).status()).toBe(200);

  // 설정 화면의 마스터 관리자 탭 「기본 아이콘」도 틸 아이콘을 보인다
  await login(page, superEmail);
  await expect(page.getByAltText("기본 아이콘")).toHaveAttribute("src", "/branding/onq-admin-32.png");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    if (width === 390) await expect.poll(async () => (await page.locator("aside.lnb").boundingBox())?.x ?? 0).toBeLessThan(-200);
    await page.screenshot({ path: `tests/e2e/screenshots/branding-master-favicon-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 올린 파비콘이 있으면 그것이 우선, 되돌리면 다시 틸 기본 아이콘
  const icon = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ffaa00" } }).png().toBuffer();
  await page.getByLabel("파비콘 파일").setInputFiles({ name: "master.png", mimeType: "image/png", buffer: icon });
  await page.getByRole("button", { name: "파비콘 변경" }).click();
  await expect(page.getByText("파비콘을 변경했습니다.")).toBeVisible();
  const uploaded = await head(page, "/admin/login");
  expect(uploaded.icons).toEqual([expect.stringMatching(/^\/api\/branding\/admin\/favicon\?v=[0-9a-f]{12}$/)]);
  await page.goto("/admin/settings/branding");
  await page.getByRole("button", { name: "기본값으로 되돌리기" }).click();
  await expect(page.getByText("기본 파비콘으로 되돌렸습니다.")).toBeVisible();
  expect((await head(page, "/admin/login")).icons).toEqual(["/branding/onq-admin-32.png"]);
});
