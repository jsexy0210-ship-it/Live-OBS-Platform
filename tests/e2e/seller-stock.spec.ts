import { expect, test, type Page } from "@playwright/test";
import { RUN, cleanupProducts, track } from "./cleanup";

// SA-014 재고 관리: 한 번에 적용, 빼기·더하기(사유), 그사이 바뀐 재고는 덮어쓰지 않음, 걸러 보기, 권한, 390.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});
// 이 파일에서 만든 상품은 끝나면 지운다(같은 DB에서 여러 번 돌려도 쌓이지 않게)
test.afterAll(() => cleanupProducts(PASSWORD));

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function openAs(page: Page, email = "demo-owner@example.com") {
  await page.goto("/seller/login?next=%2Fseller%2Fproducts%2Fstock");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/products\/stock$/);
}

// 가짜 상품(옵션 1개씩, 재고 10). 적용은 하지 않는 화면 확인용
const fakeProducts = (prefix: string, n: number, base: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(base + i).padStart(12, "0")}`,
    name: `${prefix} ${i + 1}`,
    price: 1000,
    status: "ON_SALE",
    stockDeductMode: "ON_PAYMENT",
    options: [{ id: `10000000-0000-4000-8000-${String(base + i).padStart(12, "0")}`, name: "기본", stock: 10, sortOrder: 0 }],
  }));
// 상품·옵션 목록 응답을 가짜로 바꾼다. 서버처럼 q(상품·옵션 이름, 대소문자 무시)와 stock(옵션마다 out=0, low=1~5)으로 거르고,
// 상품 목록은 상품 200개씩, 옵션 목록(GET /api/seller/products/options)은 옵션 200개씩 cursor로 나눠 돌려준다
async function routeFakeProducts(page: Page, products: ReturnType<typeof fakeProducts>) {
  const match = (q: string, name: string) => !q || name.toLowerCase().includes(q);
  await page.route("**/api/seller/products?limit=200**", (route) => {
    const url = new URL(route.request().url());
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const list = products.filter((p) => match(q, p.name) || p.options.some((o) => match(q, o.name)));
    const from = Number(url.searchParams.get("cursor")?.replace("e2e-p", "") ?? 0) || 0;
    const pageList = list.slice(from, from + 200);
    return route.fulfill({ json: { products: pageList, nextCursor: from + 200 < list.length ? `e2e-p${from + 200}` : null } });
  });
  await page.route("**/api/seller/products/options?**", (route) => {
    const url = new URL(route.request().url());
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const stock = url.searchParams.get("stock");
    const rows = products.flatMap((p) =>
      p.options
        .filter((o) => match(q, p.name) || match(q, o.name))
        .filter((o) => (stock === "out" ? o.stock === 0 : stock === "low" ? o.stock >= 1 && o.stock <= 5 : true))
        .map((o) => ({ productId: p.id, productName: p.name, productStatus: p.status, optionId: o.id, optionName: o.name, sku: null, stock: o.stock })),
    );
    const from = Number(url.searchParams.get("cursor")?.replace("e2e-o", "") ?? 0) || 0;
    return route.fulfill({ json: { options: rows.slice(from, from + 200), nextCursor: from + 200 < rows.length ? `e2e-o${from + 200}` : null } });
  });
}

const nextInput = (page: Page, label: string) => page.getByLabel(`${label} 변경 후 재고`);
const row = (page: Page, text: string) => page.getByTestId("stock-row").filter({ hasText: text });

// 확인 창에서 사유를 고르고 적용한다(사유는 재고 이력에 남는다). 사유 없이는 적용 버튼이 꺼져 있다
async function confirmApply(page: Page, reason = "재고 조사") {
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "적용", exact: true })).toBeDisabled();
  await dialog.getByRole("radio", { name: reason }).click();
  await dialog.getByRole("button", { name: "적용", exact: true }).click();
}

async function applyAll(page: Page, reason?: string) {
  await page.getByRole("button", { name: /^변경 \d+건 적용$/ }).last().click();
  await confirmApply(page, reason);
}

test("변경 후 재고를 적고 한 번에 적용하면 반영된다", async ({ page }) => {
  await openAs(page);
  await nextInput(page, "탑로더 25장 1팩").fill("20");
  await nextInput(page, "문라이트 컬렉션 박스 1박스").fill("9");
  await expect(page.getByTestId("sum-count")).toHaveText("2개");
  await expect(row(page, "탑로더 25장")).toContainText("+17");
  await shot(page, "SA-014-stock");
  await applyAll(page);
  await expect(page.getByText("재고 2건을 바꿨어요")).toBeVisible();
  await expect(row(page, "탑로더 25장").locator(".c-cur")).toContainText("20");
  await page.reload();
  await expect(nextInput(page, "문라이트 컬렉션 박스 1박스")).toHaveValue("9");

  // 되돌려 둔다
  await nextInput(page, "탑로더 25장 1팩").fill("3");
  await nextInput(page, "문라이트 컬렉션 박스 1박스").fill("5");
  await applyAll(page);
  await expect(page.getByText("재고 2건을 바꿨어요")).toBeVisible();
});

test("빼기·더하기: 사유와 함께 바꾸고, 남은 재고보다 많이 뺄 수 없다", async ({ page }) => {
  await openAs(page);
  const label = "스타라이트 부스터 박스 1박스 (36팩)";
  const before = Number((await nextInput(page, label).inputValue()).replace(/,/g, ""));
  await page.getByRole("button", { name: `${label} 빼기 · 더하기` }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("수량").fill(String(before + 1));
  await expect(sheet.getByText(`남은 재고보다 많이 뺄 수 없어요 · 지금 ${before}개`)).toBeVisible();
  await sheet.getByRole("radio", { name: "이벤트 증정" }).click();
  await expect(sheet.getByRole("button", { name: `${before + 1}개 빼기` })).toBeDisabled();
  await sheet.getByLabel("수량").fill("3");
  await shot(page, "SA-014-stock-sheet");
  await sheet.getByRole("button", { name: "3개 빼기" }).click();
  await expect(page.getByText(`스타라이트 부스터 박스 재고 3개를 뺐어요 · 남은 재고 ${before - 3}`)).toBeVisible();
  await expect(nextInput(page, label)).toHaveValue(String(before - 3));

  await page.getByRole("button", { name: `${label} 빼기 · 더하기` }).click();
  await sheet.getByRole("radio", { name: "더하기" }).click();
  await sheet.getByLabel("수량").fill("3");
  await sheet.getByRole("radio", { name: "직접 입력" }).click();
  await expect(sheet.getByRole("button", { name: "3개 더하기" })).toBeDisabled();
  await sheet.getByLabel("사유 메모").fill("추가 입고");
  await sheet.getByRole("button", { name: "3개 더하기" }).click();
  await expect(page.getByText(`스타라이트 부스터 박스 재고 3개를 더했어요 · 남은 재고 ${before}`)).toBeVisible();
  await page.reload();
  await expect(nextInput(page, label)).toHaveValue(String(before));
});

test("그사이 재고가 바뀐 옵션은 덮어쓰지 않고 알려 준다", async ({ page }) => {
  await openAs(page);
  const label = "탑로더 25장 1팩";
  await nextInput(page, label).fill("50");
  // 화면을 띄워 둔 사이 다른 곳(주문·다른 직원)에서 재고가 1개 줄었다고 가정한다
  const r = await page.evaluate(async () => {
    const list = await (await fetch("/api/seller/products?limit=200")).json();
    const p = list.products.find((x: { name: string }) => x.name === "탑로더 25장");
    const o = p.options[0];
    const res = await fetch(`/api/seller/products/${p.id}/options/${o.id}/stock-adjust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delta: -1, reason: "e2e 동시 변경" }),
    });
    return { status: res.status, before: o.stock };
  });
  expect(r.status).toBe(200);
  await applyAll(page);
  await expect(page.getByText(/그사이 주문 등으로 재고가 바뀌어 1건은 바꾸지 않았어요/)).toBeVisible();
  await expect(nextInput(page, label)).toHaveValue(String(r.before - 1));

  // 되돌려 둔다
  await nextInput(page, label).fill(String(r.before));
  await applyAll(page);
  await expect(page.getByText("재고 1건을 바꿨어요")).toBeVisible();
});

