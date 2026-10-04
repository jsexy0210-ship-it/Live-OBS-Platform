import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-041 회원 목록·검색, SA-042 회원 상세: 데모 구매자(dev-seed: 별빛사냥꾼·카드왕·민트컨디션)로 실제 API를 눌러 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("대표자: 회원 목록에서 닉네임으로 찾고, 상세에서 주문·누적 결제·적립금을 서버 값 그대로 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fmembers");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/members$/);
  await expect(page.getByRole("link", { name: "회원", exact: true })).toHaveAttribute("href", "/seller/members");

  const rows = page.getByTestId("member-row");
  for (const nick of ["별빛사냥꾼", "카드왕", "민트컨디션"]) await expect(rows.filter({ hasText: nick })).toHaveCount(1);
  // 대표자는 개인정보 열람이 되므로 이름 열이 있다
  await expect(page.locator("thead").getByText("이름 · 휴대폰", { exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: "카드왕" })).toContainText("데모구매자2");
  await shot(page, "SA-041-members");

  // 검색: 마지막 조건의 응답만 반영된다
  const searched = page.waitForResponse((r) => r.url().includes("/api/seller/members?") && r.url().includes("q=") && r.ok());
  await page.getByLabel("회원 검색").fill("카드왕");
  await searched;
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("카드왕");

  // 휴면 필터: 데모 회원은 모두 활동이라 결과가 없고, 조건 초기화로 돌아온다
  await page.getByRole("button", { name: "휴면" }).click();
  await expect(page.getByText("조건에 맞는 회원이 없습니다")).toBeVisible();
  await page.getByRole("button", { name: "조건 초기화" }).click();
  await expect(rows.filter({ hasText: "민트컨디션" })).toHaveCount(1);

  // 상세: 화면 숫자가 API 응답과 같다
  await rows.filter({ hasText: "별빛사냥꾼" }).getByRole("link", { name: "별빛사냥꾼" }).click();
  await expect(page).toHaveURL(/\/seller\/members\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const api = await page.evaluate(async (id) => (await (await fetch(`/api/seller/members/${id}`)).json()).member, id);
  await expect(page.getByRole("heading", { name: "별빛사냥꾼" })).toBeVisible();
  await expect(page.getByTestId("member-orders")).toHaveText(`${api.orderCount.toLocaleString("ko-KR")}건`);
  await expect(page.getByTestId("member-paid")).toHaveText(`${api.totalPaid.toLocaleString("ko-KR")}원`);
  await expect(page.getByTestId("member-reward")).toHaveText(`${api.rewardBalance.toLocaleString("ko-KR")}원`);
  await expect(page.getByText("데모구매자1")).toBeVisible();
  await shot(page, "SA-042-member-detail");

  // 없는 회원
  await page.goto("/seller/members/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("회원을 찾을 수 없습니다")).toBeVisible();
});

test("회원·적립금 권한이 없는 직원은 메뉴가 안 보이고, 주소로 들어와도 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fmembers");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/members$/);
  await expect(page.getByText("필요한 권한: 회원·적립금", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "회원", exact: true })).toHaveCount(0);
});
