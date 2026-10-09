import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";
import { renderToStaticMarkup } from "react-dom/server";
import { transpileModule, ModuleKind, JsxEmit } from "typescript";
import { createRequire } from "node:module";

// 실제 앱 로그인 뒤 FINAL 공통 본문 16px 간격과 휴대폰 안전성을 확인한다.
const password = randomBytes(16).toString("base64url");
const run = randomBytes(6).toString("hex");
const adminEmail = `gap-${run}@example.com`;
const sellerEmail = `gap-${run}-owner@example.com`;
const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

test.beforeAll(async () => {
  mkdirSync("tests/e2e/screenshots/section-gap", { recursive: true });
  const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com" } });
  const passwordHash = await hashPassword(password);
  await db.sellerUser.create({ data: { sellerId: owner.sellerId, email: sellerEmail, name: "본문 간격 검증", isOwner: true, passwordHash } });
  await db.platformAdmin.create({ data: { email: adminEmail, name: "본문 간격 검증", role: "SUPER_ADMIN", passwordHash } });
});
test.afterAll(async () => {
  if (process.env.ONQ_SECTION_FIXTURE_FILE) {
    // 검수자 반환 뒤 정리할 임시 계정만 기록한다. 비밀번호·쿠키는 저장하지 않는다.
    const file = process.env.ONQ_SECTION_FIXTURE_FILE;
    let fixtures: { sellerEmail: string; adminEmail: string }[] = [];
    try { const prior = JSON.parse(readFileSync(file, "utf8")); fixtures = Array.isArray(prior) ? prior : [prior]; } catch { /* 첫 실행 */ }
    writeFileSync(file, JSON.stringify([...fixtures, { sellerEmail, adminEmail }]));
    await db.$disconnect();
    return;
  }
  await db.sellerSession.deleteMany({ where: { sellerUser: { email: sellerEmail } } });
  await db.adminSession.deleteMany({ where: { admin: { email: adminEmail } } });
  await db.sellerUser.deleteMany({ where: { email: sellerEmail } });
  await db.platformAdmin.deleteMany({ where: { email: adminEmail } });
  await db.$disconnect();
});

test("FINAL SA-002·SA-011·MA-013 본문 간격의 브라우저 계산 규격", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [id, file] of [["SA-002", "SA-002-IA.dc.html"], ["SA-011", "SA-011.dc.html"], ["MA-013", "MA-013-OPS.dc.html"]]) {
    const source = readFileSync(`design/project/${file}`, "utf8");
    await page.setContent(source.replace(/<link[^>]+>/g, "").replace(/<script[\s\S]*?<\/script>/g, ""));
    await page.addStyleTag({ content: readFileSync("design/project/ds/wds/tokens.css", "utf8") });
    await page.addStyleTag({ content: readFileSync("design/project/lop.css", "utf8") });
    const head = page.locator(".ph2").first();
    expect(await page.locator('.cont').first().evaluate(el => getComputedStyle(el).gap)).toBe('16px');
    expect(await head.evaluate(el => el.nextElementSibling!.getBoundingClientRect().top - el.getBoundingClientRect().bottom)).toBe(id === "SA-002" ? 24 : 16);
    if (id === "SA-002") {
      const sections = await page.locator(".cont > .sec-h").evaluateAll(headings => headings.map(el => ({
        before: el.getBoundingClientRect().top - el.previousElementSibling!.getBoundingClientRect().bottom,
        after: el.nextElementSibling!.getBoundingClientRect().top - el.getBoundingClientRect().bottom,
      })));
      expect(sections).toEqual([{ before: 24, after: 16 }, { before: 24, after: 16 }, { before: 24, after: 16 }]);
      writeFileSync("tests/e2e/screenshots/section-gap/source-SA-002-1440.json", JSON.stringify(sections, null, 2));
    }
    expect(await head.evaluate(el => ({ minHeight: getComputedStyle(el).minHeight, border: getComputedStyle(el).borderBottomWidth, padding: getComputedStyle(el).paddingLeft }))).toEqual({ minHeight: "48px", border: "1px", padding: "24px" });
    for (const button of await head.locator(".acts .b").all()) {
      expect((await button.boundingBox())!.height).toBe(48);
      expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(120);
    }
    await page.screenshot({ path: `tests/e2e/screenshots/section-gap/source-${id}-1440.png` });
  }
});

