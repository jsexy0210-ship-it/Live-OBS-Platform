import { expect, test, type Page } from "@playwright/test";
import { cleanupProducts, RUN, track } from "./cleanup";
import { submitSellerLogin } from "./sellerLogin";

// SA-012 상품 등록·수정: 이미지 칸(대표 이미지·순서·삭제·되돌리기·저장)·카테고리·상품 코드·짧은 설명.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
// 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const png = (name: string) => ({ name, mimeType: "image/png", buffer: PNG });

test.afterAll(() => cleanupProducts(PASSWORD));

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
  // 지우기: 바로 빠지고 그 자리에 「지웠습니다 · 되돌리기」가 보인다. 되돌리면 그 자리로 돌아온다
  await tiles.nth(1).getByRole("button", { name: "이미지 2 지우기" }).click({ force: true });
  await expect(page.getByTestId("product-image-removed")).toBeVisible();
  await expect(tiles).toHaveCount(2);
  await expect(page.getByText("2 / 10")).toBeVisible();
  await page.getByRole("button", { name: "되돌리기" }).click();
  await expect(tiles).toHaveCount(3);
  await expect(page.getByText("3 / 10")).toBeVisible();
  // 되돌리지 않으면 5초 뒤 자리 표시가 사라진다
  await tiles.nth(1).getByRole("button", { name: "이미지 2 지우기" }).click({ force: true });
  await expect(page.getByTestId("product-image-removed")).toHaveCount(0, { timeout: 9000 });
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
  // 10장이 다 차면 올릴 빈 칸이 없다
  await expect(page.getByRole("button", { name: /^(대표 )?이미지( \d+)? 올리기$/ })).toHaveCount(0);
});

test("상세 페이지: 글·이미지 블록을 추가하고 순서를 바꾸고 미리보기로 순서대로 본다", async ({ page }) => {
  await openNew(page);
  const blocks = page.getByTestId("detail-block");
  await page.getByRole("button", { name: "+ 글 블록" }).click();
  await page.getByRole("button", { name: "+ 이미지 블록" }).click();
  await page.getByRole("button", { name: "+ 글 블록" }).click();
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
  await page.getByRole("button", { name: "블록 1 삭제" }).click();
  await expect(blocks).toHaveCount(2);
});

test("빈 칸은 10칸 중 올리지 않은 만큼 번호로 보이고, 첫 빈 칸이 「대표 이미지」→「추가 이미지」다", async ({ page }) => {
  await openNew(page);
  await expect(page.getByRole("button", { name: "대표 이미지 올리기" })).toBeVisible();
  await expect(page.locator(".pm-add")).toHaveCount(10);
  await page.getByLabel("상품 이미지 파일").setInputFiles(png("a.png"));
  await expect(page.locator(".pm-add")).toHaveCount(9);
  await expect(page.locator(".pm-add.is-first")).toContainText("추가 이미지");
});