test("검색·품절·재고 적은 순으로 걸러 보고, 잘못된 값은 빼고 적용한다", async ({ page }) => {
  await openAs(page);
  await page.getByRole("button", { name: "품절", exact: true }).click();
  await expect(row(page, "드래곤 소울 부스터")).toBeVisible();
  await expect(row(page, "스타라이트 부스터 박스")).toHaveCount(0);
  await page.getByRole("button", { name: "품절", exact: true }).click();
  await page.getByLabel("재고 검색").fill("바인더");
  await expect(page.getByTestId("stock-row")).toHaveCount(4);
  await nextInput(page, "보관용 카드 바인더 4포켓 바인더 (네이비 · 톱 로딩 · 160장 수납)").fill("-1");
  await expect(page.getByText("고칠 칸이 1개 있어요. 그 칸은 빼고 적용해요")).toBeVisible();
  await expect(page.getByRole("button", { name: "변경 0건 적용" }).first()).toBeDisabled();
  await page.getByLabel("재고 검색").fill("없는상품이름");
  await expect(page.getByText("「없는상품이름」에 해당하는 상품이 없어요")).toBeVisible();
});

test("상품 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await openAs(page, "demo-viewer@example.com");
  await expect(page.getByText("필요한 권한: 상품")).toBeVisible();
  await expect(page.getByTestId("stock-row")).toHaveCount(0);
});

test("390에서는 옵션이 카드처럼 쌓이고 가로로 넘치지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page);
  await expect(page.getByTestId("stock-row").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole("button", { name: "스타라이트 부스터 박스 1박스 (36팩) 빼기 · 더하기" })).toBeVisible();
});

