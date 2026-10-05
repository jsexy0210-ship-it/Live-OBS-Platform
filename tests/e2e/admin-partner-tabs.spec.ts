import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 파트너스 상세 탭(MA-012): 방송 이력·메모(쓰기·삭제 권한)·결제 연결·활동 기록, 탭은 주소(?tab=)에 남는다.
// 계정·파트너스·방송은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { cs: `pt-cs-${run}@example.com`, ops: `pt-ops-${run}@example.com`, ro: `pt-ro-${run}@example.com` };
const shop = `탭몰 ${run}`;
const ids: Record<string, string> = {};
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.cs, passwordHash, name: "상담", role: "CS" },
      { email: emails.ops, passwordHash, name: "운영", role: "OPERATIONS" },
      { email: emails.ro, passwordHash, name: "조회", role: "READ_ONLY" },
    ],
  });
  const seller = await db.seller.create({ data: { slug: `pt-${run}`, shopName: shop, status: "ACTIVE", approvedAt: new Date() } });
  ids.seller = seller.id;
  await db.broadcastSession.create({ data: { sellerId: seller.id, status: "ENDED", title: `탭 방송 ${run}`, startedAt: new Date(Date.now() - 3_600_000), endedAt: new Date() } });
});
test.afterAll(async () => {
  await db.$disconnect();
});

async function login(page: Page, email: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}
const detail = (tab: string) => `/admin/partners/${ids.seller}?tab=${tab}`;

test("방송 이력: 방송이 보이고 기간이 거꾸로면 막히며, 탭은 주소에 남아 새로고침에서도 그대로다", async ({ page }) => {
  await login(page, emails.ro);
  await page.goto(`/admin/partners/${ids.seller}`);
  await page.getByRole("button", { name: "방송 이력", exact: true }).click();
  await expect(page).toHaveURL(/tab=broadcasts/);
  const row = page.getByTestId("broadcast-row").filter({ hasText: `탭 방송 ${run}` });
  await expect(row).toContainText("종료");
  await page.reload();
  await expect(page.getByRole("button", { name: "방송 이력", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(row).toBeVisible();
  await page.getByLabel("방송 시작일 부터").fill("2026-10-05");
  await page.getByLabel("방송 시작일 까지").fill("2026-10-01");
  await expect(page.getByText("시작일이 종료일보다 늦습니다.")).toBeVisible();
  await page.screenshot({ path: "tests/e2e/screenshots/admin-partner-tabs-1440.png" });
});

test("메모: CS가 남기고 지울 수 있고, 운영은 남의 메모를 지울 수 없으며, 조회 전용은 입력 칸이 없다", async ({ page }) => {
  await login(page, emails.cs);
  await page.goto(detail("notes"));
  await page.getByLabel("메모 내용").fill(`확인 필요 ${run}\n두 번째 줄`);
  await page.getByRole("button", { name: "메모 남기기" }).click();
  await expect(page.getByText("메모를 남겼습니다.")).toBeVisible();
  const note = page.getByTestId("note-item").filter({ hasText: `확인 필요 ${run}` });
  await expect(note).toContainText("상담");
  await expect(note.getByRole("button", { name: "삭제" })).toBeVisible();
  expect(await db.sellerAdminNote.count({ where: { sellerId: ids.seller } })).toBe(1);

  await page.context().clearCookies();
  await login(page, emails.ops);
  await page.goto(detail("notes"));
  await expect(page.getByLabel("메모 내용")).toBeVisible();
  const others = page.getByTestId("note-item").filter({ hasText: `확인 필요 ${run}` });
  await expect(others).toBeVisible();
  await expect(others.getByRole("button", { name: "삭제" })).toHaveCount(0);

  await page.context().clearCookies();
  await login(page, emails.ro);
  await page.goto(detail("notes"));
  await expect(page.getByTestId("note-item").filter({ hasText: `확인 필요 ${run}` })).toBeVisible();
  await expect(page.getByLabel("메모 내용")).toHaveCount(0);

  await page.context().clearCookies();
  await login(page, emails.cs);
  await page.goto(detail("notes"));
  await page.getByTestId("note-item").filter({ hasText: `확인 필요 ${run}` }).getByRole("button", { name: "삭제" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("메모를 지웠습니다.")).toBeVisible();
  await expect(page.getByTestId("note-item")).toHaveCount(0);
  expect(await db.sellerAdminNote.count({ where: { sellerId: ids.seller } })).toBe(0);
});

test("결제 연결·활동 기록 탭: 결제 내역이 없으면 안내하고, 활동 기록은 이 파트너스의 로그 추적으로 연결한다", async ({ page }) => {
  await login(page, emails.ro);
  await page.goto(detail("pg"));
  await expect(page.getByTestId("tab-pg")).toContainText("결제 내역이 없습니다.");
  await page.getByRole("button", { name: "활동 기록", exact: true }).click();
  await expect(page.getByRole("link", { name: "이 파트너스의 로그 추적 보기" })).toHaveAttribute("href", `/admin/logs?sellerId=${ids.seller}`);
});
