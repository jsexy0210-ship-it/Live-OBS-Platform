import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 공통 확인 창(DS-CONFIRM): 대리 조회 「종료」가 첫 사용처. 제목 「~하시겠습니까?」·[취소][실행 이름], X·Esc·바깥 클릭=취소, 열리면 취소로 포커스, 실행하면 처리 뒤 이동.
// 계정·파트너스는 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `cf-cs-${run}@example.com`;
let sellerId = "";

test.beforeAll(async () => {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    await db.platformAdmin.create({ data: { email, passwordHash: await hashPassword(password), name: "상담", role: "CS" } });
    sellerId = (await db.seller.create({ data: { slug: `cf-${run}`, shopName: `확인창몰 ${run}`, status: "ACTIVE", approvedAt: new Date() } })).id;
  } finally {
    await db.$disconnect();
  }
});

test("대리 조회 종료는 확인 창을 거치고, 취소·Esc·X·바깥 클릭은 닫기만 하며, 끝내기를 누르면 마스터 관리자로 돌아간다", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL((u) => u.pathname === "/admin");
  await page.goto(`/admin/partners/${sellerId}`);
  await page.getByRole("button", { name: "이 파트너스 화면 대신 보기", exact: true }).click();
  const start = page.getByRole("dialog").getByRole("button", { name: "대신 보기 시작", exact: true });
  await page.getByRole("dialog").getByLabel("사유").fill("확인 창 시험");
  const popup = context.waitForEvent("page");
  await start.click();
  const p = await popup;
  await p.waitForLoadState("load");
  // 대신 보기를 시작한 창이 파트너스 화면으로 스스로 넘어가는 중이면 이동이 끊긴다(ERR_ABORTED): 넘어간 뒤에 연다
  await p.waitForURL(/\/seller(\/|$)/);
  await p.waitForLoadState("load");
  await p.goto("/seller/orders");

  const bar = p.locator(".imp-bar");
  await expect(bar).toContainText("읽기 전용 · 대신 보기");
  const dialog = p.getByRole("dialog", { name: "대신 보기를 끝내시겠습니까?" });

  // 열면 취소로 포커스, 같은 폭 두 버튼
  await bar.getByRole("button", { name: "종료" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused();
  const w = await dialog.locator(".modal-f .btn").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  expect(w[0]).toBe(w[1]);
  expect(w[0]).toBe(96);

  // 취소 · Esc · X · 바깥 클릭 = 닫기만(대신 보기는 그대로)
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  await bar.getByRole("button", { name: "종료" }).click();
  await p.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await bar.getByRole("button", { name: "종료" }).click();
  await dialog.getByRole("button", { name: "닫기" }).click();
  await expect(dialog).toHaveCount(0);
  await bar.getByRole("button", { name: "종료" }).click();
  await p.mouse.click(5, 400);
  await expect(dialog).toHaveCount(0);
  await expect(bar).toBeVisible();
  expect((await (await p.request.get("/api/seller/me")).json()).readOnly).toBe(true);

  // 끝내기 → 마스터 관리자로 돌아가고 서버에서도 끝난다
  await bar.getByRole("button", { name: "종료" }).click();
  await dialog.getByRole("button", { name: "끝내기" }).click();
  await p.waitForURL((u) => u.pathname === "/admin/partners");
  expect((await (await page.request.get("/api/admin/impersonation")).json()).active).toBeNull();
});