test("상품 재고 차감 기준을 정하고 바꿀 수 있다(주문하면 바로 차감 ↔ 결제하면 차감)", async ({ page }) => {
  const name = track(`e2e ${RUN} 차감 기준`);
  await page.goto("/seller/login?next=%2Fseller%2Fproducts%2Fnew");
  await page.getByLabel("이메일").fill("demo-owner@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/products\/new$/);
  await expect(page.getByRole("radio", { name: "결제하면 차감" })).toHaveAttribute("aria-checked", "true");
  await page.getByLabel("상품명").fill(name);
  await page.getByLabel("판매가").fill("5000");
  await page.getByRole("radio", { name: "주문하면 바로 차감" }).click();
  await page.getByRole("button", { name: "등록", exact: true }).first().click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  // 만든 상품은 첫 쪽 목록에 기대지 않고 이름 검색(서버 q)으로 찾는다
  await page.getByLabel("상품 검색").fill(name);
  await expect(page.getByTestId("product-row")).toHaveCount(1);
  await page.getByTestId("product-row").filter({ hasText: name }).getByRole("link").first().click();
  await expect(page.getByRole("radio", { name: "주문하면 바로 차감" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("radio", { name: "결제하면 차감" }).click();
  await page.getByRole("button", { name: "저장", exact: true }).first().click();
  await expect(page.getByText("저장했어요", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: "결제하면 차감" })).toHaveAttribute("aria-checked", "true");
});

test("로그인이 풀린 뒤 재고를 바꾸면 로그인으로 보낸다", async ({ page }) => {
  await openAs(page);
  // 첫 화면 데이터(상품·재고 이력)를 다 받은 뒤 로그인을 끊는다. 이력 요청이 남아 있으면 그 401로 먼저 로그인 화면으로 가 버린다
  await expect(page.getByTestId("stock-row").first()).toBeVisible();
  await expect(page.getByTestId("history-item").first().or(page.getByText("아직 재고를 바꾼 기록이 없어요"))).toBeVisible();
  await expect(page.getByTestId("stock-loading-more")).toHaveCount(0);
  await page.context().clearCookies();
  await page.getByRole("button", { name: "탑로더 25장 1팩 빼기 · 더하기" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("수량").fill("1");
  await sheet.getByRole("radio", { name: "서비스" }).click();
  await sheet.getByRole("button", { name: "1개 빼기" }).click();
  await expect(page).toHaveURL(/\/seller\/login\?next=%2Fseller%2Fproducts%2Fstock$/);
});

test("체크한 옵션에 「+10」처럼 적으면 한꺼번에 더해 적어 준다", async ({ page }) => {
  await openAs(page);
  await page.getByLabel("재고 검색").fill("카드 슬리브");
  await expect(page.getByTestId("stock-row")).toHaveCount(2);
  const before = await Promise.all(["카드 슬리브 100매 투명", "카드 슬리브 100매 블랙"].map((l) => nextInput(page, l).inputValue()));
  await page.getByLabel("보이는 옵션 모두 선택").check();
  await page.getByLabel("선택한 옵션에 더하거나 뺄 수량").fill("+10");
  await page.getByRole("button", { name: "한꺼번에 적기" }).click();
  await expect(nextInput(page, "카드 슬리브 100매 투명")).toHaveValue(String(Number(before[0]) + 10));
  await expect(nextInput(page, "카드 슬리브 100매 블랙")).toHaveValue(String(Number(before[1]) + 10));
  await expect(page.getByTestId("sum-count")).toHaveText("2개");
});

test("상품명·옵션명은 2줄까지 보이고, 전체 이름은 마우스를 올리면 보인다", async ({ page }) => {
  await openAs(page);
  const name = "12포켓 대용량 바인더 (그레이 · 480장 수납 · 손잡이 달린 하드 케이스)";
  const cell = row(page, "12포켓 대용량").locator(".c-name .clamp2").nth(1);
  await expect(cell).toHaveAttribute("title", name);
  expect(await cell.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("2");
});

test("재고 차감 기준 안내는 주문 설정의 「취소·반품하면 재고 되돌리기」를 따른다", async ({ page }) => {
  // 대표자: 주문 설정을 읽을 수 있어서 지금 상태(기본 켜짐)를 알려 준다
  await page.goto("/seller/login?next=%2Fseller%2Fproducts%2Fnew");
  await page.getByLabel("이메일").fill("demo-owner@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  // 서버와 같이: 취소·발송 전 환불은 돌아오고, 발송 뒤 환불·개봉 상품은 돌아오지 않는다
  await expect(page.getByText("주문 취소·발송 전 환불이면 재고가 돌아와요(주문 설정에서 켜져 있어요)", { exact: false })).toBeVisible();
  await expect(page.getByText("발송 뒤 환불이나 개봉한 상품은 돌아오지 않아요", { exact: false })).toBeVisible();
  await expect(page.getByText("미입금으로 취소되면", { exact: false })).toHaveCount(0);
});

test("상품 담당 직원(쇼핑몰 설정 권한 없음)은 설정 이름으로 안내받는다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fproducts%2Fnew");
  await page.getByLabel("이메일").fill("demo-staff@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("주문 설정의 「취소·반품하면 재고 되돌리기」를 따라요", { exact: false })).toBeVisible();
});

test("390에서는 「모두 선택」이 있고, 바꾸면 아래 고정 바에서 적용한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page);
  await expect(page.getByTestId("stock-mbar")).toHaveCount(0);
  await page.getByLabel("재고 검색").fill("탑로더");
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await page.getByLabel("모두 선택", { exact: true }).check();
  await page.getByLabel("선택한 옵션에 더하거나 뺄 수량").fill("+2");
  await page.getByRole("button", { name: "한꺼번에 적기" }).click();
  const bar = page.getByTestId("stock-mbar");
  await expect(bar).toBeInViewport();
  await expect(bar).toContainText("바꿀 옵션 1개");
  await bar.getByRole("button", { name: "변경 1건 적용" }).click();
  await confirmApply(page);
  await expect(page.getByText("재고 1건을 바꿨어요")).toBeVisible();
  await expect(bar).toHaveCount(0);
  // 되돌려 둔다
  await nextInput(page, "탑로더 25장 1팩").fill(String(Number(await row(page, "탑로더 25장").locator(".c-cur").innerText().then((t) => t.replace(/\D/g, ""))) - 2));
  await page.getByTestId("stock-mbar").getByRole("button", { name: "변경 1건 적용" }).click();
  await confirmApply(page);
  await expect(page.getByText("재고 1건을 바꿨어요")).toBeVisible();
});

test("재고 이력: 빼기·한 번에 적용이 사유·처리자·남은 재고와 함께 최근 것부터 남는다", async ({ page }) => {
  await openAs(page);
  const label = "탑로더 25장 1팩";
  const before = Number(await row(page, "탑로더 25장").locator(".c-cur").innerText().then((t) => t.replace(/\D/g, "")));
  // 1) 빼기 시트(이벤트 증정)
  await page.getByRole("button", { name: `${label} 빼기 · 더하기` }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("수량").fill("1");
  await sheet.getByRole("radio", { name: "이벤트 증정" }).click();
  await sheet.getByRole("button", { name: "1개 빼기" }).click();
  const first = page.getByTestId("history-item").first();
  await expect(first).toContainText("직접 변경");
  await expect(first).toContainText("탑로더 25장 · 1팩");
  await expect(first).toContainText("사유: 이벤트 증정");
  await expect(first).toContainText("대표자");
  await expect(first).toContainText(`남은 재고 ${before - 1}`);
  await expect(first).toContainText("−1");
  // 2) 한 번에 적용(입고) — 원래대로 되돌리며 사유가 남는지 본다
  await nextInput(page, label).fill(String(before));
  await applyAll(page, "입고");
  await expect(page.getByText("재고 1건을 바꿨어요")).toBeVisible();
  await expect(page.getByTestId("history-item").first()).toContainText("사유: 입고");
  await expect(page.getByTestId("history-item").first()).toContainText("+1");
  await expect(page.getByTestId("history-item").first()).toContainText(`남은 재고 ${before}`);
});

// 빼기 시트로 1개 빼고, 맨 위 이력이 방금 남긴 것인지 본다(재고는 테스트 끝에 되돌린다)
async function takeOne(page: Page, label: string, reason = "서비스") {
  await page.getByRole("button", { name: `${label} 빼기 · 더하기` }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("수량").fill("1");
  await sheet.getByRole("radio", { name: reason }).click();
  await sheet.getByRole("button", { name: "1개 빼기" }).click();
}

async function putBack(page: Page, label: string, stock: number) {
  await nextInput(page, label).fill(String(stock));
  await applyAll(page);
  await expect(page.getByText("재고 1건을 바꿨어요")).toBeVisible();
}

test("재고 이력: 늦게 온 옛 첫 쪽 응답이 방금 남긴 이력을 덮지 않는다", async ({ page }) => {
  let delayed = false;
  await page.route("**/api/seller/products/stock-movements**", async (route) => {
    // 화면을 열 때 부르는 첫 쪽만 늦게 돌려준다
    if (!delayed) {
      delayed = true;
      const res = await route.fetch();
      await new Promise((r) => setTimeout(r, 3000));
      return route.fulfill({ response: res });
    }
    return route.continue();
  });
  await openAs(page);
  const label = "탑로더 25장 1팩";
  const before = Number(await row(page, "탑로더 25장").locator(".c-cur").innerText().then((t) => t.replace(/\D/g, "")));
  await takeOne(page, label, "서비스");
  await expect(page.getByTestId("history-item").first()).toContainText(`남은 재고 ${before - 1}`);
  // 옛 응답이 도착할 때까지 기다려도 맨 위는 그대로
  await page.waitForTimeout(3500);
  await expect(page.getByTestId("history-item").first()).toContainText(`남은 재고 ${before - 1}`);
  await expect(page.getByTestId("history-item").first()).toContainText("사유: 서비스");
  await putBack(page, label, before);
});

test("재고 이력: 「이력 더 보기」 응답이 늦게 와도 새로 불러온 목록 뒤에 붙지 않는다", async ({ page }) => {
  let first = true;
  await page.route("**/api/seller/products/stock-movements**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("cursor") === "e2e-stale") {
      // 옛 커서로 부른 다음 쪽: 늦게, 알아보기 쉬운 가짜 이력으로 돌려준다
      await new Promise((r) => setTimeout(r, 3000));
      return route.fulfill({
        json: {
          movements: [
            { id: "e2e-stale-1", productId: "x", optionId: "x", productName: "늦게 온 옛 이력", optionName: "옛 쪽", delta: 1, stockAfter: null, type: "MANUAL", typeLabel: "직접 변경", note: null, actor: { name: "대표자" }, createdAt: new Date().toISOString(), orderId: null },
          ],
          nextCursor: null,
        },
      });
    }
    if (first) {
      // 처음 첫 쪽에만 다음 쪽이 있는 것처럼 커서를 붙인다
      first = false;
      const res = await route.fetch();
      const body = await res.json();
      return route.fulfill({ response: res, json: { ...body, nextCursor: "e2e-stale" } });
    }
    return route.continue();
  });
  await openAs(page);
  const label = "탑로더 25장 1팩";
  const before = Number(await row(page, "탑로더 25장").locator(".c-cur").innerText().then((t) => t.replace(/\D/g, "")));
  await expect(page.getByTestId("history-item").first()).toBeVisible();
  await page.getByRole("button", { name: "이력 더 보기" }).click();
  // 다음 쪽을 기다리는 사이 재고를 바꾸면 이력을 첫 쪽부터 다시 불러온다
  await takeOne(page, label, "서비스");
  await expect(page.getByTestId("history-item").first()).toContainText(`남은 재고 ${before - 1}`);
  await page.waitForTimeout(3500);
  await expect(page.getByTestId("stock-history")).not.toContainText("늦게 온 옛 이력");
  await expect(page.getByTestId("history-item").first()).toContainText(`남은 재고 ${before - 1}`);
  await putBack(page, label, before);
});

test("상품명·옵션명은 숫자·단어 중간에서 줄을 바꾸지 않는다(「3 / 60장」)", async ({ page }) => {
  await openAs(page);
  const name = row(page, "탑로더 25장").locator(".c-name .clamp2").first();
  const style = await name.evaluate((el) => ({ wb: getComputedStyle(el).wordBreak, ow: getComputedStyle(el).overflowWrap }));
  expect(style).toEqual({ wb: "keep-all", ow: "anywhere" });
  const hist = page.getByTestId("history-item").first().locator(".clamp2");
  expect(await hist.evaluate((el) => getComputedStyle(el).wordBreak)).toBe("keep-all");
});

test("390: 아래 고정 적용 바가 맨 아래 「이력 더 보기」를 가리지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // 다음 쪽이 있는 것처럼 커서를 붙여 「이력 더 보기」를 보이게 한다
  await page.route("**/api/seller/products/stock-movements**", async (route) => {
    const res = await route.fetch();
    return route.fulfill({ response: res, json: { ...(await res.json()), nextCursor: "e2e-more" } });
  });
  await openAs(page);
  await nextInput(page, "탑로더 25장 1팩").fill("99");
  await expect(page.getByTestId("stock-mbar")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const more = page.getByRole("button", { name: "이력 더 보기" });
  await expect(more).toBeVisible();
  const btn = (await more.boundingBox())!;
  const bar = (await page.getByTestId("stock-mbar").boundingBox())!;
  expect(btn.y + btn.height).toBeLessThanOrEqual(bar.y);
});

test("「이력 더 보기」가 실패하면 지금 목록은 두고 그 자리에서 다시 불러온다", async ({ page }) => {
  let failOnce = true;
  let firstCount = 0;
  await page.route("**/api/seller/products/stock-movements**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("cursor") === "e2e-next") {
      if (failOnce) {
        failOnce = false;
        return route.fulfill({ status: 500, json: { error: "internal" } });
      }
      return route.fulfill({
        json: {
          movements: [{ id: "e2e-next-1", productName: "다음 쪽 이력", optionName: "옵션", delta: 1, stockAfter: null, type: "MANUAL", typeLabel: "직접 변경", note: null, actor: { name: "대표자" }, createdAt: new Date().toISOString() }],
          nextCursor: null,
        },
      });
    }
    const res = await route.fetch();
    const body = await res.json();
    firstCount = body.movements.length;
    return route.fulfill({ response: res, json: { ...body, nextCursor: "e2e-next" } });
  });
  await openAs(page);
  await expect(page.getByTestId("history-item").first()).toBeVisible();
  await page.getByRole("button", { name: "이력 더 보기" }).click();
  await expect(page.getByText("이력을 더 불러오지 못했어요")).toBeVisible();
  // 목록은 그대로, 전체 오류 화면으로 바뀌지 않는다
  await expect(page.getByTestId("history-item")).toHaveCount(firstCount);
  await expect(page.getByText("재고 이력을 불러오지 못했어요")).toHaveCount(0);
  await page.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(page.getByTestId("history-item")).toHaveCount(firstCount + 1);
  await expect(page.getByTestId("history-item").last()).toContainText("다음 쪽 이력");
  await expect(page.getByRole("button", { name: "이력 더 보기" })).toHaveCount(0);
});

test("올해가 아닌 이력은 연도를 붙여 보여 준다", async ({ page }) => {
  await page.route("**/api/seller/products/stock-movements**", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const old = { id: "e2e-old", productName: "작년 이력", optionName: "옵션", delta: -1, stockAfter: 4, type: "MANUAL", typeLabel: "직접 변경", note: "재고 조사", actor: { name: "대표자" }, createdAt: "2024-12-31T03:00:00Z" };
    return route.fulfill({ response: res, json: { movements: [...body.movements, old], nextCursor: null } });
  });
  await openAs(page);
  await expect(page.getByTestId("history-item").first()).not.toContainText("2024");
  await expect(page.getByTestId("history-item").filter({ hasText: "작년 이력" })).toContainText("2024. 12. 31. 12:00");
});

test("직접 쓴 사유는 서버와 같은 기준(코드포인트 100자)으로 검사한다", async ({ page }) => {
  await openAs(page);
  await page.getByRole("button", { name: "탑로더 25장 1팩 빼기 · 더하기" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("수량").fill("1");
  await sheet.getByRole("radio", { name: "직접 입력" }).click();
  // 두 칸짜리 글자 100개(UTF-16 200칸)는 100자로 센다
  await sheet.getByLabel("사유 메모").fill("𠀀".repeat(100));
  await expect(sheet.getByText("사유는 100자까지 쓸 수 있어요")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "1개 빼기" })).toBeEnabled();
  await sheet.getByLabel("사유 메모").fill("𠀀".repeat(101));
  await expect(sheet.getByText("사유는 100자까지 쓸 수 있어요")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "1개 빼기" })).toBeDisabled();
  await sheet.getByRole("button", { name: "취소" }).click();
  // 한 번에 적용 확인 창도 같은 기준
  await nextInput(page, "탑로더 25장 1팩").fill("99");
  await page.getByRole("button", { name: /^변경 \d+건 적용$/ }).last().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "직접 입력" }).click();
  await dialog.getByLabel("사유 메모").fill("𠀀".repeat(101));
  await expect(dialog.getByText("사유는 100자까지 쓸 수 있어요")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "적용", exact: true })).toBeDisabled();
  await dialog.getByLabel("사유 메모").fill("𠀀".repeat(100));
  await expect(dialog.getByRole("button", { name: "적용", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "취소" }).click();
});

