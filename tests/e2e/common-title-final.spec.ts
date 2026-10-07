import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// 실제 앱 로그인 뒤 FINAL .ph2 규격과 휴대폰 안전성을 확인한다.
const password = randomBytes(16).toString("base64url");
const run = randomBytes(6).toString("hex");
const adminEmail = `title-${run}@example.com`;
const sellerEmail = `title-${run}-owner@example.com`;
const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

test.beforeAll(async () => {
  const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com" } });
  const passwordHash = await hashPassword(password);
  await db.sellerUser.create({ data: { sellerId: owner.sellerId, email: sellerEmail, name: "제목 검증", isOwner: true, passwordHash } });
  await db.platformAdmin.create({ data: { email: adminEmail, name: "제목 검증", role: "SUPER_ADMIN", passwordHash } });
});
test.afterAll(async () => {
  await db.sellerSession.deleteMany({ where: { sellerUser: { email: sellerEmail } } });
  await db.adminSession.deleteMany({ where: { admin: { email: adminEmail } } });
  await db.sellerUser.deleteMany({ where: { email: sellerEmail } });
  await db.platformAdmin.deleteMany({ where: { email: adminEmail } });
  await db.$disconnect();
});

test("FINAL SA-002·SA-011·MA-013 제목 띠의 브라우저 계산 규격", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [id, file] of [["SA-002", "SA-002-IA.dc.html"], ["SA-011", "SA-011.dc.html"], ["MA-013", "MA-013-OPS.dc.html"]]) {
    const source = readFileSync(`design/project/${file}`, "utf8");
    await page.setContent(source.replace(/<link[^>]+>/g, "").replace(/<script[\s\S]*?<\/script>/g, ""));
    await page.addStyleTag({ content: readFileSync("design/project/ds/wds/tokens.css", "utf8") });
    await page.addStyleTag({ content: readFileSync("design/project/lop.css", "utf8") });
    const head = page.locator(".ph2").first();
    expect(await head.evaluate(el => ({ minHeight: getComputedStyle(el).minHeight, border: getComputedStyle(el).borderBottomWidth, padding: getComputedStyle(el).paddingLeft }))).toEqual({ minHeight: "48px", border: "1px", padding: "24px" });
    for (const button of await head.locator(".acts .b").all()) {
      expect((await button.boundingBox())!.height).toBe(48);
      expect((await button.boundingBox())!.width).toBeGreaterThanOrEqual(120);
    }
    await head.screenshot({ path: `tests/e2e/screenshots/common-title-final/source-${id}-1440.png` });
  }
});

for (const surface of ["home", "seller", "admin"] as const) {
  test(`${surface} 제목 띠: 실제 로그인 1440 정본 규격과 1024·390 안전성`, async ({ page }) => {
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
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.locator(".main .au-ph").evaluate(el => {
        const css = getComputedStyle(el), rect = el.getBoundingClientRect(), main = el.closest(".main")!.getBoundingClientRect();
        return { minHeight: css.minHeight, border: css.borderBottomWidth, x: rect.x, right: rect.right, mainX: main.x, mainRight: main.right, padding: css.paddingLeft, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(geometry.overflow).toBe(false);
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
      await page.screenshot({ path: `tests/e2e/screenshots/common-title-final/${surface}-${width}.png` });
    }
  });
}
