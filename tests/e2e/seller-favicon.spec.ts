import { expect, test, type Page } from "@playwright/test";
import { jpeg, png } from "../unit/shopContentFixtures";
import { submitSellerLogin } from "./sellerLogin";

// SA-060 쇼핑몰 정보 ②: 탭 아이콘(파비콘) 올리기·지우기. PNG 정사각형 64~1024px·256KB 이하, 올리면 바로 반영, 지우기는 확인 창.
const PASSWORD = process.env.E2E_PASSWORD ?? "";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fshop");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/shop$/);
  await expect(page.getByTestId("favicon-box")).toBeVisible();
}

const file = (name: string, buffer: Buffer) => ({ name, mimeType: "image/png", buffer });
const isFavicon = (method: string) => (r: { request(): { method(): string }; url(): string }) => r.request().method() === method && r.url().endsWith("/api/seller/favicon");

test("탭 아이콘: 잘못된 파일은 이유를 보이고, 올리면 바로 반영되며 미리보기 탭에도 보이고, 지우기는 확인 창을 거친다", async ({ page }) => {
  await open(page);
  const input = page.getByLabel("탭 아이콘 파일");
  // 정사각형이 아니거나 PNG가 아니면 서버가 거절하고 이유가 보인다
  await input.setInputFiles(file("icon.png", jpeg(128, 128)));
  await expect(page.getByText("PNG 파일만 올릴 수 있습니다")).toBeVisible();
  await input.setInputFiles(file("icon.png", png(128, 64)));
  await expect(page.getByText("파비콘은 가로와 세로가 같은 정사각형이어야 합니다")).toBeVisible();

  // 올리기: PUT 한 번, 바로 반영
  const put = page.waitForResponse(isFavicon("PUT"));
  await input.setInputFiles(file("icon.png", png(128, 128)));
  expect((await put).status()).toBe(200);
  await expect(page.getByText("탭 아이콘을 바꿨습니다 · 쇼핑몰에 바로 반영됩니다")).toBeVisible();
  await expect(page.getByTestId("favicon-box").locator("img")).toBeVisible();
  await expect(page.getByTestId("tab-preview").locator("img")).toHaveAttribute("src", /\/api\/shop\/demo-shop\/favicon\/32/);

  // 지우기: 확인 창 → DELETE
  await page.getByRole("button", { name: "지우기", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("탭 아이콘을 지우시겠습니까?");
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "지우기", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "지우기", exact: true }).click();
  const del = page.waitForResponse(isFavicon("DELETE"));
  await page.getByRole("dialog").getByRole("button", { name: "지우기", exact: true }).click();
  expect((await del).status()).toBe(200);
  await expect(page.getByText("탭 아이콘을 지웠습니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "지우기", exact: true })).toHaveCount(0);
});