test("옵션이 200개를 넘으면 첫 쪽만 불러오고, 「모두 선택」은 불러온 옵션을 모두 고른다", async ({ page }) => {
  // 상품 250개(옵션 1개씩, 가짜 응답). 옵션 목록은 200개씩 온다. 적용은 하지 않는다
  await routeFakeProducts(page, fakeProducts("대량 상품", 250, 0));
  await openAs(page);
  await expect(page.getByTestId("stock-row")).toHaveCount(200);
  await page.getByLabel("보이는 옵션 모두 선택").check();
  await page.getByLabel("선택한 옵션에 더하거나 뺄 수량").fill("+1");
  await page.getByRole("button", { name: "한꺼번에 적기" }).click();
  await expect(page.getByTestId("sum-count")).toHaveText("200개");
  // 더 불러오면 새 줄은 선택되지 않은 채로 붙고, 다시 모두 선택하면 250개 모두 고른다
  await page.getByRole("button", { name: "옵션 더 불러오기" }).click();
  await expect(page.getByTestId("stock-row")).toHaveCount(250);
  await expect(page.getByLabel("보이는 옵션 모두 선택")).not.toBeChecked();
  await page.getByLabel("보이는 옵션 모두 선택").check();
  await page.getByLabel("선택한 옵션에 더하거나 뺄 수량").fill("+1");
  await page.getByRole("button", { name: "한꺼번에 적기" }).click();
  await expect(page.getByTestId("sum-count")).toHaveText("250개");
});

