import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-060 ③ 공지 · 이용안내(상단 공지 한 줄 · 홈 혜택 배너 · 이용안내)와 대표 주소: 페이지 하나의 「저장」으로 저장하고, 구매자 공개 값에도 반영된다.
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

test("공지 · 이용안내: 길이 오류를 막고, 저장하면 다시 열어도 그대로이며, 구매자 공개 값에 반영된다", async ({ page }) => {
  await open(page);
  const section = page.getByTestId("notice-section");
  await expect(section).toBeVisible();
  const savePage = () => page.getByRole("button", { name: "저장", exact: true }).click();

  await section.getByLabel("상단 공지 (한 줄)").fill("가".repeat(61));
  await savePage();
  await expect(section.getByText("상단 공지는 60자까지 쓸 수 있습니다")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const notice = `E2E 상단 공지 ${Date.now().toString(36)}`;
  await section.getByLabel("상단 공지 (한 줄)").fill(notice);
  await section.getByRole("radio", { name: "숨기기" }).check();
  await section.getByLabel("이용안내 · 교환 · 환불 정책").fill("개봉 전 주문은 취소할 수 있어요.\n개봉하면 환불이 안 돼요.");
  await savePage();
  await expect(page.getByRole("dialog")).toContainText("공지 · 이용안내 · 대표 주소가 구매자 쇼핑몰에 바로 바뀝니다");
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("쇼핑몰 정보를 저장했습니다")).toBeVisible();

  await page.reload();
  await expect(section.getByLabel("상단 공지 (한 줄)")).toHaveValue(notice);
  await expect(section.getByRole("radio", { name: "숨기기" })).toBeChecked();
  await expect(section.getByLabel("이용안내 · 교환 · 환불 정책")).toHaveValue("개봉 전 주문은 취소할 수 있어요.\n개봉하면 환불이 안 돼요.");
  const pub = await page.request.get("/api/shop/demo-shop/profile");
  expect((await pub.json()).topNotice).toBe(notice);

  // 비우면 지운다(원래대로)
  await section.getByLabel("상단 공지 (한 줄)").fill("");
  await section.getByRole("radio", { name: "보이기" }).check();
  await section.getByLabel("이용안내 · 교환 · 환불 정책").fill("");
  await savePage();
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("쇼핑몰 정보를 저장했습니다")).toBeVisible();
  expect((await (await page.request.get("/api/shop/demo-shop/profile")).json()).topNotice).toBeNull();
});

test("대표 주소: 소유 확인된 내 도메인이 없으면 「내 도메인」을 고를 수 없다", async ({ page }) => {
  await open(page);
  const domain = page.getByTestId("domain-section");
  await expect(domain.getByRole("radio", { name: /^기본 주소/ })).toBeChecked();
  await expect(domain.getByRole("radio", { name: /^내 도메인/ })).toBeDisabled();
  await expect(domain.getByText("소유 확인이 끝난 내 도메인이 있으면 대표 주소로 고를 수 있습니다")).toBeVisible();
});

test("「쇼핑몰 설정」 권한이 없는 직원에게는 공지 · 이용안내 구역이 보이지 않는다", async ({ page }) => {
  await open(page, "demo-none@example.com");
  await expect(page.getByTestId("notice-section")).toHaveCount(0);
});
