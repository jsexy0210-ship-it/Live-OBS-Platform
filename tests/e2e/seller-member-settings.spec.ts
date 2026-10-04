import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";
import { setMemberPolicyInDb } from "./memberPolicyDb";

// SA-043 회원 정책(재가입 제한): 동의 철회 기능 전에는 켤 수 없고(스위치 비활성·409), 이미 켜진 쇼핑몰은 끌 수 있다. 저장 실패는 화면 위에 보인다.
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

test("쇼핑몰 설정 탭에서 회원 정책으로 들어가면, 동의 철회 기능 전이라 재가입 제한 스위치는 꺼진 채 비활성이고 안내를 보여 준다. API로 켜도 409", async ({ page }) => {
  await openAsOwner(page);
  await expect(page.getByRole("heading", { name: "회원 정책" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "쇼핑몰 설정" }).getByRole("link", { name: "회원 정책" })).toHaveAttribute("aria-current", "page");
  const sw = page.getByRole("switch", { name: "탈퇴한 사람의 재가입 막기" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(sw).toBeDisabled();
  await expect(page.getByText("회원이 동의를 철회할 수 있는 화면이 준비되면 켤 수 있습니다")).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
  const status = await page.evaluate(async () => {
    const res = await fetch("/api/seller/member-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 90 }) });
    return { status: res.status, body: await res.json() };
  });
  expect(status).toEqual({ status: 409, body: { error: "rejoin_restriction_unavailable", message: "회원이 동의를 철회할 수 있는 화면이 준비되면 켤 수 있습니다" } });
});

test("이미 켜진 쇼핑몰은 끄기만 할 수 있고, 끄기 저장에 실패하면 화면 위에 이유를 보여 주고 바꾼 값은 그대로 둔다", async ({ page }) => {
  await openAsOwner(page);
  await setMemberPolicyInDb("demo-shop", true, 90);
  try {
    await page.reload();
    const sw = page.getByRole("switch", { name: "탈퇴한 사람의 재가입 막기" });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(sw).toBeEnabled();
    await expect(page.getByRole("radio", { name: "90일" })).toHaveAttribute("aria-checked", "true");
    await page.route("**/api/seller/member-policy", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_member_policy", message: "재가입 제한 기간은 1일에서 365일 사이로 정해 주십시오" }) })
        : route.continue(),
    );
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await saveButton(page).click();
    await expect(page.getByRole("alert").filter({ hasText: "저장할 수 없습니다." })).toContainText("재가입 제한 기간은 1일에서 365일 사이로 정해 주십시오");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    // 실제로 끄면 저장된다
    await Promise.all([page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/member-policy") && r.ok()), saveButton(page).click()]);
    await expect(page.getByText("회원 정책을 저장했습니다")).toBeVisible();
  } finally {
    await setMemberPolicyInDb("demo-shop", false, 30);
  }
});

test("회원·적립금 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fmember");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/member$/);
  await expect(page.getByText("회원·적립금", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("switch", { name: "탈퇴한 사람의 재가입 막기" })).toHaveCount(0);
});
