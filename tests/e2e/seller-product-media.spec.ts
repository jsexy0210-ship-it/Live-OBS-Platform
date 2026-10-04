import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-012 상품 등록: 이미지 칸(대표 이미지·순서·삭제)과 상세 페이지 편집 칸(글·이미지 블록, 순서, 미리보기).
const PASSWORD = process.env.E2E_PASSWORD ?? "";
// 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const png = (name: string) => ({ name, mimeType: "image/png", buffer: PNG });

async function openNew(page: Page) {
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await page.waitForURL(/\/seller\/(?!login)/);
  await page.goto("/seller/products/new");
  await expect(page.getByLabel("상품명")).toBeVisible();
}

test("이미지 칸: 첫 이미지가 대표, 여러 장 올리고 순서를 바꾸고 지울 수 있다", async ({ page }) => {
  await openNew(page);
  const tiles = page.getByTestId("product-image");
  await expect(tiles).toHaveCount(0);
  await expect(page.getByText("0 / 10")).toBeVisible();
  await page.getByLabel("상품 이미지 파일").setInputFiles([png("a.png"), png("b.png"), png("c.png")]);
  await expect(tiles).toHaveCount(3);
  await expect(page.getByText("3 / 10")).toBeVisible();
  await expect(tiles.nth(0).getByText("대표")).toBeVisible();
  // 순서: 이미지 3을 앞으로 두 번 → 대표가 된다
  const third = await tiles.nth(2).locator("img").getAttribute("src");
  await tiles.nth(2).getByRole("button", { name: "이미지 3 앞으로" }).click({ force: true });
  await tiles.nth(1).getByRole("button", { name: "이미지 2 앞으로" }).click({ force: true });
  await expect(tiles.nth(0).locator("img")).toHaveAttribute("src", third!);
  await expect(tiles.nth(0).getByText("대표")).toBeVisible();
  // 지우기
  await tiles.nth(1).getByRole("button", { name: "이미지 2 지우기" }).click({ force: true });
  await expect(tiles).toHaveCount(2);
  await expect(page.getByText("2 / 10")).toBeVisible();
});

test("이미지 칸: 종류·크기가 맞지 않는 파일은 올리지 않고 이유를 알려 준다, 10장까지", async ({ page }) => {
  await openNew(page);
  await page.getByLabel("상품 이미지 파일").setInputFiles({ name: "x.gif", mimeType: "image/gif", buffer: PNG });
  await expect(page.getByRole("alert").filter({ hasText: "PNG · JPG · WEBP만 올릴 수 있습니다" })).toBeVisible();
  await expect(page.getByTestId("product-image")).toHaveCount(0);
  await page.getByLabel("상품 이미지 파일").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(page.getByRole("alert").filter({ hasText: "5MB 이하만 올릴 수 있습니다" })).toBeVisible();
  const eleven = Array.from({ length: 11 }, (_, i) => png(`n${i}.png`));
  await page.getByLabel("상품 이미지 파일").setInputFiles(eleven);
  await expect(page.getByTestId("product-image")).toHaveCount(10);
  await expect(page.getByRole("alert").filter({ hasText: "이미지는 10장까지 올릴 수 있습니다" })).toBeVisible();
  await expect(page.getByRole("button", { name: /이미지 올리기/ })).toHaveCount(0);
});

test("상세 페이지: 글·이미지 블록을 추가하고 순서를 바꾸고 미리보기로 순서대로 본다", async ({ page }) => {
  await openNew(page);
  const blocks = page.getByTestId("detail-block");
  await page.getByRole("button", { name: "+ 글 추가" }).click();
  await page.getByRole("button", { name: "+ 이미지 추가" }).click();
  await page.getByRole("button", { name: "+ 글 추가" }).click();
  await expect(blocks).toHaveCount(3);
  await page.getByLabel("블록 1 글").fill("첫 번째 글");
  await page.getByLabel("블록 3 글").fill("마지막 글");
  await page.getByLabel("블록 2 이미지 파일").setInputFiles(png("d.png"));
  await expect(blocks.nth(1).locator("img")).toBeVisible();
  // 마지막 글을 맨 위로
  await page.getByRole("button", { name: "블록 3 위로" }).click();
  await page.getByRole("button", { name: "블록 2 위로" }).click();
  await expect(page.getByLabel("블록 1 글")).toHaveValue("마지막 글");
  await page.getByRole("button", { name: "미리보기" }).click();
  const pv = page.getByTestId("detail-preview");
  await expect(pv.locator("p").first()).toHaveText("마지막 글");
  await expect(pv.locator("img")).toHaveCount(1);
  await page.getByRole("button", { name: "편집으로 돌아가기" }).click();
  await page.getByRole("button", { name: "블록 1 지우기" }).click();
  await expect(blocks).toHaveCount(2);
});
