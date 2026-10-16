import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-024 영수증 · 세금계산서: 요약 · 검색 패널 · 신청 목록(비고), 실패 · 보류 건 다시 발행(대기로), 직접 발행 건 발행 완료 처리, 발행 방식. 권한 없는 직원은 안내만.
// 신청은 DB에 바로 만든다(구매자 신청 화면 · 발행 업체 연동은 따로). 번호는 화면에 뒤 4자리만 보이므로 봉인 값은 자리표시로 둔다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const URL_PATH = "/seller/orders/receipts";
const created: string[] = [];

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}
const cleanup = () =>
  withDb(async (db) => {
    await db.receiptIssue.deleteMany({ where: { requestId: { in: created } } });
    await db.orderReceiptRequest.deleteMany({ where: { id: { in: created } } });
  });
test.afterAll(cleanup);

async function seed() {
  return withDb(async (db) => {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug: "demo-shop" } });
    // 신청은 주문마다 하나만 걸 수 있어 서로 다른 주문 3개를 쓴다
    const orders = await db.order.findMany({ where: { sellerId: seller.id, receiptRequests: { none: {} } }, orderBy: { createdAt: "desc" }, take: 3 });
    expect(orders.length).toBe(3);
    const mk = async (base: (typeof orders)[number], kind: "CASH_RECEIPT_INCOME" | "TAX_INVOICE", status: "FAILED" | "ON_HOLD" | "ISSUED", amount: number, extra: { failureCode?: string; taxInfo?: object } = {}) => {
      const r = await db.orderReceiptRequest.create({
        data: { sellerId: seller.id, orderId: base.id, buyerMemberId: base.buyerMemberId, kind, identitySealed: "test-sealed", identityLast4: "1234", taxInfo: extra.taxInfo },
        select: { id: true },
      });
      created.push(r.id);
      await db.receiptIssue.create({ data: { sellerId: seller.id, requestId: r.id, status, amount, failureCode: extra.failureCode ?? null, issuedAt: status === "ISSUED" ? new Date() : null } });
      return r.id;
    };
    return {
      failed: await mk(orders[0], "CASH_RECEIPT_INCOME", "FAILED", 132000, { failureCode: "provider_error" }),
      hold: await mk(orders[1], "TAX_INVOICE", "ON_HOLD", 184000, { taxInfo: { companyName: "별빛상사", representative: "김별", email: "b@example.com" } }),
      issued: await mk(orders[2], "CASH_RECEIPT_INCOME", "ISSUED", 45000),
    };
  });
}

async function open(page: Page, email = "demo-owner@example.com") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent(URL_PATH)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${URL_PATH}$`));
}

test("신청 목록: 요약·검색·비고가 보이고, 실패 건은 다시 발행해 대기로, 대기 건은 발행 완료 처리한다", async ({ page }) => {
  const ids = await seed();
  await open(page);
  await expect(page.getByRole("heading", { level: 1, name: "영수증 · 세금계산서" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "영수증 · 세금계산서" })).toHaveAttribute("aria-current", "page");
  const rows = page.getByTestId("receipt-row");
  await expect(rows.filter({ hasText: "발행 업체 응답 오류" })).toContainText("실패");
  await expect(rows.filter({ hasText: "충전금 잔액이 부족" })).toContainText("별빛상사");
  const sum = page.getByTestId("receipt-summary");
  for (const k of ["발행 대기", "발행 완료 (이번 달)", "실패", "취소", "발행 금액 합계"]) await expect(sum).toContainText(k);
  await expect(page.getByRole("button", { name: "이번 달 내려받기" }).or(page.getByRole("link", { name: "이번 달 내려받기" }))).toBeVisible();
  for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.reload();
    await expect(rows.first()).toBeVisible();
    await page.screenshot({ path: `tests/e2e/screenshots/SA-024-receipts-${w}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(rows.first()).toBeVisible();

  // 검색 패널의 상태로 거르면 주소(?status=)가 따라간다
  await page.getByRole("radio", { name: "발행 완료", exact: true }).check();
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page).toHaveURL(/status=ISSUED/);
  await expect(rows.filter({ hasText: "발행 업체 응답 오류" })).toHaveCount(0);
  await expect(rows.first()).toContainText("발행 완료");
  await page.getByRole("button", { name: "초기화" }).click();
  await expect(rows.filter({ hasText: "발행 업체 응답 오류" })).toHaveCount(1);

  // 다시 발행: 확인 창 → 대기
  await rows.filter({ hasText: "발행 업체 응답 오류" }).getByRole("button", { name: "다시 발행" }).click();
  await expect(page.getByRole("dialog")).toContainText("다시 발행하시겠습니까?");
  await page.getByRole("dialog").getByRole("button", { name: "다시 발행", exact: true }).click();
  await expect(page.getByText("발행 대기로 돌렸습니다")).toBeVisible();
  const issue = await withDb((db) => db.receiptIssue.findFirstOrThrow({ where: { requestId: ids.failed }, select: { status: true, failureCode: true } }));
  expect(issue).toEqual({ status: "PENDING", failureCode: null });

  // 발행 완료 처리: 대기로 돌아온 건을 확인 창을 거쳐 발행 완료로 바꾼다(구매자 안내가 간다)
  const waiting = rows.filter({ hasText: "발행 대기" }).filter({ hasText: "132,000" });
  await waiting.getByRole("button", { name: "발행 완료 처리" }).click();
  await expect(page.getByRole("dialog")).toContainText("발행 완료 처리하시겠습니까?");
  await page.getByRole("dialog").getByRole("button", { name: "발행 완료 처리", exact: true }).click();
  await expect(page.getByText("1건을 발행 완료로 처리했습니다")).toBeVisible();
  const done = await withDb((db) => db.receiptIssue.findFirstOrThrow({ where: { requestId: ids.failed }, select: { status: true } }));
  expect(done.status).toBe("ISSUED");

  // 발행 방식: 직접 발행이 골라져 있고 자동 발행은 준비 중이라 고를 수 없다
  const mode = page.locator("section.au-fs").filter({ hasText: "발행 방식" });
  await expect(mode.getByRole("radio").first()).toBeChecked();
  await expect(mode.getByRole("radio").nth(1)).toBeDisabled();
  await expect(mode).toContainText("준비 중");
});

test("영수증 · 세금계산서 권한이 없는 직원은 안내만 본다", async ({ page }) => {
  await open(page, "demo-none@example.com").catch(() => undefined);
  await page.goto(URL_PATH);
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toBeVisible();
});