test("모바일 별도 정본 홈 React·상품 HTML의 본문 간격", async ({ page }) => {
  // Playwright의 JSX 변환과 분리해 실제 React 정본을 그대로 렌더한다. 링크만 로컬 정본 참조로 고정한다.
  const localRequire = createRequire(`${process.cwd()}/package.json`);
  const canonical = { exports: {} as { default: () => React.ReactNode } };
  const compiled = transpileModule(readFileSync("design/project/SA-002-M.dc.tsx", "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  new Function("require", "exports", compiled)((name: string) => name === "./sa-mobile-links" ? { mobileDesignHref: () => "#" } : localRequire(name), canonical.exports);
  await page.setViewportSize({ width: 390, height: 900 });
  for (const [id, source] of [["SA-002-M", renderToStaticMarkup(canonical.exports.default())], ["SA-011-M", readFileSync("design/project/SA-011-M.dc.html", "utf8")]]) {
    await page.setContent(source.replace(/<link[^>]+>/g, "").replace(/<script[\s\S]*?<\/script>/g, ""));
    await page.addStyleTag({ content: readFileSync("design/project/ds/wds/tokens.css", "utf8") });
    await page.addStyleTag({ content: readFileSync("design/project/lop.css", "utf8") });
    expect(await page.locator(".c24.mob .body").first().evaluate(el => getComputedStyle(el).gap)).toBe("16px");
    if (id === "SA-002-M") {
      const sections = await page.locator(".body > .sec-h").first().evaluate(el => ({
        before: el.getBoundingClientRect().top - el.closest(".body")!.previousElementSibling!.getBoundingClientRect().bottom,
        after: el.nextElementSibling!.getBoundingClientRect().top - el.getBoundingClientRect().bottom,
        next: el.nextElementSibling!.nextElementSibling!.getBoundingClientRect().top - el.nextElementSibling!.getBoundingClientRect().bottom,
      }));
      expect(sections).toEqual({ before: 16, after: 16, next: 16 });
      writeFileSync("tests/e2e/screenshots/section-gap/source-SA-002-M-390.json", JSON.stringify(sections, null, 2));
    }
    await page.locator(".m-ph").first().screenshot({ path: `tests/e2e/screenshots/section-gap/source-${id}-390.png` });
  }
});

for (const surface of ["home", "seller", "admin"] as const) {
  test(`${surface} 본문 간격: 실제 로그인 1440 정본 규격과 1024·390 안전성`, async ({ page }) => {
    const loginSurface = surface === "admin" ? "admin" : "seller";
    await page.goto(`/${loginSurface}/login`);
    if (surface !== "admin") await submitSellerLogin(page, sellerEmail, password);
    else {
      await page.getByLabel("이메일").fill(adminEmail);
      await page.getByLabel("비밀번호").fill(password);
      await page.getByRole("button", { name: "로그인", exact: true }).click();
    }
    await expect(page).toHaveURL(new RegExp(`/${loginSurface}$`));
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(surface === "home" ? "/seller" : surface === "seller" ? "/seller/products" : "/admin/partners/applications");
      await expect(page.getByRole("heading", { name: surface === "home" ? "홈" : surface === "seller" ? "상품 목록" : "가입 신청", exact: true })).toBeVisible();
      if (surface === "home") {
        await expect(page.getByTestId("home-tasks")).toBeVisible();
        await expect(page.locator(".home-sec")).toHaveCount(3);
        await expect(page.getByText("아직 진행한 방송이 없습니다", { exact: true })).toBeVisible();
      } else if (surface === "admin") await expect(page.getByTestId("application-kpi")).toBeVisible();
      else await expect(page.getByTestId(width >= 768 ? "product-row" : "product-card").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.locator(".main .au-ph").evaluate(el => {
        const css = getComputedStyle(el), rect = el.getBoundingClientRect(), main = el.closest(".main")!.getBoundingClientRect();
        return { minHeight: css.minHeight, border: css.borderBottomWidth, x: rect.x, right: rect.right, mainX: main.x, mainRight: main.right, padding: css.paddingLeft, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(geometry.overflow).toBe(false);
      const body = page.locator(surface === "home" ? ".main > .home" : ".main");
      const gaps = await body.evaluate(el => {
        const children = Array.from(el.children).filter(child => getComputedStyle(child).position !== "absolute" && child.getBoundingClientRect().height > 0);
        const head = children.findIndex(child => child.classList.contains("au-ph"));
        const first = children[head + 1];
        return { gap: getComputedStyle(el).gap, titleToBody: first.getBoundingClientRect().top - children[head].getBoundingClientRect().bottom,
          sections: children.slice(head + 2).map((child, index) => child.getBoundingClientRect().top - children[head + index + 1].getBoundingClientRect().bottom) };
      });
      const expectedGap = surface === "home" && width >= 768 ? 24 : 16;
      expect(gaps).toMatchObject({ gap: `${expectedGap}px`, titleToBody: expectedGap });
      for (const gap of gaps.sections) expect(gap).toBe(expectedGap);
      const internalGaps = surface === "home"
        ? await page.locator(".home-sec").evaluateAll(sections => sections.map(el => el.children[1].getBoundingClientRect().top - el.children[0].getBoundingClientRect().bottom))
        : surface === "admin" ? await page.locator(".main > .col").evaluate(el => {
          const children = Array.from(el.children).filter(child => getComputedStyle(child).position !== "absolute" && child.getBoundingClientRect().height > 0);
          return children.slice(1).map((child, index) => child.getBoundingClientRect().top - children[index].getBoundingClientRect().bottom);
        }) : [];
      for (const gap of internalGaps) expect(gap).toBe(16);
      writeFileSync(`tests/e2e/screenshots/section-gap/${surface}-${width}.json`, JSON.stringify({ width, geometry, gaps, internalGaps }, null, 2));
      if (width >= 768) {
        expect(geometry).toMatchObject({ minHeight: "48px", border: "1px", padding: "24px" });
        expect(geometry.x).toBe(geometry.mainX);
        expect(geometry.right).toBe(geometry.mainRight);
        for (const button of await page.locator(".au-ph-act > .btn").all()) {
          const rect = (await button.boundingBox())!;
          expect(rect.height).toBe(48);
          expect(rect.width).toBeGreaterThanOrEqual(120);
        }
      }
      await page.screenshot({ path: `tests/e2e/screenshots/section-gap/${surface}-${width}.png` });
    }
  });
}

