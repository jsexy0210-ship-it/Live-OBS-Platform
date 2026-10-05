import { expect, test, type Page } from "@playwright/test";
import { cleanupProducts, RUN, track } from "./cleanup";
import { submitSellerLogin } from "./sellerLogin";

// 파트너스 화면 미리보기: 저장 전 입력값을 바로 그리는지(저장된 서버 값이나 일부 칸만 쓰지 않는지) 확인한다.
// 저장하지 않으므로 데모 데이터는 바뀌지 않는다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.afterAll(() => cleanupProducts(PASSWORD));
test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `tests/e2e/screenshots/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function open(page: Page, path: string) {
  await page.goto(`/seller/login?next=${encodeURIComponent(path)}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}$`));
}

test("상품 등록 미리보기: 상품명·판매가·설명·옵션·판매 상태를 입력하는 즉시 반영한다", async ({ page }) => {
  await open(page, "/seller/products/new");
  const pv = page.getByTestId("product-preview");
  await expect(pv.getByTestId("preview-description")).toHaveText("상품 설명을 입력하면 여기에 표시됩니다");

  await page.getByLabel("상품명").fill("미리보기 부스터 팩");
  await expect(pv.getByTestId("preview-name")).toHaveText("미리보기 부스터 팩");
  await page.getByLabel("판매가").fill("15,000");
  await expect(pv.getByTestId("preview-price")).toHaveText("15,000원");
  // 새 상품의 옵션 하나(「기본」, 재고 0): 목록은 숨겨도 품절과 추가 금액은 대표 가격·배지에 반영한다
  await expect(pv.locator(".pbadge")).toHaveText("품절");
  await page.getByLabel("옵션 1 추가 금액").fill("2000");
  await expect(pv.getByTestId("preview-price")).toHaveText("17,000원");
  await page.getByLabel("옵션 1 추가 금액").fill("0");
  await page.getByLabel("옵션 1 재고").fill("3");
  await expect(pv.locator(".pbadge")).toHaveCount(0);
  await expect(pv.getByTestId("preview-price")).toHaveText("15,000원");

  // 짧은 설명(한 줄, 80자까지): 입력하는 즉시 반영한다
  await page.getByLabel("짧은 설명").fill("1박스 36팩 구성 · 미개봉 정품 · 주문 다음 날 발송");
  const desc = pv.getByTestId("preview-description");
  await expect(desc).toHaveText("1박스 36팩 구성 · 미개봉 정품 · 주문 다음 날 발송");
  await expect(pv.getByRole("button", { name: "더보기" })).toHaveCount(0);

  // 옵션: 이름·옵션별 가격(판매가 + 추가 금액)·재고 0이면 품절
  await page.getByLabel("옵션 1 이름").fill("1팩");
  await page.getByLabel("옵션 1 재고").fill("30");
  await page.getByRole("button", { name: "+ 옵션 추가" }).click();
  await page.getByLabel("옵션 2 이름").fill("3팩 묶음");
  await page.getByLabel("옵션 2 추가 금액").fill("28000");
  await page.getByLabel("옵션 2 재고").fill("5");
  const opts = pv.getByTestId("preview-options").locator("li");
  await expect(opts).toHaveCount(2);
  await expect(opts.nth(0)).toHaveText(/1팩\s*15,000원/);
  await expect(opts.nth(1)).toHaveText(/3팩 묶음\s*43,000원/);
  await page.getByLabel("옵션 2 재고").fill("0");
  await expect(opts.nth(1)).toHaveText(/3팩 묶음\s*품절/);
  await shot(page, "SA-012-preview");

  // 판매 상태
  const status = page.getByRole("radiogroup", { name: "판매 상태" });
  await status.getByRole("radio", { name: "품절" }).click();
  await expect(pv.getByText("품절", { exact: true }).first()).toBeVisible();
  await expect(opts.nth(0)).toHaveText(/1팩\s*품절/);
  await status.getByRole("radio", { name: "숨김" }).click();
  await expect(pv.getByTestId("preview-status-note")).toHaveText("숨김 상태라 쇼핑몰에 표시되지 않습니다");
});

test("상품 수정 미리보기: 저장된 값이 아니라 고치는 중인 설명을 바로 보여 준다", async ({ page }) => {
  await open(page, "/seller/products");
  await page.getByTestId("product-row").filter({ hasText: "문라이트 컬렉션 박스" }).getByRole("link").first().click();
  await expect(page.getByLabel("상품명")).toHaveValue("문라이트 컬렉션 박스");
  const pv = page.getByTestId("product-preview");
  await expect(pv.getByTestId("preview-name")).toHaveText("문라이트 컬렉션 박스");
  await page.getByLabel("짧은 설명").fill("수정 중인 설명");
  await expect(pv.getByTestId("preview-description")).toHaveText("수정 중인 설명");
  await page.getByLabel("판매가").fill("99000");
  await expect(pv.getByTestId("preview-price")).toHaveText("99,000원");
  await shot(page, "SA-012-E-preview");
});

test("배송비 정책 미리보기: 방식·배송비·무료 기준·도서산간·반품·교환 배송비를 저장 전에 바로 보여 준다", async ({ page }) => {
  await open(page, "/seller/settings/shipping");
  await page.getByRole("radio", { name: "일정 금액 이상 무료" }).check();
  await page.getByLabel("배송비", { exact: true }).fill("2,800");
  await page.getByLabel("무료 배송 기준").fill("40000");
  await expect(page.getByTestId("fee-preview")).toHaveText("배송비 2,800원 · 40,000원 이상 무료");
  await page.getByLabel("제주 · 도서산간 추가 배송비").fill("5000");
  await expect(page.getByTestId("remote-preview")).toHaveText("+5,000원 · 해당 주소만");
  await page.getByLabel("반품 배송비 (편도)").fill("3500");
  await page.getByLabel("교환 배송비 (왕복)").fill("7000");
  await expect(page.getByTestId("return-preview")).toContainText("단순 변심 반품 배송비 3,500원 · 교환 7,000원");
  await page.getByRole("radio", { name: "무료", exact: true }).check();
  await expect(page.getByTestId("fee-preview")).toHaveText("배송비 무료");
});

test("주문 설정 미리보기: 입금 기한·자동 배송 완료·자동 구매 확정을 저장 전에 바로 보여 준다", async ({ page }) => {
  await open(page, "/seller/settings/order");
  await page.getByLabel("입금 기한", { exact: true }).fill("12");
  await expect(page.getByTestId("buyer-preview")).toContainText("주문 후 12시간 안에 입금");
  await page.getByLabel("자동 배송 완료 기간").fill("4");
  await page.getByLabel("자동 구매 확정 기간").fill("9");
  await expect(page.getByTestId("delivery-preview")).toContainText("배송 중 4일이 지나면 배송 완료로 바뀝니다 · 배송 완료 9일 뒤 자동으로 구매 확정됩니다");
});

test("공유 미리보기: 제목·설명을 저장 전에 카드에 바로 보여 준다", async ({ page }) => {
  await open(page, "/seller/settings/share");
  const card = page.getByTestId("sp-card");
  await page.getByLabel("제목").fill("미리보기 제목");
  await page.getByLabel("설명").fill("미리보기 설명");
  await expect(card).toContainText("미리보기 제목");
  await expect(card).toContainText("미리보기 설명");
});

// 이전에 저장한 긴 설명·여러 줄 설명: 한 줄 입력칸으로 바꾸면 줄바꿈이 사라지므로 여러 줄 칸으로 보여 주고, 미리보기는 줄바꿈을 지키며 길면 접는다
test("이미 저장된 여러 줄 설명은 여러 줄 칸으로 보이고, 미리보기는 줄바꿈을 지키며 길면 「더보기」로 편다", async ({ page }) => {
  await open(page, "/seller/products");
  const name = track(`긴설명 ${RUN}`);
  const description = Array.from({ length: 12 }, (_, i) => `${i + 1}번째 줄 안내`).join("\n");
  const res = await page.request.post("/api/seller/products", {
    data: { name, price: 1000, status: "DRAFT", description, options: [{ name: "기본", priceDelta: 0, stock: 1, sortOrder: 0 }] },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/seller/products/${id}`);
  const box = page.getByLabel("짧은 설명");
  expect(await box.evaluate((el) => el.tagName)).toBe("TEXTAREA");
  await expect(box).toHaveValue(description);
  const pv = page.getByTestId("product-preview");
  const desc = pv.getByTestId("preview-description");
  expect(await desc.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
  await expect(desc).toContainText("12번째 줄 안내");
  expect(await desc.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  await pv.getByRole("button", { name: "더보기" }).click();
  expect(await desc.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await expect(pv.getByRole("button", { name: "접기" })).toBeVisible();
});