test("모두 선택해 한꺼번에 적은 뒤 검색으로 좁히면 적용 확인 창에 「화면에 안 보이는 n개 포함」이 나온다", async ({ page }) => {
  // 상품 250개(가짜 응답). 확인 창만 열고 적용하지 않는다
  await routeFakeProducts(page, fakeProducts("대량 상품", 250, 0));
  await openAs(page);
  await page.getByRole("button", { name: "옵션 더 불러오기" }).click();
  await expect(page.getByTestId("stock-row")).toHaveCount(250);
  await page.getByLabel("보이는 옵션 모두 선택").check();
  await page.getByLabel("선택한 옵션에 더하거나 뺄 수량").fill("+1");
  await page.getByRole("button", { name: "한꺼번에 적기" }).click();
  await expect(page.getByTestId("sum-count")).toHaveText("250개");
  // 「대량 상품 1」로 좁히면 111개만 보이고, 바꿔 둔 나머지 139개는 화면에 안 보여도 함께 적용된다
  await page.getByLabel("재고 검색").fill("대량 상품 1");
  await expect(page.getByTestId("stock-row")).toHaveCount(111);
  await page.getByRole("button", { name: "변경 250건 적용" }).last().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("apply-hidden")).toHaveText("화면에 안 보이는 139개 포함");
  await dialog.getByRole("button", { name: "취소" }).click();
  // 검색을 지워 모두 보이면 문구도 없다
  await page.getByLabel("재고 검색").fill("");
  await expect(page.getByTestId("stock-row")).toHaveCount(200);
  await page.getByRole("button", { name: "옵션 더 불러오기" }).click();
  await expect(page.getByTestId("stock-row")).toHaveCount(250);
  await page.getByRole("button", { name: "변경 250건 적용" }).last().click();
  await expect(page.getByRole("dialog").getByTestId("apply-hidden")).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();
});