test("카테고리·상품 코드·짧은 설명: 카테고리를 여러 개 골라 등록하면 지정되고, 수정 화면에 코드와 함께 다시 보인다", async ({ page }) => {
  await openNew(page);
  const origin = new URL(page.url()).origin;
  const hdr = { Origin: origin };
  const parent = await page.request.post("/api/seller/categories", { data: { name: `e2e대 ${RUN}` }, headers: hdr });
  expect(parent.status()).toBe(201);
  const parentId = ((await parent.json()) as { categories: { id: string; name: string }[] }).categories.find((c) => c.name === `e2e대 ${RUN}`)!.id;
  const child = await page.request.post("/api/seller/categories", { data: { name: `e2e소 ${RUN}`, parentId }, headers: hdr });
  expect(child.status()).toBe(201);
  try {
    await page.goto("/seller/products/new");
    const name = track(`카테고리상품 ${RUN}`);
    await page.getByLabel("상품명").fill(name);
    await page.getByLabel("판매가").fill("12000");
    await page.getByLabel("옵션 1 재고").fill("3");
    // 카테고리 고르기 창: 대분류와 하위를 함께 고른다 → 칩으로 보인다
    await page.getByRole("button", { name: "카테고리 고르기" }).click();
    const pick = page.getByRole("dialog", { name: /카테고리 고르기/ });
    await pick.getByRole("checkbox", { name: `e2e대 ${RUN}` }).check();
    await pick.getByRole("checkbox", { name: `e2e소 ${RUN}` }).check();
    await expect(pick.getByTestId("category-draft-count")).toContainText("2 / 10");
    await page.screenshot({ path: "tests/e2e/screenshots/SA-012-category-picker-1440.png" });
    await pick.getByRole("button", { name: "적용" }).click();
    await expect(page.getByTestId("category-chip")).toHaveText([`e2e대 ${RUN}×`, `e2e대 ${RUN} › e2e소 ${RUN}×`]);
    await expect(page.getByTestId("category-count")).toContainText("2 / 10");
    await page.screenshot({ path: "tests/e2e/screenshots/SA-012-category-chips-1440.png" });
    await expect(page.getByTestId("product-code")).toHaveText("등록 후 표시");
    await page.getByLabel("짧은 설명").fill("한 줄 소개");
    await expect(page.getByTestId("desc-count")).toHaveText("6/80");
    await page.getByRole("button", { name: "등록", exact: true }).first().click();
    await expect(page).toHaveURL(/\/seller\/products$/);
    await expect(page.getByText("상품을 등록했습니다")).toBeVisible();
    const list = await page.request.get(`/api/seller/products?q=${encodeURIComponent(name)}`);
    const id = ((await list.json()) as { products: { id: string }[] }).products[0]!.id;
    await page.goto(`/seller/products/${id}`);
    await expect(page.getByTestId("category-chip")).toHaveText([`e2e대 ${RUN}×`, `e2e대 ${RUN} › e2e소 ${RUN}×`]);
    await expect(page.getByTestId("product-code")).toHaveText(/^P\d{7}$/);
    await expect(page.getByLabel("짧은 설명")).toHaveValue("한 줄 소개");
    // 하위 칩을 지우고 저장하면 지정이 바뀐다(대분류만 남기기)
    await page.getByRole("button", { name: `e2e대 ${RUN} › e2e소 ${RUN} 지우기` }).click();
    await expect(page.getByTestId("category-chip")).toHaveCount(1);
    await page.getByRole("button", { name: "저장", exact: true }).first().click();
    await expect(page.getByText("저장했습니다")).toBeVisible();
    const cats = await page.request.get(`/api/seller/products/${id}/categories`);
    expect(((await cats.json()) as { categoryIds: string[] }).categoryIds).toEqual([parentId]);
  } finally {
    const tree = await page.request.get("/api/seller/categories");
    const nodes = ((await tree.json()) as { categories: { id: string; children: { id: string; name: string }[] }[] }).categories;
    const top = nodes.find((c) => c.id === parentId);
    for (const k of top?.children ?? []) await page.request.delete(`/api/seller/categories/${k.id}`, { headers: hdr });
    await page.request.delete(`/api/seller/categories/${parentId}`, { headers: hdr });
  }
});

test("카테고리는 상품당 10개까지: 11번째는 고를 수 없고 안내가 보인다", async ({ page }) => {
  await openNew(page);
  const hdr = { Origin: new URL(page.url()).origin };
  const ids: string[] = [];
  try {
    for (let i = 1; i <= 11; i++) {
      const r = await page.request.post("/api/seller/categories", { data: { name: `한도${String(i).padStart(2, "0")} ${RUN}` }, headers: hdr });
      expect(r.status()).toBe(201);
      ids.push(((await r.json()) as { categories: { id: string; name: string }[] }).categories.find((c) => c.name === `한도${String(i).padStart(2, "0")} ${RUN}`)!.id);
    }
    await page.goto("/seller/products/new");
    await page.getByRole("button", { name: "카테고리 고르기" }).click();
    const pick = page.getByRole("dialog", { name: /카테고리 고르기/ });
    for (let i = 1; i <= 10; i++) await pick.getByRole("checkbox", { name: `한도${String(i).padStart(2, "0")} ${RUN}` }).check();
    await expect(pick.getByTestId("category-draft-count")).toContainText("10 / 10");
    await expect(pick.getByRole("checkbox", { name: `한도11 ${RUN}` })).toBeDisabled();
    await expect(pick.getByText("11번째는 선택되지 않습니다")).toBeVisible();
    // 하나를 빼면 다시 고를 수 있다
    await pick.getByRole("checkbox", { name: `한도01 ${RUN}` }).uncheck();
    await expect(pick.getByRole("checkbox", { name: `한도11 ${RUN}` })).toBeEnabled();
  } finally {
    for (const id of ids) await page.request.delete(`/api/seller/categories/${id}`, { headers: hdr });
  }
});

