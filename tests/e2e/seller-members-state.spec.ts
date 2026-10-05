import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// UX 감사 P1: 회원 목록(SA-041)의 검색·상태 필터가 상세에 갔다 Back으로 돌아와도 복원된다(IA Back 규칙 3항).
// 개인정보 열람 권한이 있으면 검색어(이름·휴대폰일 수 있음)는 주소에 넣지 않고 history state에, 없으면 주소(?q=)에 둔다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/login?next=%2Fseller%2Fmembers");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/members$/);
  await expect(page.getByTestId("member-row").first()).toBeVisible();
}

test("개인정보 열람 권한이 있으면 검색어는 주소에 남지 않고, 상태 필터는 주소에 남으며, 상세 → Back에서 둘 다 돌아온다", async ({ page }) => {
  await open(page);
  const rows = page.getByTestId("member-row");
  const search = page.getByLabel("회원 검색");
  await search.fill("카드왕");
  await expect(rows).toHaveCount(1);
  await page.getByRole("button", { name: /^활동/ }).click();
  await expect(page).toHaveURL(/\/seller\/members\?status=ACTIVE$/);
  // 검색어는 개인정보일 수 있어 주소에 없다
  expect(page.url()).not.toContain("q=");
  await expect(rows).toHaveCount(1);

  await rows.first().getByRole("link").click();
  await expect(page).toHaveURL(/\/seller\/members\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/seller\/members\?status=ACTIVE$/);
  await expect(search).toHaveValue("카드왕");
  await expect(page.getByRole("button", { name: /^활동/ })).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("카드왕");

  // 새로 고쳐도 상태 필터와 검색어가 남는다(history state는 새로 고침에도 유지)
  await page.reload();
  await expect(search).toHaveValue("카드왕");
  await expect(rows).toHaveCount(1);

  // 조건 초기화 → 전체 목록, 주소도 깨끗
  await page.getByLabel("회원 검색").fill("");
  await page.getByRole("button", { name: /^활동/ }).click();
  await expect(page).toHaveURL(/\/seller\/members$/);
  await expect(rows).toHaveCount(3);
});

test("개인정보 열람 권한이 없으면(닉네임 검색뿐) 검색어도 주소(?q=)에 남아 상세 → Back에서 돌아온다", async ({ page }) => {
  // 이 계정에 개인정보 열람 권한이 없는 것처럼 /me 응답만 바꾼다(서버 권한 차단은 서버 시험 소관, 여기서는 화면의 보존 방식만 본다)
  await page.route("**/api/seller/me", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, isOwner: false, permissions: ["MEMBER_POINTS"] } });
  });
  await open(page);
  await expect(page.getByLabel("회원 검색")).toHaveAttribute("placeholder", "방송 닉네임");
  const rows = page.getByTestId("member-row");
  await page.getByLabel("회원 검색").fill("카드왕");
  await expect(page).toHaveURL(/\/seller\/members\?q=%EC%B9%B4%EB%93%9C%EC%99%95$/);
  await expect(rows).toHaveCount(1);
  await rows.first().getByRole("link").click();
  await expect(page).toHaveURL(/\/seller\/members\/[0-9a-f-]{36}$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/seller\/members\?q=/);
  await expect(page.getByLabel("회원 검색")).toHaveValue("카드왕");
  await expect(rows).toHaveCount(1);
});