test("행의 「이력」은 그 옵션의 재고 이력만 보여 준다", async ({ page }) => {
  await openAs(page);
  // 1440에서 「이력」·「빼기 · 더하기」 두 버튼이 칸 안에 다 보인다
  const act = row(page, "탑로더 25장").locator(".c-act");
  const cell = (await act.boundingBox())!;
  const adj = (await act.getByRole("button", { name: /빼기 · 더하기/ }).boundingBox())!;
  expect(adj.x + adj.width).toBeLessThanOrEqual(cell.x + cell.width);
  const req = page.waitForRequest((r) => r.url().includes("/stock-movements") && r.url().includes("optionId="));
  await page.getByRole("button", { name: "탑로더 25장 1팩 이력" }).click();
  const url = new URL((await req).url());
  expect(url.searchParams.get("productId")).toBeTruthy();
  expect(url.searchParams.get("optionId")).toBeTruthy();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("history-item").first()).toBeVisible();
  const texts = await dialog.getByTestId("history-item").allInnerTexts();
  expect(texts.length).toBeGreaterThan(0);
  for (const t of texts) expect(t).toContain("탑로더 25장 · 1팩");
  await shot(page, "SA-014-stock-option-history");
  await dialog.getByRole("button", { name: "닫기" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("검색을 바꾸면 이전 선택은 지금 결과와 겹치는 것만 남는다(표시·한꺼번에 적기 대상)", async ({ page }) => {
  // 「가방」 250개 + 「나무」 220개(가짜 응답, 겹치지 않는 이름). 적용은 하지 않는다
  await routeFakeProducts(page, [...fakeProducts("가방", 250, 0), ...fakeProducts("나무", 220, 1000)]);
  await openAs(page);
  // 검색 응답이 온 뒤에 더 불러온다(검색 전 목록도 「가방」으로 시작해서 줄 글자만으로는 알 수 없다)
  const searched = (q: string) => page.waitForResponse((r) => r.url().includes("/api/seller/products/options?") && new URL(r.url()).searchParams.get("q") === q);
  await Promise.all([searched("가방"), page.getByLabel("재고 검색").fill("가방")]);
  await page.getByRole("button", { name: "옵션 더 불러오기" }).click();
  await expect(page.getByTestId("stock-row")).toHaveCount(250);
  await page.getByLabel("보이는 옵션 모두 선택").check();
  // 겹치지 않는 검색으로 바꾸면 이전 선택은 빠진다
  await Promise.all([searched("나무"), page.getByLabel("재고 검색").fill("나무")]);
  await expect(page.getByTestId("stock-row").first()).toContainText("나무");
  await expect(page.getByLabel("보이는 옵션 모두 선택")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "한꺼번에 적기" })).toBeDisabled();
  await page.getByRole("button", { name: "옵션 더 불러오기" }).click();
  await expect(page.getByTestId("stock-row")).toHaveCount(220);
  await page.getByLabel("보이는 옵션 모두 선택").check();
  await page.getByLabel("선택한 옵션에 더하거나 뺄 수량").fill("+1");
  await page.getByRole("button", { name: "한꺼번에 적기" }).click();
  // 바뀐 옵션은 지금 결과 220개뿐(이전 검색의 250개는 그대로)
  await expect(page.getByTestId("sum-count")).toHaveText("220개");
  await page.getByLabel("재고 검색").fill("가방");
  await expect(nextInput(page, "가방 1 기본")).toHaveValue("10");
});

test("검색을 바꿔 다시 모두 선택해 적용하면 이전 검색 결과의 재고는 바뀌지 않는다", async ({ page }) => {
  await openAs(page);
  const cur = async (name: string) => Number((await row(page, name).locator(".c-cur").innerText()).replace(/\D/g, ""));
  const topBefore = await cur("탑로더 25장");
  const moonBefore = await cur("문라이트 컬렉션 박스");
  // 1) 「탑로더」를 모두 선택
  await page.getByLabel("재고 검색").fill("탑로더");
  // 서버 검색 결과가 온 뒤에 고른다(결과가 오기 전에는 모두 선택이 막혀 있다)
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await page.getByLabel("보이는 옵션 모두 선택").check();
  // 2) 겹치지 않는 「문라이트 컬렉션」으로 바꿔 모두 선택하고 +1 적용
  await page.getByLabel("재고 검색").fill("문라이트 컬렉션");
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await expect(page.getByTestId("stock-row").first()).toContainText("문라이트 컬렉션 박스");
  await page.getByLabel("보이는 옵션 모두 선택").check();
  await page.getByLabel("선택한 옵션에 더하거나 뺄 수량").fill("+1");
  await page.getByRole("button", { name: "한꺼번에 적기" }).click();
  await expect(page.getByTestId("sum-count")).toHaveText("1개");
  await applyAll(page);
  await expect(page.getByText("재고 1건을 바꿨어요")).toBeVisible();
  // 3) 서버에서 다시 읽어도 탑로더는 그대로, 문라이트만 +1
  await page.reload();
  await expect(row(page, "문라이트 컬렉션 박스").locator(".c-cur")).toContainText(String(moonBefore + 1));
  expect(await cur("탑로더 25장")).toBe(topBefore);
  // 되돌려 둔다
  await nextInput(page, "문라이트 컬렉션 박스 1박스").fill(String(moonBefore));
  await applyAll(page);
  await expect(page.getByText("재고 1건을 바꿨어요")).toBeVisible();
});

test("390·360 카드형 행: 상태 배지가 잘리지 않고 「이력」·「빼기 · 더하기」 버튼과 겹치지 않는다", async ({ page }) => {
  await openAs(page);
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    const rows = page.getByTestId("stock-row");
    const n = Math.min(await rows.count(), 8);
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i);
      const badge = (await r.locator(".c-state .bdg").boundingBox())!;
      const cell = (await r.locator(".c-state").boundingBox())!;
      // 배지가 칸 밖으로 잘리지 않는다
      expect(badge.x + badge.width, `${width} ${i}행 배지 잘림`).toBeLessThanOrEqual(cell.x + cell.width + 0.5);
      for (const b of await r.locator(".c-act .btn").all()) {
        const bb = (await b.boundingBox())!;
        const overlap = badge.x < bb.x + bb.width && bb.x < badge.x + badge.width && badge.y < bb.y + bb.height && bb.y < badge.y + badge.height;
        expect(overlap, `${width} ${i}행 배지·버튼 겹침`).toBe(false);
      }
    }
  }
});

test("사유 메모는 실제로 보내는 값(앞뒤 공백 뺀 값)으로 검사한다", async ({ page }) => {
  await openAs(page);
  await page.getByRole("button", { name: "탑로더 25장 1팩 빼기 · 더하기" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("수량").fill("1");
  await sheet.getByRole("radio", { name: "직접 입력" }).click();
  // 앞에 붙은 BOM은 보낼 때 빠지므로 막지 않는다
  await sheet.getByLabel("사유 메모").fill("﻿창고 정리");
  await expect(sheet.getByText("쓸 수 없는 글자가 있어요")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "1개 빼기" })).toBeEnabled();
  // 가운데 낀 보이지 않는 글자는 서버도 막으므로 화면에서 막는다
  await sheet.getByLabel("사유 메모").fill("창고\u0007정리");
  await expect(sheet.getByText("쓸 수 없는 글자가 있어요")).toBeVisible();
  await sheet.getByRole("button", { name: "취소" }).click();
});

test("옵션 이력 창 제목은 2줄까지 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page);
  // 데모 상품 중 이름이 가장 긴 것(390에서 제목이 2줄을 넘는다)
  await page.getByRole("button", { name: /^포켓몬 카드 게임.* 이력$/ }).first().click();
  const title = page.getByRole("dialog").locator("#opt-hist-title");
  await expect(title).toBeVisible();
  expect(await title.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("2");
  expect(await title.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(2 * 32);
});

test("한 번에 적용하는 동안 「n/N 적용 중」으로 진행 상황을 보여 준다", async ({ page }) => {
  // 한 건씩 늦게 처리되게 해 진행 표시를 본다(실제로 적용하고 되돌린다)
  await page.route("**/stock-adjust", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    return route.continue();
  });
  await openAs(page);
  const top = Number((await row(page, "탑로더 25장").locator(".c-cur").innerText()).replace(/\D/g, ""));
  const moon = Number((await row(page, "문라이트 컬렉션 박스").locator(".c-cur").innerText()).replace(/\D/g, ""));
  await nextInput(page, "탑로더 25장 1팩").fill(String(top + 1));
  await nextInput(page, "문라이트 컬렉션 박스 1박스").fill(String(moon + 1));
  await applyAll(page);
  await expect(page.getByRole("button", { name: /^[01]\/2 적용 중$/ }).first()).toBeVisible();
  await expect(page.getByText("재고 2건을 바꿨어요")).toBeVisible();
  // 서버에서 다시 읽어 둘 다 +1인지 본다
  await page.reload();
  await expect(nextInput(page, "탑로더 25장 1팩")).toHaveValue(String(top + 1));
  await expect(nextInput(page, "문라이트 컬렉션 박스 1박스")).toHaveValue(String(moon + 1));
  // 되돌려 둔다. 앞 안내가 남아 있을 수 있어, 적용이 끝난 뒤 다시 불러와 실제 재고로 확인한다
  await nextInput(page, "탑로더 25장 1팩").fill(String(top));
  await nextInput(page, "문라이트 컬렉션 박스 1박스").fill(String(moon));
  await applyAll(page);
  await expect(page.getByRole("button", { name: "변경 0건 적용" }).first()).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(nextInput(page, "탑로더 25장 1팩")).toHaveValue(String(top));
  await expect(nextInput(page, "문라이트 컬렉션 박스 1박스")).toHaveValue(String(moon));
});

