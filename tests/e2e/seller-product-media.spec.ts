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

test("이미지 칸: 첫 이미지가 썸네일, 여러 장 올리고 순서를 바꾸고 지울 수 있다", async ({ page }) => {
  await openNew(page);
  const tiles = page.getByTestId("product-image");
  await expect(tiles).toHaveCount(0);
  await expect(page.getByText("0 / 5")).toBeVisible();
  await page.getByLabel("상품 이미지 파일").setInputFiles([png("a.png"), png("b.png"), png("c.png")]);
  await expect(tiles).toHaveCount(3);
  await expect(page.getByText("3 / 5")).toBeVisible();
  await expect(tiles.nth(0).getByText("썸네일", { exact: true })).toBeVisible();
  // 순서: 이미지 3을 앞으로 두 번 → 대표가 된다
  const third = await tiles.nth(2).locator("img").getAttribute("src");
  await tiles.nth(2).getByRole("button", { name: "이미지 3 앞으로" }).click({ force: true });
  await tiles.nth(1).getByRole("button", { name: "이미지 2 앞으로" }).click({ force: true });
  await expect(tiles.nth(0).locator("img")).toHaveAttribute("src", third!);
  await expect(tiles.nth(0).getByText("썸네일", { exact: true })).toBeVisible();
  // 지우기: 바로 빠지고 그 자리에 「지웠습니다 · 되돌리기」가 보인다. 되돌리면 그 자리로 돌아온다
  await tiles.nth(1).getByRole("button", { name: "이미지 2 지우기" }).click({ force: true });
  await expect(page.getByTestId("product-image-removed")).toBeVisible();
  await expect(tiles).toHaveCount(2);
  await expect(page.getByText("2 / 5")).toBeVisible();
  await page.getByTestId("product-image-removed").getByRole("button", { name: "되돌리기" }).click();
  await expect(tiles).toHaveCount(3);
  await expect(page.getByText("3 / 5")).toBeVisible();
  // 되돌리지 않으면 5초 뒤 자리 표시가 사라진다
  await tiles.nth(1).getByRole("button", { name: "이미지 2 지우기" }).click({ force: true });
  await expect(page.getByTestId("product-image-removed")).toHaveCount(0, { timeout: 9000 });
  await expect(tiles).toHaveCount(2);
  await expect(page.getByText("2 / 5")).toBeVisible();
});

test("썸네일 지정: 「썸네일로 지정」을 누르면 그 이미지가 썸네일이 되고 표시가 옮겨 간다, 지우면 첫 번째로 돌아간다", async ({ page }) => {
  await openNew(page);
  const tiles = page.getByTestId("product-image");
  await page.getByLabel("상품 이미지 파일").setInputFiles([png("a.png"), png("b.png"), png("c.png")]);
  await expect(tiles).toHaveCount(3);
  await expect(page.getByText("대표 이미지", { exact: true })).toHaveCount(1);
  await expect(tiles.nth(0)).toHaveClass(/is-thumb/);
  const buttons = page.getByRole("button", { name: "썸네일로 지정" });
  await expect(buttons).toHaveCount(2);
  await buttons.nth(1).click();
  await expect(tiles.nth(2)).toHaveClass(/is-thumb/);
  await expect(tiles.nth(2).getByText("썸네일", { exact: true })).toBeVisible();
  await expect(tiles.nth(0)).not.toHaveClass(/is-thumb/);
  await expect(page.getByText("대표 이미지", { exact: true })).toHaveCount(1);
  // 지정한 이미지를 지우면 첫 번째가 썸네일이다
  await tiles.nth(2).getByRole("button", { name: "이미지 3 지우기" }).click({ force: true });
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0)).toHaveClass(/is-thumb/);
});

