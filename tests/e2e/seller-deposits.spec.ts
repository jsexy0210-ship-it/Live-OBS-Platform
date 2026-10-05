import { expect, test, type Page } from "@playwright/test";
import { DEPOSIT_NICKNAMES, bumpLiveVersionInDb, clearPendingDepositsInDb, pendingDepositsInDb } from "./depositDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-026 입금 확인: 기한이 지난 무통장 입금 대기 주문 3건을 만들어 두고 실제 API로 단건·일괄 입금 확인을 눌러 본다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";
let made: Awaited<ReturnType<typeof pendingDepositsInDb>>;

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  made = await pendingDepositsInDb(SLUG);
});
test.afterAll(() => clearPendingDepositsInDb(SLUG, made));

const login = async (page: Page, email: string) => {
  await page.goto("/seller/login?next=%2Fseller%2Forders%2Fdeposits");
  await submitSellerLogin(page, email, PASSWORD);
};
const row = (page: Page, nickname: string) => page.getByTestId("deposit-row").filter({ hasText: nickname });
const statusOf = (page: Page, id: string) => page.evaluate(async (id) => (await (await fetch(`/api/seller/orders/${id}`)).json()).status, id);

test("목록을 받은 뒤 다른 곳에서 바뀌었으면 입금 확인이 막히고, 다시 불러오면 확인된다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(row(page, DEPOSIT_NICKNAMES[2])).toHaveCount(1);
  await bumpLiveVersionInDb(SLUG);
  await row(page, DEPOSIT_NICKNAMES[2]).getByRole("button", { name: "입금 확인" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "입금 확인" }).click();
  await expect(page.getByText("목록이 바뀌었습니다. 다시 불러온 뒤 확인해 주십시오")).toBeVisible();
  expect(await statusOf(page, made.orderIds[2])).toBe("PENDING_PAYMENT");
  // 새로 불러온 목록의 버전으로 다시 보내면 확인된다
  await expect(row(page, DEPOSIT_NICKNAMES[2])).toHaveCount(1);
  await row(page, DEPOSIT_NICKNAMES[2]).getByRole("button", { name: "입금 확인" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "입금 확인" }).click();
  await expect(row(page, DEPOSIT_NICKNAMES[2])).toHaveCount(0);
  expect(await statusOf(page, made.orderIds[2])).toBe("PAID");
});

test("대표자: 메뉴에서 입금 확인을 열고, 단건 확인 뒤 일괄 확인한다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  await expect(page).toHaveURL(/\/seller\/orders\/deposits$/);
  await expect(page.getByRole("complementary", { name: "파트너스 메뉴" }).getByRole("link", { name: "입금 확인", exact: true })).toHaveAttribute("href", "/seller/orders/deposits");
  for (const n of DEPOSIT_NICKNAMES.slice(0, 2)) await expect(row(page, n)).toHaveCount(1);
  // 기한이 2000년이라 지남으로 보이고, 입금자명은 대표자 개인정보 열람으로 열려 있다
  await expect(row(page, DEPOSIT_NICKNAMES[0])).toContainText("기한 지남");
  await expect(page.locator("thead").getByText("입금자명", { exact: true })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: "tests/e2e/screenshots/SA-026-deposits-1440.png", fullPage: true });

  // 목록 개수 문구가 서버 total과 같다
  const total = await page.evaluate(async () => (await (await fetch("/api/seller/payments/deposits?limit=1")).json()).total);
  await expect(page.locator(".au-lh-total")).toContainText(`총 ${total}건`);

  // 단건: 확인 창 → 입금 확인 → 목록에서 빠지고 주문 상태가 결제 완료
  await row(page, DEPOSIT_NICKNAMES[0]).getByRole("button", { name: "입금 확인" }).click();
  const dialog = page.getByRole("dialog", { name: "입금을 확인하시겠습니까?" });
  await expect(dialog).toContainText(DEPOSIT_NICKNAMES[0]);
  await dialog.getByRole("button", { name: "입금 확인" }).click();
  await expect(page.getByText("1건 입금 확인 · 주문대기에 올라갔습니다")).toBeVisible();
  await expect(row(page, DEPOSIT_NICKNAMES[0])).toHaveCount(0);
  expect(await statusOf(page, made.orderIds[0])).toBe("PAID");

  // 일괄: 선택 → 선택 입금 확인
  await expect(page.getByRole("button", { name: /^선택 입금 확인/ })).toBeDisabled();
  await page.getByRole("checkbox", { name: `${DEPOSIT_NICKNAMES[1]} 선택` }).check();
  await page.getByRole("button", { name: "선택 입금 확인 (1)" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "입금 확인" }).click();
  await expect(row(page, DEPOSIT_NICKNAMES[1])).toHaveCount(0);
  expect(await statusOf(page, made.orderIds[1])).toBe("PAID");
});

test("권한 없는 직원은 서버가 막아 권한 안내가 보인다", async ({ page }) => {
  await login(page, "demo-staff@example.com");
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toBeVisible();
  await expect(page.getByText("필요한 권한: 주문 · 배송")).toBeVisible();
});