// 실제 PNG(서버가 가로·세로 100~4000px를 확인한다). 크기로 어느 이미지인지 알아본다
async function pngBytes(page: Page, size: number, color: string) {
  const b64 = await page.evaluate(
    ({ size, color }) => {
      const cv = document.createElement("canvas");
      cv.width = size;
      cv.height = size;
      const x = cv.getContext("2d")!;
      x.fillStyle = color;
      x.fillRect(0, 0, size, size);
      return cv.toDataURL("image/png").split(",")[1]!;
    },
    { size, color },
  );
  return Buffer.from(b64, "base64");
}
const widths = async (page: Page, id: string) => ((await (await page.request.get(`/api/seller/products/${id}/images`)).json()) as { images: { width: number }[] }).images.map((i) => i.width);

test("이미지 저장: 등록하면 고른 순서대로 올라가고, 목록에 대표 이미지가 보이며, 수정 화면에 같은 순서로 보인다", async ({ page }) => {
  await openNew(page);
  const name = track(`이미지상품 ${RUN}`);
  await page.getByLabel("상품명").fill(name);
  await page.getByLabel("판매가").fill("9000");
  await page.getByLabel("옵션 1 재고").fill("3");
  await page.getByLabel("상품 이미지 파일").setInputFiles([
    { name: "a.png", mimeType: "image/png", buffer: await pngBytes(page, 200, "#4a7bd9") },
    { name: "b.png", mimeType: "image/png", buffer: await pngBytes(page, 300, "#d9884a") },
  ]);
  // b를 대표로
  await page.getByTestId("product-image").nth(1).getByRole("button", { name: "이미지 2 앞으로" }).click({ force: true });
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page.getByText("상품을 등록했습니다")).toBeVisible();
  const found = await page.request.get(`/api/seller/products?q=${encodeURIComponent(name)}`);
  const item = ((await found.json()) as { products: { id: string; thumbnailUrl: string | null }[] }).products[0]!;
  expect(await widths(page, item.id)).toEqual([300, 200]);
  expect(item.thumbnailUrl).toBeTruthy();
  // 목록: 검색해서 대표 이미지가 보인다
  await page.getByLabel("상품 검색").fill(name);
  await page.getByRole("search", { name: "목록 조건" }).getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByTestId("product-row").first().getByTestId("product-thumb")).toBeVisible();
  // 수정 화면: 같은 순서로 2장
  await page.goto(`/seller/products/${item.id}`);
  const tiles = page.getByTestId("product-image");
  await expect(tiles).toHaveCount(2);
  await expect(page.getByText("2 / 10")).toBeVisible();
  const first = await tiles.nth(0).locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth);
  expect(first).toBe(300);
});