test("이미지 칸: 종류·크기가 맞지 않는 파일은 올리지 않고 이유를 알려 준다, 5장까지", async ({ page }) => {
  await openNew(page);
  await page.getByLabel("상품 이미지 파일").setInputFiles({ name: "x.gif", mimeType: "image/gif", buffer: PNG });
  await expect(page.getByRole("alert").filter({ hasText: "PNG · JPG · WEBP만 올릴 수 있습니다" })).toBeVisible();
  await expect(page.getByTestId("product-image")).toHaveCount(0);
  await page.getByLabel("상품 이미지 파일").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(page.getByRole("alert").filter({ hasText: "5MB 이하만 올릴 수 있습니다" })).toBeVisible();
  // 6장을 한꺼번에 고르면 5장만 들어가고 나머지는 이유와 함께 거절한다
  const six = Array.from({ length: 6 }, (_, i) => png(`n${i}.png`));
  await page.getByLabel("상품 이미지 파일").setInputFiles(six);
  await expect(page.getByTestId("product-image")).toHaveCount(5);
  await expect(page.getByRole("alert").filter({ hasText: "이미지는 5장까지 올릴 수 있습니다. 더 넣으려면 기존 이미지를 지우거나 바꿔 주십시오" })).toBeVisible();
  // 5장이 다 차면 올릴 빈 칸이 없다
  await expect(page.getByRole("button", { name: /^이미지 \d+ 올리기$/ })).toHaveCount(0);
  await expect(page.getByText("5 / 5")).toBeVisible();
});

test("서버도 상품 이미지는 5장까지: 6번째 올리기는 400 image_limit로 거절한다", async ({ page }) => {
  await openNew(page);
  const hdr = { Origin: new URL(page.url()).origin };
  const made = await page.request.post("/api/seller/products", { data: { name: track(`이미지한도 ${RUN}`), price: 5000, status: "DRAFT", options: [{ name: "기본", priceDelta: 0, stock: 1, sortOrder: 0 }] }, headers: hdr });
  expect(made.status()).toBe(201);
  const { id } = (await made.json()) as { id: string };
  for (let i = 0; i < 5; i++) {
    const up = await page.request.post(`/api/seller/products/${id}/images`, { data: await pngBytes(page, 150 + i, "#4a7bd9"), headers: hdr });
    expect(up.status()).toBe(201);
  }
  const sixth = await page.request.post(`/api/seller/products/${id}/images`, { data: await pngBytes(page, 160, "#d9884a"), headers: hdr });
  expect(sixth.status()).toBe(400);
  expect(((await sixth.json()) as { error: string }).error).toBe("image_limit");
  // 수정 화면도 5장이 다 찬 상태로 열리고 더 올릴 칸이 없다
  await page.goto(`/seller/products/${id}`);
  await expect(page.getByTestId("product-image")).toHaveCount(5);
  await expect(page.getByRole("button", { name: /^이미지 \d+ 올리기$/ })).toHaveCount(0);
});

