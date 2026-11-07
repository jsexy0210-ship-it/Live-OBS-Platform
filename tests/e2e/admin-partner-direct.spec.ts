import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 파트너스 직접 추가(MA-017)와 본인확인 대기 상세(MA-012-1 상태 변형): 체험 종료 날짜·시각 규칙, 주소 중복 안내, 초대 링크 재발급, 체험 종료일 연장.
// 계정·파트너스는 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const email = `dc-su-${run}@example.com`;
const csEmail = `dc-cs-${run}@example.com`;
const slug = `dc-${run}`;
const shop = `직접몰 ${run}`;
let db: PrismaClient;
let sellerId = "";

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({ data: [{ email, passwordHash, name: "대표", role: "SUPER_ADMIN" }, { email: csEmail, passwordHash, name: "상담", role: "CS" }] });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, who = email) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(who);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("직접 추가: 체험 종료일을 비우면 서버 기본(7일), 날짜만 고르면 시각을 요구하고, 주소가 겹치면 주소 칸에 알린다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/partners/new");
  const create = page.getByRole("button", { name: "파트너스 만들기", exact: true });
  await page.getByLabel("쇼핑몰 이름").fill(shop);
  await page.getByLabel("쇼핑몰 주소").fill(slug);
  await page.getByLabel("대표자 이름").fill("홍길동");
  await page.getByLabel("로그인 이메일").fill(`dc-owner-${run}@example.com`);
  await page.getByLabel("사유", { exact: true }).fill("시험 직접 추가");
  await expect(page.getByLabel("체험 종료 날짜")).toHaveValue(""); // 정본: 비어 있다
  await expect(page.getByLabel("체험 종료 시각(KST)")).toBeDisabled();
  await expect(create).toBeEnabled();

  await page.getByLabel("체험 종료 날짜").fill("2099.01.01");
  await page.getByLabel("체험 종료 날짜").blur();
  await expect(page.getByText("체험 종료 시각(KST)을 선택해 주십시오")).toBeVisible();
  await expect(create).toBeDisabled();
  await page.getByLabel("체험 종료 날짜").fill("");
  await page.getByLabel("체험 종료 날짜").blur();
  await expect(create).toBeEnabled();

  await create.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("체험 종료 지금부터 7일");
  await expect(dialog).toContainText("「본인확인 대기」");
  await dialog.getByRole("button", { name: "파트너스 만들기", exact: true }).click();
  await expect(page.getByTestId("created-invite-link")).toContainText("/seller/invite#");
  const row = await db.seller.findUniqueOrThrow({ where: { slug } });
  sellerId = row.id;
  const days = ((row.trialEndsAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThan(7.1);

  await page.goto("/admin/partners/new");
  await page.getByLabel("쇼핑몰 이름").fill(`${shop} 2`);
  await page.getByLabel("쇼핑몰 주소").fill(slug);
  await page.getByLabel("대표자 이름").fill("홍길동");
  await page.getByLabel("로그인 이메일").fill(`dc-owner2-${run}@example.com`);
  await page.getByLabel("사유", { exact: true }).fill("중복 주소 시험");
  await page.getByRole("button", { name: "파트너스 만들기", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "파트너스 만들기", exact: true }).click();
  await expect(page.getByText("이미 쓰는 쇼핑몰 주소입니다 · 다른 주소를 입력해 주십시오")).toBeVisible();
});

test("본인확인 대기 상세: 초대 링크를 다시 발급하면 새 링크가 한 번 보이고, 체험 종료일은 새 날짜와 사유로 연장된다", async ({ page }) => {
  await login(page);
  await page.goto(`/admin/partners/${sellerId}`);
  const panel = page.getByTestId("identity-pending");
  await expect(panel).toContainText("본인확인 대기");
  await expect(panel.getByText("자동 점검 건너뜀")).toBeVisible();
  // 서버가 주는 추가한 관리자 · 사유 · 초대 상태(최고관리자만)
  await expect(panel).toContainText("최고관리자 대표이 직접 추가");
  await expect(panel).toContainText("사유: 시험 직접 추가");
  await expect(panel).toContainText("발급");
  await expect(panel).toContainText("아직 쓰지 않음");

  await panel.getByRole("button", { name: "초대 링크 재발급" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "재발급", exact: true }).click();
  await expect(page.getByTestId("reissued-invite-link")).toContainText("/seller/invite#");
  await expect(page.getByTestId("reissued-invite")).toContainText("이전 링크 1개 무효");

  const before = (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).trialEndsAt!;
  await panel.getByRole("button", { name: "연장" }).click();
  const dialog = page.getByRole("dialog");
  const extend = dialog.getByRole("button", { name: "연장", exact: true });
  await expect(extend).toBeDisabled(); // 새 종료일·사유가 있어야 켜진다
  await dialog.getByLabel("새 종료일").fill("2099.01.01");
  await dialog.getByLabel("새 종료일").blur();
  await dialog.getByLabel("사유").fill("시험 연장");
  await expect(extend).toBeEnabled();
  await extend.click();
  await expect(dialog).toHaveCount(0);
  const after = (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).trialEndsAt!;
  expect(after.getTime()).toBeGreaterThan(before.getTime());
  expect(after.toISOString().startsWith("2099-01-0")).toBe(true);
});

test("체험 연장: 이미 끝난 체험을 오늘로 연장해도 지난 시각이면 막고 더 뒤 날짜를 안내한다", async ({ page }) => {
  // 어제 KST 0시에 끝난 체험: 오늘로 연장하면 새 종료일은 오늘 KST 0시라서 어느 시각에 돌려도 항상 지난 시각이다(시각 의존 없음)
  const todayIso = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: new Date(new Date(`${todayIso}T00:00:00+09:00`).getTime() - 86_400_000) } });
  await login(page);
  await page.goto(`/admin/partners/${sellerId}`);
  await page.getByTestId("identity-pending").getByRole("button", { name: "연장" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("새 종료일").fill(todayIso.replace(/-/g, "."));
  await dialog.getByLabel("새 종료일").blur();
  await dialog.getByLabel("사유").fill("지난 시각 시험");
  await expect(dialog).toContainText("선택한 날짜의 종료 시각이 이미 지났습니다");
  await expect(dialog.getByRole("button", { name: "연장", exact: true })).toBeDisabled();
});

test("본인확인 대기 표시: 목록 상태 칸에 「본인확인 대기」, CS는 사유는 보지만 초대 상태는 보지 않는다", async ({ page }) => {
  await login(page);
  await page.goto("/admin/partners");
  await page.getByLabel("검색어", { exact: true }).fill(slug);
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByTestId("partner-row")).toHaveCount(1);
  await expect(page.getByTestId("partner-row")).toContainText("본인확인 대기");

  await page.context().clearCookies();
  await login(page, csEmail);
  await page.goto(`/admin/partners/${sellerId}`);
  const panel = page.getByTestId("identity-pending");
  await expect(panel).toContainText("사유: 시험 직접 추가");
  await expect(panel).not.toContainText("아직 쓰지 않음");
  await expect(panel.getByRole("button", { name: "초대 링크 재발급" })).toHaveCount(0);
});
