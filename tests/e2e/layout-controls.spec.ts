import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// 관리자 공통 컨트롤 규칙(대표님 지시 2026-10-05 「관리자 전체 UI 전수 검수 및 공통 컴포넌트 정리 + 버튼 Width 고정」).
// 실제 화면의 computed style·크기로 잰다: Select 화살표(오른쪽 14px 안쪽·글자 침범 없음), 날짜 칸 전체 클릭 달력(showPicker 1회),
// 검색 영역 CTA 앞 안쪽 선 없음(바깥 테두리는 유지), 「검색」「초기화」 같은 높이 40·같은 폭 80, 목록 머리 도구 줄 40.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const adminPassword = randomBytes(12).toString("base64url");
const adminEmail = `ctl-super-${randomBytes(4).toString("hex")}@example.com`;
let db: PrismaClient;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  await db.platformAdmin.create({ data: { email: adminEmail, passwordHash: await hashPassword(adminPassword), name: "대표", role: "SUPER_ADMIN" } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function adminLogin(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(adminEmail);
  await page.getByLabel("비밀번호").fill(adminPassword);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("Select: 공통 화살표가 오른쪽 테두리에서 14px 안쪽·세로 가운데, 글자 자리와 겹치지 않고 높이 40·모서리 8", async ({ page }) => {
  await adminLogin(page);
  await page.goto("/admin/logs");
  const selects = page.locator(".main select.inp");
  expect(await selects.count()).toBeGreaterThan(0);
  for (const s of await selects.all()) {
    const st = await s.evaluate((e) => {
      const c = getComputedStyle(e);
      return { appearance: c.appearance, pos: c.backgroundPosition, img: c.backgroundImage !== "none", pr: c.paddingRight, pl: c.paddingLeft, h: Math.round(e.getBoundingClientRect().height), r: c.borderTopLeftRadius, fs: c.fontSize };
    });
    expect(st).toEqual({ appearance: "none", pos: "right 14px 50%", img: true, pr: "40px", pl: "14px", h: 40, r: "8px", fs: "14px" });
  }
});

test("날짜 칸(공통 DatePicker): 글자·빈 곳·아이콘 어디를 눌러도 달력이 열리고, 하나 고르면 닫히며, 직접 입력·Esc는 값을 지키고, 칸은 「2026.10.01」로 보인다", async ({ page }) => {
  await adminLogin(page);
  await page.goto("/admin/logs");
  const date = page.getByLabel("기록 시작일");
  await expect(date).toBeVisible();
  await expect(date).toHaveAttribute("placeholder", "날짜 선택");
  const box = (await date.boundingBox())!;
  const cal = page.getByRole("dialog", { name: "기록 시작일 달력" });
  // 글자 쪽·가운데·오른쪽 아이콘 쪽 어디를 눌러도 한 번 열린다
  for (const x of [box.x + 12, box.x + box.width / 2, box.x + box.width - 16]) {
    await page.mouse.click(x, box.y + box.height / 2);
    await expect(cal).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(cal).toHaveCount(0);
  }
  // 직접 입력: 「2026-10-01」도 「2026.10.01」로 읽어 보여 준다. Esc는 값을 지킨다
  await date.fill("2026-10-01");
  await date.blur();
  await expect(date).toHaveValue("2026.10.01");
  await date.click();
  await expect(cal).toBeVisible();
  await expect(cal.getByRole("button", { name: "2026.10.01", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(date).toHaveValue("2026.10.01");
  // 달력에서 하루를 고르면 바로 닫히고 값이 들어간다
  await date.click();
  await cal.getByRole("button", { name: "2026.10.15", exact: true }).click();
  await expect(cal).toHaveCount(0);
  await expect(date).toHaveValue("2026.10.15");
  // 초기화는 비운다(칸은 「날짜 선택」으로 돌아간다)
  await date.click();
  await cal.getByRole("button", { name: "초기화" }).click();
  await expect(date).toHaveValue("");
});

test("검색 영역: 바깥 테두리·모서리 12는 그대로, CTA 앞 마지막 가로선·CTA 줄 선은 없고 「검색」「초기화」는 40×80", async ({ page }) => {
  await adminLogin(page);
  await page.goto("/admin/partners");
  const sb = page.locator(".main .au-sb").first();
  const outer = await sb.evaluate((e) => ({ ring: /0px 0px 0px 1px/.test(getComputedStyle(e).boxShadow) && /inset/.test(getComputedStyle(e).boxShadow), r: getComputedStyle(e).borderTopLeftRadius }));
  expect(outer).toEqual({ ring: true, r: "12px" });
  const lastRow = await sb.locator(".au-ft > tbody > tr:last-child > td").evaluate((e) => getComputedStyle(e).borderBottomWidth);
  expect(lastRow).toBe("0px");
  const foot = await sb.locator(".au-sb-f").evaluate((e) => ({ top: getComputedStyle(e).borderTopWidth, shadow: getComputedStyle(e).boxShadow }));
  expect(foot).toEqual({ top: "0px", shadow: "none" });
  for (const name of ["검색", "초기화"]) {
    const b = (await sb.getByRole("button", { name, exact: true }).boundingBox())!;
    expect([Math.round(b.width), Math.round(b.height)]).toEqual([80, 40]);
  }
});

test("목록 머리 도구 줄(정렬·페이지 크기·일괄 처리)은 모두 높이 40", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/products")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/products$/);
  const bar = page.locator(".main .au-lh-act").first();
  const hs = await bar.locator(":scope > .btn, :scope > .inp").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(hs.length).toBeGreaterThan(1);
  expect(new Set(hs)).toEqual(new Set([40]));
});
