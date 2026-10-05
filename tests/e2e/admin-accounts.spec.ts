import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 계정(MA-061·062)·역할별 권한 표(MA-063). 계정은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
// 확인: 최고관리자(유일신) 행에는 정지·역할 변경이 없고 역할 선택지에 「최고관리자」가 없다(대표님 지시 2026-10-04).
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const superEmail = `acc-super-${run}@example.com`;
const staffEmail = `acc-staff-${run}@example.com`;
const newEmail = `acc-new-${run}@example.com`;
let db: PrismaClient;
let staffId = "";
let superId = "";

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  const s = await db.platformAdmin.create({ data: { email: superEmail, passwordHash, name: "대표 시험", role: "SUPER_ADMIN" } });
  superId = s.id;
  const t = await db.platformAdmin.create({ data: { email: staffEmail, passwordHash, name: "직원 시험", role: "CS" } });
  staffId = t.id;
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function open(page: Page, path = "/admin/accounts") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(superEmail);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goto(path);
}
const rowOf = (page: Page, email: string) => page.getByTestId("account-row").filter({ hasText: email });

test("최고관리자 행: 수정 창에 이름만 있고 역할·상태 칸이 없으며, 이름은 바꿀 수 있다", async ({ page }) => {
  await open(page);
  await rowOf(page, superEmail).getByRole("button", { name: "수정" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("이름")).toBeVisible();
  await expect(dialog.getByLabel("역할")).toHaveCount(0);
  await expect(dialog.getByLabel("상태")).toHaveCount(0);
  await expect(dialog.getByText("최고관리자의 역할과 상태는 바꿀 수 없습니다.")).toBeVisible();
  await dialog.getByLabel("이름").fill("대표 이름바꿈");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, superEmail)).toContainText("대표 이름바꿈");
  const row = await db.platformAdmin.findUniqueOrThrow({ where: { id: superId } });
  expect(row.name).toBe("대표 이름바꿈");
  expect(row.role).toBe("SUPER_ADMIN");
  expect(row.status).toBe("ACTIVE");
});

test("계정 추가: 역할 선택지에 최고관리자가 없고 기본은 조회 전용이며, 중복 이메일은 안내한다", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "계정 추가" }).click();
  const dialog = page.getByRole("dialog");
  const role = dialog.getByLabel("역할");
  await expect(role.locator("option")).toHaveText(["운영", "고객 지원", "조회 전용"]);
  await expect(role).toHaveValue("READ_ONLY");
  await dialog.getByLabel("이메일").fill(newEmail);
  await dialog.getByLabel("이름").fill("새 직원");
  await dialog.getByLabel("처음 비밀번호").fill("short");
  await expect(dialog.getByRole("button", { name: "추가" })).toBeDisabled();
  await dialog.getByLabel("처음 비밀번호").fill("long-enough-password");
  await dialog.getByRole("button", { name: "추가" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, newEmail)).toContainText("조회 전용");
  expect((await db.platformAdmin.findUniqueOrThrow({ where: { email: newEmail } })).role).toBe("READ_ONLY");

  await page.getByRole("button", { name: "계정 추가" }).click();
  await dialog.getByLabel("이메일").fill(newEmail);
  await dialog.getByLabel("이름").fill("중복");
  await dialog.getByLabel("처음 비밀번호").fill("long-enough-password");
  await dialog.getByRole("button", { name: "추가" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("이미 사용 중인 이메일입니다.");
});

test("일반 계정 수정: 역할·상태를 바꾸면 목록과 DB에 반영되고, 처리 중에는 취소할 수 없으며, 서버 거절은 안내한다", async ({ page }) => {
  await open(page);
  await rowOf(page, staffEmail).getByRole("button", { name: "수정" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("역할").locator("option")).toHaveText(["운영", "고객 지원", "조회 전용"]);
  await dialog.getByLabel("역할").selectOption("OPERATIONS");
  await dialog.getByLabel("상태").selectOption("SUSPENDED");
  await expect(dialog.getByText("정지하면 이 계정의 로그인이 바로 끝납니다.")).toBeVisible();

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/admin/admins/*", async (route) => {
    await gate;
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "super_admin_protected" }) });
  });
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog.getByRole("button", { name: "취소" })).toBeDisabled();
  release();
  await expect(dialog.getByRole("alert")).toHaveText("최고관리자의 역할과 상태는 바꿀 수 없습니다.");
  await page.unroute("**/api/admin/admins/*");
  expect((await db.platformAdmin.findUniqueOrThrow({ where: { id: staffId } })).status).toBe("ACTIVE");

  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(rowOf(page, staffEmail)).toContainText("운영");
  await expect(rowOf(page, staffEmail)).toContainText("정지");
  const row = await db.platformAdmin.findUniqueOrThrow({ where: { id: staffId } });
  expect(row.role).toBe("OPERATIONS");
  expect(row.status).toBe("SUSPENDED");
});

test("역할별 권한 표: 관리자 계정 관리는 최고관리자만 가능으로 보이고, 권한 이름 열(글 열)만 왼쪽 정렬이다", async ({ page }) => {
  await open(page, "/admin/accounts/roles");
  await expect(page.locator(".tbl thead th")).toHaveText(["권한", "최고관리자", "운영", "고객 지원", "조회 전용"]);
  const manage = page.getByTestId("permission-row").filter({ hasText: "관리자 계정 관리" });
  await expect(manage.locator("td")).toHaveText(["관리자 계정 관리", "가능", "-", "-", "-"]);
  await expect(page.locator("main")).not.toContainText("admin.manage");
  const align = await page.locator(".tbl td").first().evaluate((el) => getComputedStyle(el).textAlign);
  expect(["left", "start"]).toContain(align);
});
