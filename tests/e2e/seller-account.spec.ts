import { expect, test, type Page } from "@playwright/test";
import { confirmLogout, submitSellerLogin } from "./sellerLogin";

// SA-120 내 계정(정본 SA-120.dc.html 2열): 이름 변경, 비밀번호 변경(확인 칸·현재 비밀번호 검증·항상 다른 곳 로그아웃), 시도 제한 안내(429), 로그아웃.
// 데모 대표자의 비밀번호를 바꾸는 시험은 끝에서 원래대로 되돌려 다른 시험에 영향이 없게 한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const TEMP_PASSWORD = "Temp-Account-98765";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function login(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/seller/login?next=%2Fseller%2Faccount");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL((u) => u.pathname === "/seller/account");
  await expect(page.getByRole("heading", { level: 1, name: "내 계정" })).toBeVisible();
}

// 서버에 쓰는 행동은 확인 창을 거친다
const sureName = (page: Page) => page.getByRole("dialog", { name: "이름을 저장하시겠습니까?" }).getByRole("button", { name: "저장" }).click();
const surePassword = (page: Page) => page.getByRole("dialog", { name: "비밀번호를 변경하시겠습니까?" }).getByRole("button", { name: "비밀번호 변경" }).click();

test("내 정보가 보이고, 이름을 바꾸면 저장되며 다시 열어도 유지된다(원래대로 되돌림)", async ({ page }) => {
  await login(page);
  await expect(page.getByTestId("account-info")).toContainText("demo-owner@example.com");
  await expect(page.getByTestId("account-info")).toContainText("대표자");
  const input = page.getByLabel("이름");
  const original = await input.inputValue();
  const save = page.getByTestId("account-name-form").getByRole("button", { name: "저장" });
  await input.fill("  계정시험 이름 ");
  await save.click();
  await sureName(page);
  await expect(page.getByText("프로필을 저장했습니다")).toBeVisible();
  await expect(input).toHaveValue("계정시험 이름");
  await page.reload();
  await expect(page.getByLabel("이름")).toHaveValue("계정시험 이름");
  await page.getByLabel("이름").fill("");
  await save.click();
  await expect(page.getByText("이름을 입력해 주십시오")).toBeVisible();
  await page.getByLabel("이름").fill(original);
  await save.click();
  await sureName(page);
  await expect(page.getByText("프로필을 저장했습니다")).toBeVisible();
});

test("비밀번호 변경: 확인 칸이 다르면 막고, 현재 비밀번호가 틀리면 그 칸 아래에 서버 문구를 보이며, 바꾼 뒤 임시 비밀번호가 현재 비밀번호로 통하는지 확인하고 되돌린다", async ({ page }) => {
  await login(page);
  const form = page.getByTestId("account-password-form");
  const submit = form.getByRole("button", { name: "비밀번호 변경" });
  await expect(form.getByText("변경 시 다른 기기에서 로그아웃됩니다")).toBeVisible();
  await expect(form.getByText("8자 이상 입력해 주십시오")).toBeVisible();
  await form.getByLabel("현재 비밀번호").fill(PASSWORD);
  await form.getByLabel("새 비밀번호", { exact: true }).fill(TEMP_PASSWORD);
  await form.getByLabel("새 비밀번호 확인").fill("다른-비밀번호-0000");
  await submit.click();
  await expect(form.getByText("새 비밀번호가 서로 다릅니다")).toBeVisible();

  await form.getByLabel("새 비밀번호 확인").fill(TEMP_PASSWORD);
  await form.getByLabel("현재 비밀번호").fill("틀린-비밀번호-0000");
  await submit.click();
  await surePassword(page);
  await expect(page.getByTestId("account-cur-error")).toBeVisible();
  await expect(page.getByTestId("account-cur-error")).not.toBeEmpty();

  await form.getByLabel("현재 비밀번호").fill(PASSWORD);
  await submit.click();
  await surePassword(page);
  await expect(page.getByText("비밀번호를 변경했습니다")).toBeVisible();
  await expect(form.getByLabel("현재 비밀번호")).toHaveValue("");

  // 되돌리기: 이 세션은 그대로이고, 임시 비밀번호가 현재 비밀번호다
  await form.getByLabel("현재 비밀번호").fill(TEMP_PASSWORD);
  await form.getByLabel("새 비밀번호", { exact: true }).fill(PASSWORD);
  await form.getByLabel("새 비밀번호 확인").fill(PASSWORD);
  // 앞 변경의 안내 문구가 아직 떠 있을 수 있어, 응답으로 되돌림이 끝난 것을 확인한다
  await submit.click();
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/seller/me/password") && r.request().method() === "POST"), surePassword(page)]);
  expect(res.status()).toBe(200);
});

test("우측 상단 로그아웃을 누르면 로그인 화면으로 간다", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "로그아웃" }).first().click();
  await confirmLogout(page);
  await page.waitForURL((u) => u.pathname === "/seller/login");
});

test("시도 제한(429)이면 서버 문구와 남은 시간을 보이고 입력·버튼을 막는다", async ({ page }) => {
  await login(page);
  await page.route("**/api/seller/me/password", (route) =>
    route.fulfill({ status: 429, json: { error: "rate_limited", message: "시도가 너무 많습니다. 잠시 후 다시 시도해 주십시오.", retryAfterSeconds: 90 } }),
  );
  const form = page.getByTestId("account-password-form");
  await form.getByLabel("현재 비밀번호").fill("아무거나-1234");
  await form.getByLabel("새 비밀번호", { exact: true }).fill("새-비밀번호-5678");
  await form.getByLabel("새 비밀번호 확인").fill("새-비밀번호-5678");
  await form.getByRole("button", { name: "비밀번호 변경" }).click();
  await surePassword(page);
  await expect(page.getByTestId("account-pw-error")).toContainText("시도가 너무 많습니다");
  await expect(page.getByTestId("account-pw-wait")).toContainText("초 뒤에 다시 시도");
  await expect(form.getByLabel("현재 비밀번호")).toBeDisabled();
  await expect(form.getByRole("button", { name: "비밀번호 변경" })).toBeDisabled();
});