test("이미지 수정 저장: 지우고 바로 저장해도 서버에서 지워지고, 새 파일은 올라가며, 바꾼 순서가 저장된다", async ({ page }) => {
  await openNew(page);
  const hdr = { Origin: new URL(page.url()).origin };
  const name = track(`이미지수정 ${RUN}`);
  const made = await page.request.post("/api/seller/products", { data: { name, price: 5000, status: "DRAFT", options: [{ name: "기본", priceDelta: 0, stock: 1, sortOrder: 0 }] }, headers: hdr });
  expect(made.status()).toBe(201);
  const { id } = (await made.json()) as { id: string };
  for (const [size, color] of [[200, "#4a7bd9"], [300, "#d9884a"]] as const) {
    const up = await page.request.post(`/api/seller/products/${id}/images`, { data: await pngBytes(page, size, color), headers: hdr });
    expect(up.status()).toBe(201);
  }
  expect(await widths(page, id)).toEqual([200, 300]);
  await page.goto(`/seller/products/${id}`);
  const tiles = page.getByTestId("product-image");
  await expect(tiles).toHaveCount(2);
  // 첫 이미지(200)를 지우고(되돌리기 시간 안에) 새 이미지(400)를 올린 뒤 400을 맨 앞으로
  await tiles.nth(0).getByRole("button", { name: "이미지 1 지우기" }).click({ force: true });
  await page.getByLabel("상품 이미지 파일").setInputFiles({ name: "c.png", mimeType: "image/png", buffer: await pngBytes(page, 400, "#5aa86b") });
  await expect(tiles).toHaveCount(2);
  await tiles.nth(1).getByRole("button", { name: "이미지 2 앞으로" }).click({ force: true });
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했습니다")).toBeVisible();
  expect(await widths(page, id)).toEqual([400, 300]);
  // 저장 뒤 화면도 서버 이미지로 바뀌어 다시 저장해도 되풀이하지 않는다
  await expect(tiles).toHaveCount(2);
});

test("상세 페이지 저장: 글·이미지 블록이 순서대로 저장되고, 수정에서 지운 이미지 블록은 서버에서도 지워지며, 빈 글 블록은 저장 전에 알려 준다", async ({ page }) => {
  await openNew(page);
  const name = track(`상세상품 ${RUN}`);
  await page.getByLabel("상품명").fill(name);
  await page.getByLabel("판매가").fill("7000");
  await page.getByLabel("옵션 1 재고").fill("2");
  await page.getByRole("button", { name: "+ 글 블록" }).click();
  await page.getByRole("button", { name: "+ 이미지 블록" }).click();
  await page.getByLabel("블록 1 글").fill("첫 글");
  await page.getByLabel("블록 2 이미지 파일").setInputFiles({ name: "d.png", mimeType: "image/png", buffer: await pngBytes(page, 250, "#8a5ad9") });
  // 빈 글 블록은 저장 전에 알려 준다
  await page.getByRole("button", { name: "+ 글 블록" }).click();
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page.getByText("비어 있는 글 블록이 있습니다").first()).toBeVisible();
  await page.getByLabel("블록 3 글").fill("마지막 글");
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page.getByText("상품을 등록했습니다")).toBeVisible();
  const found = await page.request.get(`/api/seller/products?q=${encodeURIComponent(name)}`);
  const id = ((await found.json()) as { products: { id: string }[] }).products[0]!.id;
  type Detail = { blocks: ({ type: "text"; text: string } | { type: "image"; imageId: string; width: number })[]; images: { id: string }[] };
  const read = async () => (await (await page.request.get(`/api/seller/products/${id}/detail`)).json()) as Detail;
  const d1 = await read();
  expect(d1.blocks.map((b) => b.type)).toEqual(["text", "image", "text"]);
  expect((d1.blocks[1] as { width: number }).width).toBe(250);
  // 수정: 이미지 블록을 지우고 글을 바꿔 저장하면 서버의 상세 사진도 지워진다
  await page.goto(`/seller/products/${id}`);
  await expect(page.getByTestId("detail-block")).toHaveCount(3);
  await page.getByRole("button", { name: "블록 2 삭제" }).click();
  await page.getByLabel("블록 1 글").fill("바뀐 첫 글");
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했습니다")).toBeVisible();
  const d2 = await read();
  expect(d2.blocks).toEqual([
    { type: "text", text: "바뀐 첫 글" },
    { type: "text", text: "마지막 글" },
  ]);
  expect(d2.images).toHaveLength(0);
});
