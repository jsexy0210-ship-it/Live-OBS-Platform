import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// 관리자 화면 불필요한 외곽 프레임 제거(대표님 지시 2026-10-05 A). 본문(.main) 안에서 네 변 모두 1px 선으로 둘러싼 상자를 찾는다.
// 남겨도 되는 것: 입력·선택·버튼·칩·세그먼트·페이지 이동 같은 조작 요소 자체 테두리, 상태 안내(.msg), 선택 테두리(.choice),
// 배지, 모달·팝오버, 체크·라디오·스위치, 미리보기(쇼핑몰·메신저 카드 흉내). 표의 행·열 선은 네 변 외곽선이 아니라 걸리지 않는다.
// 1440·1280·1024에서 잰다. E2E_SCREENSHOTS=1이면 화면을 tests/e2e/screenshots/ui-frameless/에 남긴다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const adminPassword = randomBytes(12).toString("base64url");
const adminEmail = `frame-super-${randomBytes(4).toString("hex")}@example.com`;
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
let db: PrismaClient;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email: adminEmail, passwordHash: await hashPassword(adminPassword), name: "대표", role: "SUPER_ADMIN" } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

const ALLOWED = [
  "input", "select", "textarea", "button", "a.btn", ".btn", ".inp", ".chip", ".seg", ".pg", ".msg", ".choice", ".bdg", ".kbd",
  ".modal", "[role=dialog]", "[role=menu]", ".menu", ".cbx", ".rdo", ".sw", ".toast", ".sp-card", ".pcard", ".p-card",
  // 업로드 끌어 놓기 칸·이미지 자리처럼 「조작 영역」인 상자
  "[data-dropzone]", "label.inp",
].join(",");

async function framed(page: Page): Promise<string[]> {
  // 방송 화면은 실시간 연결이 계속 열려 있어 networkidle이 오지 않는다. 불러오기 끝 + 짧은 대기로 그린 뒤 잰다
  await page.waitForLoadState("load");
  await page.waitForTimeout(800);
  return page.evaluate((allowed) => {
    const out: string[] = [];
    const one = (v: string) => /(^|\s)1px/.test(v);
    for (const el of document.querySelectorAll<HTMLElement>(".main *")) {
      if (el.offsetParent === null || el.closest(allowed)) continue;
      const c = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width < 48 || r.height < 24) continue;
      const borders = [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth].every((w) => w === "1px") && c.borderTopStyle !== "none";
      const ring = /inset 0px 0px 0px 1px/.test(c.boxShadow);
      const outline = c.outlineStyle !== "none" && one(c.outlineWidth) && !el.matches(":focus-visible");
      if (borders || ring || outline) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
    }
    return [...new Set(out)];
  }, ALLOWED);
}

const SELLER = ["/seller/orders", "/seller/orders/deposits", "/seller/products", "/seller/products/stock", "/seller/products/categories", "/seller/products/display", "/seller/coupons", "/seller/members", "/seller/rewards", "/seller/rewards/ledger", "/seller/staff", "/seller/shipping", "/seller/hit-cards", "/seller/broadcast", "/seller/settings/shop", "/seller/settings/order", "/seller/subscription"];
const ADMIN = ["/admin", "/admin/partners", "/admin/partners/applications", "/admin/accounts", "/admin/logs", "/admin/billing/invoices", "/admin/billing/subscriptions", "/admin/settings/messages", "/admin/support/notices", "/admin/ops/monitor"];

for (const width of [1440, 1280, 1024]) {
  test(`관리자 본문에 외곽 프레임 없음 ${width}px`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/seller/login?next=${encodeURIComponent("/seller/orders")}`);
    await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
    await expect(page).toHaveURL(/\/seller\/orders$/);
    const found: Record<string, string[]> = {};
    for (const path of SELLER) {
      await page.goto(path);
      const f = await framed(page);
      if (f.length) found[path] = f;
      if (SHOTS && width !== 1024) await page.screenshot({ path: `tests/e2e/screenshots/ui-frameless/seller${path.replace(/\//g, "-")}-${width}.png` });
    }
    await page.context().clearCookies();
    await page.goto("/admin/login");
    await page.getByLabel("이메일").fill(adminEmail);
    await page.getByLabel("비밀번호").fill(adminPassword);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    for (const path of ADMIN) {
      await page.goto(path);
      const f = await framed(page);
      if (f.length) found[path] = f;
      if (SHOTS && width !== 1024) await page.screenshot({ path: `tests/e2e/screenshots/ui-frameless/admin${path.replace(/\//g, "-") || "-home"}-${width}.png` });
    }
    expect(found).toEqual({});
  });
}
