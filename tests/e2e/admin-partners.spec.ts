import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 파트너스 목록·상세·이용 정지(MA-011·012·015). 계정·파트너스는 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { super: `pt-super-${run}@example.com`, cs: `pt-cs-${run}@example.com` };
const slugA = `ptshop-${run}`;
const slugB = `ptwait-${run}`;
const nameA = `시험몰 ${run}`;
let idA = "";
let db: PrismaClient;

test.beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  const passwordHash = await hashPassword(password);
  await db.platformAdmin.createMany({
    data: [
      { email: emails.super, passwordHash, name: "대표", role: "SUPER_ADMIN" },
      { email: emails.cs, passwordHash, name: "상담", role: "CS" },
    ],
  });
  const plan = await db.subscriptionPlan.findFirst({ where: { code: "INTEGRATED" } });
  const a = await db.seller.create({
    data: { slug: slugA, shopName: nameA, status: "ACTIVE", approvedAt: new Date(), planId: plan?.id, businessInfo: { companyName: "시험상사", businessNumber: "123-45-67890", representativeName: "홍길동" } },
  });
  idA = a.id;
  const overlay = await db.subscriptionPlan.findFirst({ where: { code: "OVERLAY_ONLY" } });
  if (plan) await db.sellerSubscription.create({ data: { sellerId: a.id, planId: plan.id, pendingPlanId: overlay?.id, currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) } });
  await db.seller.create({ data: { slug: slugB, shopName: `대기몰 ${run}`, status: "PENDING", planId: plan?.id } });
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

async function search(page: Page, q: string) {
  await page.goto("/admin/partners");
  await page.getByLabel("검색어", { exact: true }).fill(q);
  await page.getByRole("button", { name: "검색", exact: true }).click();
}