test("재고 검색은 옵션 목록 API의 이름 검색(q)으로 찾고, 처음에는 첫 쪽만 불러온다", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/seller/products/options?")) urls.push(r.url());
  });
  await openAs(page);
  await expect(page.getByTestId("stock-row").first()).toBeVisible();
  // 처음에는 첫 쪽 한 번만(다음 쪽을 이어서 부르지 않음)
  expect(urls).toHaveLength(1);
  expect(urls.filter((u) => new URL(u).searchParams.has("cursor"))).toHaveLength(0);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/seller/products/options?") && new URL(r.url()).searchParams.get("q") === "4포켓"),
    page.getByLabel("재고 검색").fill("4포켓"),
  ]);
  // 옵션 이름만 맞으면 그 옵션만 보인다
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await expect(page.getByTestId("stock-row").first()).toContainText("4포켓 바인더");
  // 재고 칩은 검색어와 함께 서버로 보낸다
  await Promise.all([
    page.waitForResponse((r) => {
      const u = new URL(r.url());
      return u.pathname.endsWith("/api/seller/products/options") && u.searchParams.get("stock") === "out" && u.searchParams.get("q") === "4포켓";
    }),
    page.getByRole("button", { name: "품절", exact: true }).click(),
  ]);
  await expect(page.getByText("조건에 맞는 옵션이 없어요")).toBeVisible();
});

test("다른 검색에서 바꿔 둔 재고도 함께 적용하고, 확인 창에 안 보이는 옵션 수를 알린다", async ({ page }) => {
  await openAs(page);
  const cur = async (name: string) => Number((await row(page, name).locator(".c-cur").innerText()).replace(/\D/g, ""));
  const top = await cur("탑로더 25장");
  const moon = await cur("문라이트 컬렉션 박스");
  await page.getByLabel("재고 검색").fill("탑로더");
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await nextInput(page, "탑로더 25장 1팩").fill(String(top + 1));
  await page.getByLabel("재고 검색").fill("문라이트 컬렉션");
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await nextInput(page, "문라이트 컬렉션 박스 1박스").fill(String(moon + 1));
  await expect(page.getByTestId("sum-count")).toHaveText("2개");
  await page.getByRole("button", { name: "변경 2건 적용" }).last().click();
  await expect(page.getByRole("dialog").getByTestId("apply-hidden")).toHaveText("화면에 안 보이는 1개 포함");
  await confirmApply(page);
  await expect(page.getByText("재고 2건을 바꿨어요")).toBeVisible();
  await page.reload();
  await expect(nextInput(page, "탑로더 25장 1팩")).toHaveValue(String(top + 1));
  await expect(nextInput(page, "문라이트 컬렉션 박스 1박스")).toHaveValue(String(moon + 1));
  // 되돌려 둔다
  await nextInput(page, "탑로더 25장 1팩").fill(String(top));
  await nextInput(page, "문라이트 컬렉션 박스 1박스").fill(String(moon));
  await applyAll(page);
  await expect(page.getByRole("button", { name: "변경 0건 적용" }).first()).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(nextInput(page, "탑로더 25장 1팩")).toHaveValue(String(top));
  await expect(nextInput(page, "문라이트 컬렉션 박스 1박스")).toHaveValue(String(moon));
});

test("옵션이 200개를 넘으면 「옵션 더 불러오기」로 다음 쪽을 이어 붙인다", async ({ page }) => {
  // 첫 쪽 200개 + 다음 쪽 30개(가짜 응답). 적용은 하지 않는다
  await routeFakeProducts(page, fakeProducts("쪽 상품", 230, 0));
  await openAs(page);
  await expect(page.getByTestId("stock-row")).toHaveCount(200);
  await expect(page.getByText("불러온 옵션 200개 · 옵션이 더 있어요", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "옵션 더 불러오기" }).click();
  await expect(page.getByTestId("stock-row")).toHaveCount(230);
  await expect(page.getByRole("button", { name: "옵션 더 불러오기" })).toHaveCount(0);
  await expect(page.getByText("불러온 옵션 230개 · 바뀐 옵션", { exact: false })).toBeVisible();
});

test("검색 결과가 오기 전에는 모두 선택·한꺼번에 적기를 막아 옛 결과에 적용하지 않는다", async ({ page }) => {
  await page.route("**/api/seller/products/options?**q=**", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    return route.continue();
  });
  await openAs(page);
  await page.getByLabel("재고 검색").fill("탑로더");
  await expect(page.getByLabel("보이는 옵션 모두 선택")).toBeDisabled();
  await expect(page.getByTestId("stock-searching")).toBeVisible();
  // 결과가 오면 다시 쓸 수 있고, 줄도 새 결과로 바뀐다
  await expect(page.getByLabel("보이는 옵션 모두 선택")).toBeEnabled({ timeout: 5000 });
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
});

test("검색 요청이 실패하면 「다시 시도」로 같은 검색어를 다시 불러온다", async ({ page }) => {
  let failOnce = true;
  await page.route("**/api/seller/products/options?**q=**", (route) => {
    if (failOnce) {
      failOnce = false;
      return route.fulfill({ status: 500, json: { error: "internal" } });
    }
    return route.continue();
  });
  await openAs(page);
  await page.getByLabel("재고 검색").fill("탑로더");
  await expect(page.getByTestId("search-failed")).toContainText("「탑로더」 결과를 불러오지 못했어요");
  await expect(page.getByLabel("보이는 옵션 모두 선택")).toBeDisabled();
  await page.getByTestId("search-failed").getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByTestId("search-failed")).toHaveCount(0);
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await expect(page.getByLabel("보이는 옵션 모두 선택")).toBeEnabled();
});

test("한 번에 적용하는 사이 검색을 바꾸면, 적용 뒤에도 새 검색 결과가 남는다", async ({ page }) => {
  // 적용 요청을 늦춰 그사이 검색을 바꾼다(실제로 적용하고 되돌린다)
  await page.route("**/stock-adjust", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    return route.continue();
  });
  await openAs(page);
  const top = Number((await row(page, "탑로더 25장").locator(".c-cur").innerText()).replace(/\D/g, ""));
  await nextInput(page, "탑로더 25장 1팩").fill(String(top + 1));
  await applyAll(page);
  await expect(page.getByRole("button", { name: /^0\/1 적용 중$/ }).first()).toBeVisible();
  await page.getByLabel("재고 검색").fill("문라이트 컬렉션");
  await expect(page.getByText("재고 1건을 바꿨어요")).toBeVisible();
  // 적용 뒤 다시 불러와도 지금 검색어(문라이트 컬렉션) 결과가 보이고, 모두 선택이 다시 켜진다
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await expect(page.getByTestId("stock-row").first()).toContainText("문라이트 컬렉션 박스");
  await expect(page.getByLabel("보이는 옵션 모두 선택")).toBeEnabled();
  // 되돌려 둔다
  await page.getByLabel("재고 검색").fill("탑로더");
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await nextInput(page, "탑로더 25장 1팩").fill(String(top));
  await applyAll(page);
  await expect(page.getByRole("button", { name: "변경 0건 적용" }).first()).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(nextInput(page, "탑로더 25장 1팩")).toHaveValue(String(top));
});