test("상세 설명 에디터: 제목·글 꾸미기·표·구분선을 쓰고 미리보기로 본다, 글자 수가 보인다", async ({ page }) => {
  await openNew(page);
  const body = page.getByRole("textbox", { name: "상세 설명 본문" });
  await body.click();
  await page.getByLabel("글 모양").selectOption("h1");
  await page.keyboard.type("스타라이트 첫 번째 박스");
  await page.keyboard.press("Enter");
  await page.getByLabel("글 모양").selectOption("p");
  await page.getByRole("button", { name: "굵게" }).click();
  await page.keyboard.type("방송 중 개봉");
  await page.getByRole("button", { name: "굵게" }).click();
  await page.keyboard.type("은 닉네임이 나옵니다.");
  await expect(body.locator("h1")).toHaveText("스타라이트 첫 번째 박스");
  await expect(body.locator("strong")).toHaveText("방송 중 개봉");
  // 글자색: 고른 색이 span 스타일로 들어간다
  await body.locator("p").last().click();
  await page.keyboard.press("Control+A");
  await page.getByRole("button", { name: "글자색" }).click();
  await page.getByRole("button", { name: "글자색 #d92d20" }).click();
  await expect(body.locator("span[style*=color]").first()).toBeVisible();
  // 선택을 풀고 글 끝으로(선택한 채로 표를 넣으면 선택한 글이 표로 바뀐다)
  await page.keyboard.press("Control+End");
  // 표 넣기 창: 줄·칸·제목 줄
  await page.getByRole("button", { name: "표 넣기", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "표 넣기" });
  await dlg.getByRole("textbox", { name: "줄" }).fill("2");
  await dlg.getByRole("textbox", { name: "칸" }).fill("3");
  await dlg.getByRole("button", { name: "표 넣기" }).click();
  await expect(body.locator("table tr")).toHaveCount(2);
  await expect(body.locator("table th")).toHaveCount(3);
  await page.getByRole("button", { name: "구분선" }).click();
  await expect(body.locator("hr")).toHaveCount(1);
  await expect(page.getByText(/글자 \d+ \/ 20,000자/)).toBeVisible();
  // 미리보기
  await page.getByRole("button", { name: "미리보기", exact: true }).click();
  const pv = page.getByTestId("detail-preview");
  await expect(pv.locator("h1")).toHaveText("스타라이트 첫 번째 박스");
  await expect(pv.locator("table")).toHaveCount(1);
  await page.getByRole("dialog", { name: "상세 페이지 · 미리보기" }).getByRole("button", { name: "닫기", exact: true }).first().click();
  // 링크: http(s)만
  await body.locator("p").first().click();
  await page.getByRole("button", { name: "링크", exact: true }).click();
  await page.getByLabel("링크 주소").fill("javascript:alert(1)");
  await page.getByRole("button", { name: "적용" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "http · https · mailto · tel 주소만" })).toBeVisible();
  // 이미지: 5MB 넘으면 넣지 않고 이유를 알려 준다
  await page.getByLabel("상세 이미지 파일").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(page.getByRole("alert").filter({ hasText: "5MB를 넘습니다" })).toBeVisible();
});

test("빈 칸은 5칸 중 올리지 않은 만큼 번호로 보이고, 첫 빈 칸이 「이미지 올리기 N / 5」다", async ({ page }) => {
  await openNew(page);
  await expect(page.locator(".pm-add")).toHaveCount(5);
  await expect(page.locator(".pm-add.is-first")).toContainText("이미지 올리기");
  await expect(page.locator(".pm-add.is-first")).toContainText("1 / 5");
  await page.getByLabel("상품 이미지 파일").setInputFiles(png("a.png"));
  await expect(page.locator(".pm-add")).toHaveCount(4);
  await expect(page.locator(".pm-add.is-first")).toContainText("2 / 5");
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
  // b를 맨 앞으로 옮기고, 썸네일은 a(두 번째)로 지정
  await page.getByTestId("product-image").nth(1).getByRole("button", { name: "이미지 2 앞으로" }).click({ force: true });
  await page.getByRole("button", { name: "썸네일로 지정" }).click();
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page.getByText("상품을 등록했습니다")).toBeVisible();
  const found = await page.request.get(`/api/seller/products?q=${encodeURIComponent(name)}`);
  const item = ((await found.json()) as { products: { id: string; thumbnailUrl: string | null }[] }).products[0]!;
  expect(await widths(page, item.id)).toEqual([300, 200]);
  expect(item.thumbnailUrl).toBeTruthy();
  // 지정한 썸네일(200)이 저장되어 서버가 그 이미지에 isThumbnail을 준다
  const saved = (await (await page.request.get(`/api/seller/products/${item.id}/images`)).json()) as { images: { width: number; isThumbnail: boolean }[] };
  expect(saved.images.filter((i) => i.isThumbnail).map((i) => i.width)).toEqual([200]);
  // 목록: 검색해서 대표 이미지가 보인다
  await page.getByLabel("상품 검색").fill(name);
  await page.getByRole("search", { name: "목록 조건" }).getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByTestId("product-row").first().getByTestId("product-thumb")).toBeVisible();
  // 수정 화면: 같은 순서로 2장
  await page.goto(`/seller/products/${item.id}`);
  const tiles = page.getByTestId("product-image");
  await expect(tiles).toHaveCount(2);
  await expect(page.getByText("2 / 5")).toBeVisible();
  const first = await tiles.nth(0).locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth);
  expect(first).toBe(300);
  // 수정 화면에서도 지정한 썸네일(두 번째)이 표시된다
  await expect(tiles.nth(1)).toHaveClass(/is-thumb/);
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

