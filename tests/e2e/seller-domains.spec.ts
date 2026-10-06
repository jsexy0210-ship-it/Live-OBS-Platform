import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-060 ③ 내 도메인: 주소 추가(확인 창) → 설정값 표(TXT·CNAME) → 연결 확인 → 연결 해제(확인 창). 실제 연결은 준비 중이라 안내만 한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const HOST = `shop-e2e-${Date.now().toString(36)}.example.com`;

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page, email = "demo-owner@example.com") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fshop");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/shop$/);
}

test("내 도메인: 추가하면 설정값 표가 보이고, 연결 확인은 아직이면 안내하며, 연결 해제는 확인 창을 거친다", async ({ page }) => {
  await open(page);
  const section = page.getByTestId("domain-section");
  await expect(section).toBeVisible();
  await expect(section.getByText("실제 도메인 연결(주소 연결 · 보안 인증서)은 준비 중입니다")).toBeVisible();

  const savePage = () => page.getByRole("button", { name: "저장", exact: true }).click();
  const dialog = () => page.getByRole("dialog");

  // 잘못된 주소는 서버가 이유를 알려 준다(페이지 저장 확인 뒤, 실패한 구역 이름과 함께)
  await page.getByLabel("연결할 주소").fill("https://bad.example.com/path");
  await savePage();
  await dialog().getByRole("button", { name: "저장", exact: true }).click();
  await expect(section.getByRole("alert")).toContainText("도메인은 shop.example.com 같은 영문 소문자 주소로 입력해 주십시오");
  await expect(page.getByText("저장하지 못한 구역이 있습니다 · 내 도메인:")).toBeVisible();

  // 저장 확인 창 취소 → 아무 것도 안 만들어진다
  await page.getByLabel("연결할 주소").fill(HOST);
  await savePage();
  await expect(dialog()).toContainText("내 도메인 변경이 구매자 쇼핑몰에 바로 바뀝니다");
  await dialog().getByRole("button", { name: "취소", exact: true }).click();
  await expect(section.getByTestId("domain-row").filter({ hasText: HOST })).toHaveCount(0);

  // 저장 확인 → 행 + 설정값 표(CNAME · TXT)
  await savePage();
  const post = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/seller/domains"));
  await dialog().getByRole("button", { name: "저장", exact: true }).click();
  expect((await post).status()).toBe(201);
  const row = section.getByTestId("domain-row").filter({ hasText: HOST });
  await expect(row).toContainText("연결 확인 중");
  const table = section.getByTestId("dns-table");
  await expect(table).toContainText("CNAME");
  await expect(table).toContainText(`_onq-verify.${HOST}`);
  await expect(table).toContainText("onq-verify=");
  await expect(section.getByText(/확인하지 않으면 .*에 사라집니다/)).toBeVisible();

  // 연결 확인: 설정값을 넣지 않았으니 아직 확인되지 않는다
  await row.getByRole("button", { name: "연결 확인" }).click();
  await expect(page.getByText(/아직 확인되지 않았습니다|소유 확인이 끝났습니다/)).toBeVisible();

  // 연결 해제: 확인 창 → 삭제
  await row.getByRole("button", { name: "연결 해제" }).click();
  await expect(page.getByRole("dialog")).toContainText(`「${HOST}」 연결을 해제하시겠습니까?`);
  const del = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/seller/domains/"));
  await page.getByRole("dialog").getByRole("button", { name: "연결 해제", exact: true }).click();
  expect((await del).status()).toBe(200);
  await expect(section.getByTestId("domain-row").filter({ hasText: HOST })).toHaveCount(0);
});

test("「쇼핑몰 설정」 권한이 없는 직원에게는 내 도메인 구역이 보이지 않는다", async ({ page }) => {
  await open(page, "demo-none@example.com");
  await expect(page.getByTestId("domain-section")).toHaveCount(0);
});
