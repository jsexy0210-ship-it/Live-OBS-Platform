import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// 표 정렬 규칙(대표님 지시 2026-10-05, docs/DESIGN_PROMPT.md 「표 정렬」): 열 제목·데이터 모두 가운데가 기본,
// 글 열(.col-text)의 데이터만 왼쪽, 오른쪽 정렬 0건. 실제 화면의 computed style로 관리자 표 전부를 잰다.
// 또 가운데 열은 칸 안의 내용 중심이 열 제목 중심과 같은 세로선 위에 있는지(어긋남 2px 이내) 본다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const adminPassword = randomBytes(12).toString("base64url");
const adminEmail = `align-super-${randomBytes(4).toString("hex")}@example.com`;
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

type Report = { right: string[]; thNotCenter: string[]; tdWrong: string[]; offAxis: string[]; tables: number; rows: number };

async function measure(page: Page): Promise<Report> {
  await page.waitForLoadState("networkidle");
  return page.evaluate(() => {
    const LEFT = ["col-text", "col-product", "col-title", "col-desc"];
    const r: Report = { right: [], thNotCenter: [], tdWrong: [], offAxis: [], tables: 0, rows: 0 };
    const tables = [...document.querySelectorAll<HTMLTableElement>("table.tbl")].filter((t) => t.offsetParent !== null);
    r.tables = tables.length;
    for (const t of tables) {
      const head = t.tHead?.rows[0];
      const heads = head ? [...head.cells] : [];
      for (const th of heads) if (getComputedStyle(th).textAlign !== "center") r.thNotCenter.push(th.textContent?.trim() || "(빈 제목)");
      for (const row of [...t.tBodies].flatMap((b) => [...b.rows])) {
        r.rows++;
        [...row.cells].forEach((td, i) => {
          const a = getComputedStyle(td).textAlign;
          const label = `${heads[i]?.textContent?.trim() || i}: ${td.textContent?.trim().slice(0, 20)}`;
          if (a === "right" || a === "end") r.right.push(label);
          const left = LEFT.some((c) => td.classList.contains(c));
          if (td.colSpan > 1) return;
          if ((left && a !== "left") || (!left && a !== "center")) r.tdWrong.push(`${label} → ${a}`);
          // 가운데 열: 칸 안 내용 덩어리의 중심 x가 제목 중심 x와 같은지(2px 이내)
          const th = heads[i];
          if (!left && th && td.textContent?.trim()) {
            const range = document.createRange();
            range.selectNodeContents(td);
            const rc = range.getBoundingClientRect();
            const hc = th.getBoundingClientRect();
            if (rc.width > 0 && rc.width < hc.width && Math.abs(rc.left + rc.width / 2 - (hc.left + hc.width / 2)) > 2) r.offAxis.push(label);
          }
        });
      }
    }
    return r;
  });
}

function expectAligned(path: string, r: Report) {
  expect.soft(r.right, `${path} 오른쪽 정렬`).toEqual([]);
  expect.soft(r.thNotCenter, `${path} 제목 가운데 아님`).toEqual([]);
  expect.soft(r.tdWrong, `${path} 데이터 정렬`).toEqual([]);
  expect.soft(r.offAxis, `${path} 제목·데이터 중심축 어긋남`).toEqual([]);
}

test("파트너스 관리자 표: 가운데 기본·글 열만 왼쪽·오른쪽 0건·중심축 일치", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/orders")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/orders$/);
  let rows = 0;
  for (const path of ["/seller/orders", "/seller/products", "/seller/products/stock", "/seller/products/categories", "/seller/coupons", "/seller/staff", "/seller/members", "/seller/hit-cards", "/seller/shipping", "/seller/orders/deposits", "/seller/settings/order-notifications", "/seller/settings/message-balance", "/seller/purchase-restrictions"]) {
    await page.goto(path);
    const r = await measure(page);
    rows += r.rows;
    expectAligned(path, r);
    if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/ui-table-align/seller${path.replace(/\//g, "-")}-1440.png` });
  }
  // 데이터가 실제로 있는 표를 쟀는지(빈 화면만 보고 통과하지 않게)
  expect(rows).toBeGreaterThan(10);
});

test("마스터 관리자 표: 가운데 기본·글 열만 왼쪽·오른쪽 0건·중심축 일치", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(adminEmail);
  await page.getByLabel("비밀번호").fill(adminPassword);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  let rows = 0;
  for (const path of ["/admin/partners", "/admin/partners/applications", "/admin/accounts", "/admin/accounts/roles", "/admin/logs", "/admin/billing/invoices", "/admin/billing/subscriptions", "/admin/billing/plans", "/admin/settings/messages", "/admin/support/notices", "/admin/ops/monitor"]) {
    await page.goto(path);
    const r = await measure(page);
    rows += r.rows;
    expectAligned(path, r);
    if (SHOTS) await page.screenshot({ path: `tests/e2e/screenshots/ui-table-align/admin${path.replace(/\//g, "-")}-1440.png` });
  }
  expect(rows).toBeGreaterThan(5);
});
