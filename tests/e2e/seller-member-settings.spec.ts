import { expect, test, type Page } from "@playwright/test";

// SA-043 회원 정책(재가입 제한): 판매자가 켜고 기간을 고른 뒤 저장하면 그대로 남고, 저장 실패는 화면 위에 보인다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function putPolicy(page: Page, body: unknown) {
  const status = await page.evaluate(async (b) => {
    const res = await fetch("/api/seller/member-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return res.status;
  }, body);
  expect(status).toBe(200);
}

async function openAsOwner(page: Page) {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fmember");
  await page.getByLabel("이메일").fill("demo-owner@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/settings\/member$/);
  // 이전 실행 값에 기대지 않게 기본값(꺼짐·30일)으로 맞춘다
  await putPolicy(page, { rejoinRestrictionEnabled: false, rejoinRestrictionDays: 30 });
  await page.reload();
}

const saveButton = (page: Page) => page.getByRole("button", { name: "저장", exact: true }).last();

test("쇼핑몰 설정 탭에서 회원 정책으로 들어가 재가입 제한을 켜고 90일로 저장하면 다시 열어도 그대로다", async ({ page }) => {
  await openAsOwner(page);
  await expect(page.getByRole("heading", { name: "회원 정책" })).toBeVisible();
  await expect(page.getByRole("link", { name: "회원 정책" })).toHaveAttribute("aria-current", "page");
  const sw = page.getByRole("switch", { name: "탈퇴한 사람의 재가입 막기" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("꺼 두면 탈퇴한 사람도 바로 다시 가입할 수 있어요 · 기본 꺼짐")).toBeVisible();
  // 바꾸기 전에는 저장할 게 없다
  await expect(saveButton(page)).toBeDisabled();
  await sw.click();
  await expect(page.getByRole("radiogroup", { name: "제한 기간" }).getByRole("radio")).toHaveText(["30일", "90일", "180일", "1년"]);
  await page.getByRole("radio", { name: "90일" }).click();
  await expect(page.getByText("탈퇴한 날부터 90일 동안 같은 사람이 다시 가입할 수 없어요")).toBeVisible();
  await Promise.all([page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/member-policy") && r.ok()), saveButton(page).click()]);
  await expect(page.getByText("회원 정책을 저장했어요")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "탈퇴한 사람의 재가입 막기" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "90일" })).toHaveAttribute("aria-checked", "true");
  await putPolicy(page, { rejoinRestrictionEnabled: false, rejoinRestrictionDays: 30 });
});

test("저장에 실패하면 화면 위에 이유를 보여 주고 바꾼 값은 그대로 둔다", async ({ page }) => {
  await openAsOwner(page);
  await page.route("**/api/seller/member-policy", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_member_policy", message: "재가입 제한 기간은 1일에서 365일 사이로 정해 주세요" }) })
      : route.continue(),
  );
  await page.getByRole("switch", { name: "탈퇴한 사람의 재가입 막기" }).click();
  await saveButton(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "저장할 수 없어요." })).toContainText("재가입 제한 기간은 1일에서 365일 사이로 정해 주세요");
  await expect(page.getByRole("switch", { name: "탈퇴한 사람의 재가입 막기" })).toHaveAttribute("aria-checked", "true");
});

test("회원·적립금 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fmember");
  await page.getByLabel("이메일").fill("demo-staff@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/settings\/member$/);
  await expect(page.getByText("회원·적립금", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("switch", { name: "탈퇴한 사람의 재가입 막기" })).toHaveCount(0);
});
