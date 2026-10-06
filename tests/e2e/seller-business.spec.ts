import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-060 ③ 사업자·고객센터: 읽기 전용 사업자 4개 + 주소·전화·운영시간 저장. SA-062 「사업자 정보·고지」 탭과 같은 값이어야 한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const PHONE = `02-${String(Date.now()).slice(-4)}-${String(Date.now() + 1).slice(-4)}`;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page, next: string, email = "demo-owner@example.com") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${next}$`));
}

test("사업자·고객센터: 잘못된 전화는 막고, 저장하면 법정 고지 탭에도 같은 값이 보인다", async ({ page }) => {
  await open(page, "/seller/settings/shop");
  const section = page.getByTestId("business-section");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("biz-company").locator("input")).toHaveAttribute("readonly", "");

  const savePage = () => page.getByRole("button", { name: "저장", exact: true }).click();

  await section.getByLabel("사업장 주소").fill("서울시 테스트로 1");

  // 잘못된 전화는 확인 창 전에 막는다
  await section.getByLabel("고객센터 연락처").fill("abc");
  await savePage();
  await expect(section.getByText("전화번호는 숫자·하이픈·괄호만 입력할 수 있습니다")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 필수 칸을 비우면 막는다
  await section.getByLabel("고객센터 연락처").fill("");
  await savePage();
  await expect(section.getByText("고객센터 연락처를 입력해 주십시오")).toBeVisible();

  await section.getByLabel("고객센터 연락처").fill(PHONE);
  await savePage();
  await expect(page.getByRole("dialog")).toContainText("사업자 · 고객센터 변경이 구매자 쇼핑몰에 바로 바뀝니다");
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("쇼핑몰 정보를 저장했습니다")).toBeVisible();

  // 카카오톡·유튜브 채널 주소: https만 받고, 저장하면 법정 고지 값과 구매자 공개 값에 같이 남는다
  const kakao = `https://pf.kakao.com/_e2e${Date.now().toString(36)}`;
  await section.getByLabel("카카오톡 채널 주소").fill("pf.kakao.com/abc");
  await savePage();
  await expect(section.getByText("카카오톡 채널 주소는 https://로 시작하는 주소만 쓸 수 있습니다")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await section.getByLabel("카카오톡 채널 주소").fill(kakao);
  await savePage();
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("쇼핑몰 정보를 저장했습니다")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("business-section").getByLabel("카카오톡 채널 주소")).toHaveValue(kakao);

  await page.goto("/seller/settings/legal");
  await page.getByRole("tab", { name: "사업자 정보·고지" }).click();
  await expect(page.getByLabel("고객센터 전화")).toHaveValue(PHONE);
});

test("사업자·고객센터: 쇼핑몰 설정 권한이 없는 직원에게는 보이지 않는다", async ({ page }) => {
  await open(page, "/seller/settings/shop", "demo-none@example.com");
  await expect(page.getByTestId("domain-section")).toHaveCount(0);
  await expect(page.getByTestId("business-section")).toHaveCount(0);
});
