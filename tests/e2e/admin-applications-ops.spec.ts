import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 가입 신청 목록 처리 편의(MA-013, docs/ADMIN_OPS_UX.md): 이상 없음/확인 필요 구분·사유 요약, 목록에서 바로 승인·반려·검토, 칩 필터가 주소에 남음, 조회 전용은 상세만, 상세 이전/다음·처리 뒤 다음 건.
// 신청은 맨 앞(오래된 날짜)에 오도록 만들어, 다른 시험이 남긴 대기 건과 섞여도 100건 제한 안에 든다. 폐기용 테스트 DB(이름이 _test로 끝남)에만 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { ops: `ap-ops-${run}@example.com`, ro: `ap-ro-${run}@example.com` };
const name = (k: string) => `신청몰${k} ${run}`;
const ids: Record<string, string> = {};
let db: PrismaClient;

async function pending(key: string, days: number, reviewReasons: string[] = []) {
  const s = await db.seller.create({
    data: {
      slug: `ap-${key}-${run}`,
      shopName: name(key),
      status: "PENDING",
      reviewReasons,
      businessInfo: { companyName: `상호${key}`, businessNumber: "123-45-67890" },
      createdAt: new Date(Date.UTC(2020, 0, 1) + days * 86_400_000),
    },
  });
  ids[key] = s.id;
}

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.ops, passwordHash, name: "운영", role: "OPERATIONS" },
      { email: emails.ro, passwordHash, name: "조회", role: "READ_ONLY" },
    ],
  });
  await pending("A", 0); // 이상 없음, 바로 승인
  await pending("B", 1, ["business_not_active"]); // 확인 필요, 검토 뒤 승인
  await pending("C", 2); // 이상 없음, 반려
  await pending("D", 3); // 이상 없음, 상세 이전/다음
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
const row = (page: Page, key: string) => page.getByTestId("application-row").filter({ hasText: name(key) });

test("운영: 이상 없음은 목록에서 한 번에 승인되고(처리한 행만 바뀜), 확인 필요는 사유를 본 뒤에만 승인된다", async ({ page }) => {
  await login(page, emails.ops);
  await page.goto(`/admin/partners/applications?field=shop&q=${run}`); // 20건씩 보이므로 이 시험이 만든 신청만 검색한다
  await expect(row(page, "A")).toContainText("확인할 것 없음");
  await expect(row(page, "A").getByRole("button", { name: "승인" })).toBeVisible();
  await expect(row(page, "B")).toContainText("확인 필요 1");
  await expect(row(page, "B")).toContainText("사업자 상태가 휴업 또는 폐업입니다");
  await expect(row(page, "B").getByRole("button", { name: "승인", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "tests/e2e/screenshots/admin-applications-1440.png" });
  for (const w of [1024, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.reload();
    await expect(row(page, "A")).toBeVisible();
    await page.screenshot({ path: `tests/e2e/screenshots/admin-applications-${w}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();

  await row(page, "A").getByRole("button", { name: "승인", exact: true }).click();
  await expect(page.getByText(`${name("A")} 가입을 승인했습니다.`)).toBeVisible();
  await expect(row(page, "A")).toContainText("승인됨");
  await expect(row(page, "B")).toBeVisible(); // 다른 행은 그대로
  expect((await db.seller.findUniqueOrThrow({ where: { id: ids.A } })).status).toBe("ACTIVE");

  await row(page, "B").getByRole("button", { name: "확인할 내용 보기" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("review-reasons")).toContainText("사업자 상태가 휴업 또는 폐업입니다");
  expect((await db.seller.findUniqueOrThrow({ where: { id: ids.B } })).status).toBe("PENDING");
  await dialog.getByRole("button", { name: "확인했습니다. 승인" }).click();
  await expect(row(page, "B")).toContainText("승인됨");
  expect((await db.seller.findUniqueOrThrow({ where: { id: ids.B } })).status).toBe("ACTIVE");
});

test("반려는 사유를 고르는 작은 창에서 한 번에 끝나고, 칩 필터는 주소에 남는다", async ({ page }) => {
  await login(page, emails.ops);
  await page.goto(`/admin/partners/applications?field=shop&q=${run}`); // 20건씩 보이므로 이 시험이 만든 신청만 검색한다
  await page.getByRole("button", { name: /^확인 필요/ }).click();
  await expect(page).toHaveURL(/tab=review/);
  await page.reload();
  await expect(page.getByRole("button", { name: /^확인 필요/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^전체/ }).click();

  await row(page, "C").getByRole("button", { name: "반려", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const reject = dialog.getByRole("button", { name: "반려", exact: true });
  await expect(reject).toBeDisabled();
  await dialog.getByLabel("반려 사유").selectOption("서류와 신청 정보가 다릅니다");
  await dialog.getByLabel("추가 안내").fill("사업자등록증을 다시 올려 주십시오.");
  await reject.click();
  await expect(page.getByText(`${name("C")} 가입을 반려했습니다.`)).toBeVisible();
  await expect(row(page, "C")).toContainText("반려됨");
  const after = await db.seller.findUniqueOrThrow({ where: { id: ids.C } });
  expect(after.status).toBe("REJECTED");
  expect(after.rejectedReason).toBe("서류와 신청 정보가 다릅니다 · 사업자등록증을 다시 올려 주십시오.");
});

test("조회 전용: 처리 버튼 없이 상세만 보인다", async ({ page }) => {
  await login(page, emails.ro);
  await page.goto(`/admin/partners/applications?field=shop&q=${run}`); // 20건씩 보이므로 이 시험이 만든 신청만 검색한다
  const d = row(page, "D");
  await expect(d).toBeVisible();
  await expect(d.getByRole("button")).toHaveCount(0);
  await expect(d.getByRole("link", { name: "상세" })).toBeVisible();
});

test("상세: 이전 N/M 다음으로 넘기고, 승인하면 목록으로 돌아가지 않고 다음 건으로 간다", async ({ page }) => {
  await login(page, emails.ops);
  await page.goto(`/admin/partners/applications/${ids.D}`);
  const nav = page.getByTestId("application-nav");
  await expect(nav).toContainText("/");
  await expect(nav.getByRole("button", { name: "이전" })).toBeVisible();
  const before = page.url();
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expect(page.getByText("가입을 승인했습니다.")).toBeVisible();
  expect((await db.seller.findUniqueOrThrow({ where: { id: ids.D } })).status).toBe("ACTIVE");
  await expect(page).not.toHaveURL(before);
  await expect(page).toHaveURL(/\/admin\/partners\/applications(\/|$)/);
});
