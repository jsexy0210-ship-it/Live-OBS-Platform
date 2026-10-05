import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-034 적립금 실지급 스위치: 기본 꺼짐, 켤 때 확인 체크가 있어야 켜진다(confirm: true), 끄기는 바로, 대표자만 변경. 테스트 DB에서 켜고 끈다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const URL_PATH = "/seller/rewards/live-payout";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function withDb<T>(fn: (db: PrismaClient, sellerId: string) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com", isOwner: true }, select: { sellerId: true } });
    return await fn(db, owner.sellerId);
  } finally {
    await db.$disconnect();
  }
}

// 폐기용 DB를 처음 상태로: 실지급 꺼짐, 변경 기록 없음(정책 행이 있으면 값만 되돌린다)
const reset = () =>
  withDb((db, sellerId) =>
    db.rewardPolicy.updateMany({ where: { sellerId }, data: { livePayoutEnabled: false, livePayoutChangedAt: null, livePayoutChangedBy: null } }),
  );

async function open(page: Page, email = "demo-owner@example.com") {
  await page.goto(`/seller/login?next=${encodeURIComponent(URL_PATH)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${URL_PATH}$`));
}

const isPut = (r: { request(): { method(): string }; url(): string }) => r.request().method() === "PUT" && r.url().endsWith("/api/seller/reward-live-payout");

test.afterAll(reset);

test("기본은 꺼짐. 켜기는 확인 창에서 체크해야 눌리고(confirm: true), 켜면 안내 띠·변경 기록이 보이며, 끄기는 확인 없이 된다", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByRole("heading", { name: "적립금 실지급" })).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveText("꺼짐");
  await expect(page.getByTestId("live-changed")).toHaveText("변경한 적 없음");
  await expect(page.getByTestId("live-on")).toHaveCount(0);

  // 취소하면 아무것도 보내지 않는다
  await page.getByTestId("live-on-button").click();
  await expect(page.getByRole("dialog")).toContainText("적립금 실지급을 켜시겠습니까?");
  await expect(page.getByTestId("live-on-confirm")).toBeDisabled();
  await page.getByRole("button", { name: "취소" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("live-status")).toHaveText("꺼짐");

  // 확인 체크 뒤 켠다
  await page.getByTestId("live-on-button").click();
  await page.getByLabel("위 내용을 확인했습니다").check();
  await expect(page.getByTestId("live-on-confirm")).toBeEnabled();
  const on = page.waitForResponse(isPut);
  await page.getByTestId("live-on-confirm").click();
  const res = await on;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ enabled: true, confirm: true });
  await expect(page.getByText("실지급을 켰습니다")).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveText("켜짐");
  await expect(page.getByTestId("live-on")).toBeVisible();
  await expect(page.getByTestId("live-changed")).toContainText("·");

  // 다시 열어도 켜져 있다
  await page.reload();
  await expect(page.getByTestId("live-status")).toHaveText("켜짐");

  // 끄기: 확인 없이 {enabled:false}
  const off = page.waitForResponse(isPut);
  await page.getByTestId("live-off").click();
  expect((await off).request().postDataJSON()).toEqual({ enabled: false });
  await expect(page.getByText("실지급을 껐습니다")).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveText("꺼짐");
  await expect(page.getByTestId("live-on")).toHaveCount(0);
});

test("대표자가 아니면 상태만 보고 바꾸는 버튼은 없다(회원·적립금 권한이 있어도)", async ({ page }) => {
  await reset();
  // 회원·적립금 권한을 잠깐 준 직원(대표자 아님). 끝나면 원래 권한으로 되돌린다
  const setPerms = (permissions: string[]) => withDb((db, sellerId) => db.sellerUser.updateMany({ where: { sellerId, email: "demo-staff@example.com" }, data: { permissions: permissions as never } }));
  await setPerms(["PRODUCT_MANAGE", "MEMBER_POINTS"]);
  try {
    await open(page, "demo-staff@example.com");
    await expect(page.getByTestId("live-status")).toBeVisible();
    await expect(page.getByText("변경은 대표자만 할 수 있습니다")).toBeVisible();
    await expect(page.getByTestId("live-on-button")).toHaveCount(0);
    await expect(page.getByTestId("live-off")).toHaveCount(0);
  } finally {
    await setPerms(["PRODUCT_MANAGE"]);
  }
});

test("회원·적립금 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await open(page, "demo-none@example.com");
  await expect(page.getByText("필요한 권한: 회원·적립금", { exact: false })).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveCount(0);
});