test("최고관리자: 검색·상태 필터로 찾고, 이용 정지는 사유가 있어야 하며, 정지·해제가 목록과 DB에 반영된다", async ({ page }) => {
  await login(page, emails.super);
  await search(page, run);
  // 가입 신청 중·반려는 기본 목록에 없다(가입 신청 화면에서 본다, MA-011). 승인된 시험몰만 나온다
  await expect(page.getByTestId("partner-row")).toHaveCount(1);
  await expect(page.getByTestId("partner-row")).toContainText(slugA);
  await expect(page.getByTestId("partner-row")).not.toContainText(`대기몰 ${run}`);
  await page.getByRole("radio", { name: "정상", exact: true }).check();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByTestId("partner-row")).toHaveCount(1);
  await expect(page.getByTestId("partner-row")).toContainText(slugA);
  await page.getByRole("button", { name: "초기화" }).click();
  await search(page, slugA);
  const row = page.getByTestId("partner-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("정상");

  await row.getByRole("button", { name: "이용 정지" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "이용 정지" })).toBeDisabled();
  await dialog.getByLabel("사유").fill("약관 위반 확인");
  await dialog.getByRole("button", { name: "이용 정지" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText("이용 정지");
  const s = await db.seller.findUniqueOrThrow({ where: { id: idA } });
  expect(s.status).toBe("SUSPENDED");
  expect(s.suspendedReason).toBe("약관 위반 확인");

  await row.getByRole("button", { name: "정지 해제" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "정지 해제" }).click();
  await expect(row).toContainText("정상");
  expect((await db.seller.findUniqueOrThrow({ where: { id: idA } })).status).toBe("ACTIVE");
});

test("상세: 기본 정보·대표자·사업자·구독·최근 30일 주문이 보이고, 상세 값(dl)은 왼쪽, 표 데이터는 가운데 정렬이다", async ({ page }) => {
  await login(page, emails.super);
  await search(page, slugA);
  await page.getByRole("link", { name: nameA }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/partners/${idA}$`));
  await expect(page.getByRole("heading", { name: nameA, level: 1 })).toBeVisible();
  for (const t of ["기본 정보", "대표자", "사업자 정보", "구독"]) await expect(page.getByRole("heading", { name: t, level: 2 })).toBeVisible();
  await expect(page.getByText("시험상사")).toBeVisible();
  await expect(page.getByTestId("partner-orders")).toHaveText("0건");
  // 요금제는 코드가 아니라 이름으로 보인다(코드성 표기 금지)
  const pending = page.locator("dl.kv dt", { hasText: "바뀔 요금제" }).locator("xpath=following-sibling::dd[1]");
  await expect(pending).toHaveText("오버레이 전용");
  await expect(page.locator("main")).not.toContainText("OVERLAY_ONLY");
  await expect(page.locator("main")).not.toContainText("INTEGRATED");
  await expect(page.locator(".loc-bar .crumb")).toContainText("파트너스 상세");
  const align = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).textAlign);
  expect(["left", "start"]).toContain(await align("dl.kv dd"));
  await page.goto("/admin/partners");
  expect(await align(".tbl td")).toBe("center"); // 표 정렬 새 규칙(2026-10-05): 글 열(.col-text)이 아니면 데이터는 가운데
  await page.goto("/admin/partners/applications"); // 상세 [sellerId]가 아니라 가입 신청 목록(MA-013)
  await expect(page.getByRole("heading", { name: "가입 신청" })).toBeVisible();
});

test("정지 처리 중에는 닫을 수 없고, 서버 403·409는 안내가 보인다", async ({ page }) => {
  await login(page, emails.super);
  await search(page, slugA);
  await expect(page.getByTestId("partner-row")).toHaveCount(1);
  await page.getByTestId("partner-row").getByRole("button", { name: "이용 정지" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("사유").fill("확인");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/admin/sellers/*/suspend", async (route) => {
    await gate;
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) });
  });
  await dialog.getByRole("button", { name: "이용 정지" }).click();
  await expect(dialog.getByRole("button", { name: "취소" })).toBeDisabled();
  release();
  await expect(dialog.getByRole("alert")).toHaveText("이 작업은 최고관리자와 운영 담당만 할 수 있습니다.");
  await expect(dialog.getByRole("button", { name: "취소" })).toBeEnabled();
  await page.unroute("**/api/admin/sellers/*/suspend");
  await page.route("**/api/admin/sellers/*/suspend", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "not_suspendable" }) }));
  await dialog.getByRole("button", { name: "이용 정지" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("다른 곳에서 이미 처리됐습니다")).toBeVisible();
  expect((await db.seller.findUniqueOrThrow({ where: { id: idA } })).status).toBe("ACTIVE");
});

test("CS: 목록·상세는 볼 수 있지만 이용 정지·해제 버튼은 없다", async ({ page }) => {
  await login(page, emails.cs);
  await search(page, slugA);
  await expect(page.getByTestId("partner-row")).toHaveCount(1);
  await expect(page.getByTestId("partner-row").getByRole("button", { name: /이용 정지|정지 해제/ })).toHaveCount(0);
  await expect(page.locator("th", { hasText: "관리" })).toHaveCount(1);
  await page.getByRole("link", { name: nameA }).click();
  await expect(page.getByRole("heading", { name: nameA, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /이용 정지|정지 해제/ })).toHaveCount(0);
});

test("목록: 요약 칩 건수가 서버 값과 같고, 칩·정렬·쪽 크기는 주소에 남으며, 엑셀 내려받기에 연락처가 없다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto("/admin/partners");
  const api = await (await page.request.get("/api/admin/sellers?summary=1&limit=1")).json();
  await expect(page.getByRole("button", { name: new RegExp(`^전체 ${api.summary.total}$`) })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^정상 ${api.summary.normal}$`) })).toBeVisible();

  await page.getByRole("button", { name: /^정상 \d+$/ }).click();
  await expect(page).toHaveURL(/state=NORMAL/);
  await expect(page.getByRole("button", { name: /^정상 \d+$/ })).toHaveAttribute("aria-pressed", "true");
  for (const text of await page.getByTestId("partner-row").locator("td:nth-child(3)").allInnerTexts()) expect(text).toBe("정상");

  await page.getByLabel("정렬").selectOption("orders");
  await page.getByLabel("쪽 크기").selectOption("50");
  await expect(page).toHaveURL(/sort=orders/);
  await expect(page).toHaveURL(/limit=50/);
  await page.reload();
  await expect(page.getByLabel("정렬")).toHaveValue("orders");

  const href = await page.getByRole("link", { name: "엑셀 내려받기" }).or(page.locator("a", { hasText: "엑셀 내려받기" })).first().getAttribute("href");
  expect(href).toContain("/api/admin/sellers/export");
  const csv = await (await page.request.get(href!)).text();
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).not.toContain("@example.com");

  await page.getByTestId("partner-row").first().getByRole("button", { name: "이 파트너스 화면 대신 보기" }).click();
  await expect(page.getByRole("dialog")).toContainText("대신 보시겠습니까");
});
