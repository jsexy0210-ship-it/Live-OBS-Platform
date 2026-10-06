import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-060 쇼핑몰 정보(a): 이름·한 줄 소개·운영 상태를 고치고 아래 저장 줄(저장 앞 확인 창)로 저장한다. 주소 복사.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page, email = "demo-owner@example.com") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fshop");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/shop$/);
}

const isPut = (r: { request(): { method(): string }; url(): string }) => r.request().method() === "PUT" && r.url().endsWith("/api/seller/shop-profile");

test("이름·한 줄 소개: 글자 수가 보이고, 저장하면 확인 창을 거쳐 저장되며 다시 열어도 그대로이고, 취소는 저장된 값으로 되돌린다", async ({ page }) => {
  await open(page);
  const name = page.getByLabel("쇼핑몰 이름", { exact: true });
  const tagline = page.getByLabel("한 줄 소개");
  const before = { name: await name.inputValue(), tagline: await tagline.inputValue() };
  await expect(page.getByText(/^\d+ \/ 20$/)).toBeVisible();
  await expect(page.getByText(/^\d+ \/ 40$/)).toBeVisible();
  await expect(page.getByRole("radio", { name: "운영 중" })).toBeChecked();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();

  // 빈 이름·너무 긴 소개는 막고 이유를 보인다
  await name.fill("");
  await tagline.fill("가".repeat(41));
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("쇼핑몰 이름을 적어 주십시오")).toBeVisible();
  await expect(page.getByText("한 줄 소개는 40자까지 쓸 수 있습니다")).toBeVisible();

  // 취소: 저장된 값으로 돌아간다
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(name).toHaveValue(before.name);
  await expect(tagline).toHaveValue(before.tagline);

  // 저장: 확인 창 → 저장(PUT 한 번)
  await name.fill("별빛 카드숍");
  await tagline.fill("매일 밤 8시 라이브");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("쇼핑몰 정보를 저장하시겠습니까?");
  const put = page.waitForResponse(isPut);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  const res = await put;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toEqual({ shopName: "별빛 카드숍", shopTagline: "매일 밤 8시 라이브", operatingState: "OPEN" });
  await expect(page.getByText("쇼핑몰 정보를 저장했습니다 · 쇼핑몰에 바로 반영됩니다")).toBeVisible();
  await page.reload();
  await expect(name).toHaveValue("별빛 카드숍");
  await expect(tagline).toHaveValue("매일 밤 8시 라이브");

  // 처음 값으로 되돌려 둔다(소개를 비우면 지운다)
  await name.fill(before.name);
  await tagline.fill(before.tagline);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const back = page.waitForResponse(isPut);
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  expect((await back).status()).toBe(200);
});

test("쇼핑몰 주소는 기본 주소로 보이고 복사 버튼이 있다", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("shop-url")).toContainText("/shop/");
  await expect(page.getByRole("button", { name: "복사" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "쇼핑몰 보기" })).toHaveAttribute("href", /\/shop\//);
});

test("「쇼핑몰 설정」 권한이 없는 직원은 이름을 읽기만 하고 저장 줄이 없다", async ({ page }) => {
  await open(page, "demo-none@example.com");
  await expect(page.getByLabel("쇼핑몰 이름", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
});

test("운영 상태: 준비 중으로 바꾸면 전환 확인 창을 거쳐 저장되고, 다시 운영 중으로 돌릴 수 있다", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("radio", { name: "운영 중" })).toBeChecked();
  await page.getByRole("radio", { name: "준비 중" }).check();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("쇼핑몰을 「준비 중」으로 바꾸시겠습니까?");
  await expect(dialog).toContainText("주문 조회만 열립니다");
  await expect(dialog).toContainText("이미 받은 주문은 결제 · 처리할 수 있습니다");
  // 취소하면 서버에 보내지 않는다
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("radio", { name: "운영 중" })).toBeChecked();

  await page.getByRole("radio", { name: "준비 중" }).check();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const put = page.waitForResponse(isPut);
  await page.getByRole("dialog").getByRole("button", { name: "전환", exact: true }).click();
  const res = await put;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ operatingState: "PREPARING" });
  await page.reload();
  await expect(page.getByRole("radio", { name: "준비 중" })).toBeChecked();

  // 운영 중으로 돌려 둔다
  await page.getByRole("radio", { name: "운영 중" }).check();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("쇼핑몰을 「운영 중」으로 바꾸시겠습니까?");
  const back = page.waitForResponse(isPut);
  await page.getByRole("dialog").getByRole("button", { name: "전환", exact: true }).click();
  expect((await back).request().postDataJSON()).toMatchObject({ operatingState: "OPEN" });
  await page.reload();
  await expect(page.getByRole("radio", { name: "운영 중" })).toBeChecked();
});