test("상세 설명 저장: 글·이미지·표가 저장되고, 수정에서 이미지를 지우면 서버의 상세 사진도 지워지며, 허용하지 않는 코드는 서버가 지운다", async ({ page }) => {
  await openNew(page);
  const name = track(`상세상품 ${RUN}`);
  await page.getByLabel("상품명").fill(name);
  await page.getByLabel("판매가").fill("7000");
  await page.getByLabel("옵션 1 재고").fill("2");
  const body = page.getByRole("textbox", { name: "상세 설명 본문" });
  await body.click();
  await page.keyboard.type("첫 글");
  await page.getByLabel("상세 이미지 파일").setInputFiles({ name: "d.png", mimeType: "image/png", buffer: await pngBytes(page, 250, "#8a5ad9") });
  await expect(body.locator("img")).toHaveCount(1);
  // 사진이 선택된 채로 표를 넣으면 사진이 바뀌므로 글 끝으로 옮긴 뒤 넣는다
  await body.locator("p").first().click();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "표 넣기", exact: true }).click();
  await page.getByRole("dialog", { name: "표 넣기" }).getByRole("button", { name: "표 넣기" }).click();
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page.getByText("상품을 등록했습니다")).toBeVisible();
  const found = await page.request.get(`/api/seller/products?q=${encodeURIComponent(name)}`);
  const id = ((await found.json()) as { products: { id: string }[] }).products[0]!.id;
  type Detail = { html: string | null; images: { id: string; width: number }[] };
  const read = async () => (await (await page.request.get(`/api/seller/products/${id}/detail`)).json()) as Detail;
  const d1 = await read();
  expect(d1.html).toContain("첫 글");
  expect(d1.html).toContain("<table");
  expect(d1.html).toMatch(/<img src="\/api\/seller\/products\/[0-9a-f-]{36}\/images\/[0-9a-f-]{36}/);
  expect(d1.html).not.toContain("blob:");
  expect(d1.images).toHaveLength(1);
  expect(d1.images[0]!.width).toBe(250);
  // 수정: 이미지를 지우고 글을 바꿔 저장하면 서버의 상세 사진도 지워진다
  await page.goto(`/seller/products/${id}`);
  const edit = page.getByRole("textbox", { name: "상세 설명 본문" });
  await expect(edit.locator("img")).toHaveCount(1);
  await edit.locator("img").click();
  await page.keyboard.press("Backspace");
  await expect(edit.locator("img")).toHaveCount(0);
  await edit.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" 바뀐");
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했습니다")).toBeVisible();
  const d2 = await read();
  expect(d2.html).toContain("첫 글 바뀐");
  expect(d2.html).not.toContain("<img");
  expect(d2.images).toHaveLength(0);
});

test("상세 설명 저장: 허용하지 않는 코드(스크립트 등)를 API로 보내면 서버가 지우고, 지운 곳 수를 알려 준다", async ({ page }) => {
  await openNew(page);
  const hdr = { Origin: new URL(page.url()).origin };
  const made = await page.request.post("/api/seller/products", { data: { name: track(`정화상품 ${RUN}`), price: 5000, status: "DRAFT", options: [{ name: "기본", priceDelta: 0, stock: 1, sortOrder: 0 }] }, headers: hdr });
  const { id } = (await made.json()) as { id: string };
  const put = await page.request.put(`/api/seller/products/${id}/detail`, { data: { html: '<p onclick="x()">본문</p><script>alert(1)</script><p style="color:#d92d20">빨강</p>' }, headers: hdr });
  expect(put.status()).toBe(200);
  const out = (await put.json()) as { html: string; sanitized: { removedCount: number } };
  expect(out.html).not.toContain("script");
  expect(out.html).not.toContain("onclick");
  expect(out.html).toContain("color:#d92d20");
  expect(out.sanitized.removedCount).toBeGreaterThan(0);
});