test("검색어가 틀리면(400) 검색창 바로 아래에 알리고 옛 결과를 감추며, 「검색 지우기」로 되돌린다", async ({ page }) => {
  await openAs(page);
  await expect(page.getByTestId("stock-row").first()).toBeVisible();
  // 폭 없는 공백만 있는 검색어는 서버가 400으로 막는다
  await page.getByLabel("재고 검색").fill("\u200b");
  await expect(page.getByTestId("search-error")).toHaveText(/검색어에 쓸 수 없는 글자가 있어요/);
  await expect(page.getByTestId("stock-row")).toHaveCount(0);
  // 검색창 바로 아래(툴바 다음)에 보인다
  const bar = (await page.locator(".stock-search").boundingBox())!;
  const err = (await page.getByTestId("search-error").boundingBox())!;
  expect(err.y - (bar.y + bar.height)).toBeLessThan(80);
  await page.getByTestId("search-error").getByRole("button", { name: "검색 지우기" }).click();
  await expect(page.getByLabel("재고 검색")).toHaveValue("");
  await expect(page.getByTestId("search-error")).toHaveCount(0);
  await expect(page.getByTestId("stock-row").first()).toBeVisible();
});

test("재고 검색어는 50자까지: 입력은 50자에서 멈추고, 바꾼 뒤 50자를 넘으면 길이로 안내한다", async ({ page }) => {
  await openAs(page);
  await page.getByLabel("재고 검색").fill("가".repeat(51));
  await expect(page.getByLabel("재고 검색")).toHaveValue("가".repeat(50));
  // 「㈜」는 NFKC로 「(주)」 3자가 되어 50개면 150자 → 서버가 길이로 막는다
  await page.getByLabel("재고 검색").fill("㈜".repeat(50));
  await expect(page.getByTestId("search-error")).toHaveText(/검색어는 50자까지 쓸 수 있어요/);
});

test("한 번에 적용하는 사이 새로 적은 재고는 적용 뒤에도 남는다", async ({ page }) => {
  await page.route("**/stock-adjust", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    return route.continue();
  });
  await openAs(page);
  const top = Number((await row(page, "탑로더 25장").locator(".c-cur").innerText()).replace(/\D/g, ""));
  const moon = Number((await row(page, "문라이트 컬렉션 박스").locator(".c-cur").innerText()).replace(/\D/g, ""));
  await nextInput(page, "탑로더 25장 1팩").fill(String(top + 1));
  await applyAll(page);
  await expect(page.getByRole("button", { name: /^0\/1 적용 중$/ }).first()).toBeVisible();
  // 적용 중에 다른 옵션을 새로 적는다(이번 적용에는 들어가지 않음)
  await nextInput(page, "문라이트 컬렉션 박스 1박스").fill(String(moon + 2));
  await expect(page.getByText("재고 1건을 바꿨어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "변경 1건 적용" }).first()).toBeVisible();
  await expect(nextInput(page, "문라이트 컬렉션 박스 1박스")).toHaveValue(String(moon + 2));
  await expect(page.getByTestId("sum-count")).toHaveText("1개");
  // 적용한 탑로더는 새 재고로 바뀌어 있고 바뀐 것으로 세지 않는다
  await expect(row(page, "탑로더 25장").locator(".c-cur")).toContainText(String(top + 1));
  // 문라이트는 적용하지 않고 지우고, 탑로더는 되돌려 둔다
  await nextInput(page, "문라이트 컬렉션 박스 1박스").fill(String(moon));
  await nextInput(page, "탑로더 25장 1팩").fill(String(top));
  await applyAll(page);
  await expect(page.getByRole("button", { name: "변경 0건 적용" }).first()).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(nextInput(page, "탑로더 25장 1팩")).toHaveValue(String(top));
  await expect(nextInput(page, "문라이트 컬렉션 박스 1박스")).toHaveValue(String(moon));
});

test("재고 칩(품절·5 이하)은 서버에서 옵션 단위로 걸러, 아직 불러오지 않은 쪽의 옵션도 보여 준다", async ({ page }) => {
  // 재고 10인 상품 230개 뒤에 품절 옵션 1개 · 재고 2인 옵션 1개(첫 쪽 200개 밖)
  const all = fakeProducts("쪽 상품", 230, 0);
  const tail = fakeProducts("뒤쪽", 2, 5000);
  tail[0].options[0].stock = 0;
  tail[1].options[0].stock = 2;
  await routeFakeProducts(page, [...all, ...tail]);
  await openAs(page);
  await page.getByRole("button", { name: "품절", exact: true }).click();
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await expect(page.getByTestId("stock-row").first()).toContainText("뒤쪽 1");
  // 서버에서 거르므로 「불러온 상품 중에서」 안내는 없다
  await expect(page.getByTestId("chip-scope")).toHaveCount(0);
  await page.getByRole("button", { name: "품절", exact: true }).click();
  await page.getByRole("button", { name: "재고 5 이하" }).click();
  await expect(page.getByTestId("stock-row")).toHaveCount(1);
  await expect(page.getByTestId("stock-row").first()).toContainText("뒤쪽 2");
});

test("품절 칩을 켠 채 빼기·더하기로 재고를 더하면 조건에 안 맞게 된 줄은 목록에서 빠진다", async ({ page }) => {
  await openAs(page);
  await page.getByRole("button", { name: "품절", exact: true }).click();
  await expect(row(page, "드래곤 소울 부스터")).toBeVisible();
  const label = "드래곤 소울 부스터 1팩";
  await page.getByRole("button", { name: `${label} 빼기 · 더하기` }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: "더하기" }).click();
  await sheet.getByLabel("수량").fill("3");
  await sheet.getByRole("radio", { name: "서비스" }).click();
  await sheet.getByRole("button", { name: "3개 더하기" }).click();
  // 재고 3이 되어 품절 조건에 안 맞으니 목록에서 빠진다
  await expect(row(page, "드래곤 소울 부스터")).toHaveCount(0);
  // 되돌려 둔다(칩을 끄고 3개 빼기)
  await page.getByRole("button", { name: "품절", exact: true }).click();
  await expect(row(page, "드래곤 소울 부스터").locator(".c-cur")).toContainText("3");
  await page.getByRole("button", { name: `${label} 빼기 · 더하기` }).click();
  await sheet.getByLabel("수량").fill("3");
  await sheet.getByRole("radio", { name: "서비스" }).click();
  await sheet.getByRole("button", { name: "3개 빼기" }).click();
  await expect(row(page, "드래곤 소울 부스터").locator(".c-cur")).toContainText("0");
});
