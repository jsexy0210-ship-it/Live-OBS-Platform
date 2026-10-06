import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-061 배송비 정책: 방식(무료·고정·일정 금액 이상 무료)과 금액을 바꾸고 저장해 확인한다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

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

async function openAs(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Fshipping");
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/settings\/shipping$/);
}

// 저장 앞 확인 창(DS-CONFIRM): 입력이 올바르면 창이 열리고 「저장」을 눌러야 서버에 보낸다. 입력 오류면 창 없이 오류만 보인다
async function save(page: Page) {
  await page.getByRole("button", { name: "저장", exact: true }).last().click();
  const dialog = page.getByRole("dialog");
  if (await dialog.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)) {
    await expect(dialog).toContainText("배송 설정을 저장하시겠습니까?");
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
  }
}
const saved = (page: Page) => expect(page.getByText("배송 설정을 저장했습니다 · 다음 주문부터").first()).toBeVisible();
// 저장이 실제로 끝날 때까지(PUT 응답) 기다린다. 앞서 띄운 같은 알림이 남아 있어도 다음 단계로 먼저 넘어가지 않게
async function saveOk(page: Page) {
  await Promise.all([page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/shipping-policy") && r.ok()), save(page)]);
  await saved(page);
}

test("일정 금액 이상 무료로 바꾸면 저장되고 주문서 미리보기에 보인다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByRole("radio", { name: "일정 금액 이상 무료" }).check();
  await page.getByLabel("배송비", { exact: true }).fill("3,500");
  await page.getByLabel("무료 배송 기준").fill("50000");
  await page.getByLabel("제주 · 도서산간 추가 배송비").fill("4000");
  await expect(page.getByTestId("fee-preview")).toHaveText("배송비 3,500원 · 50,000원 이상 무료");
  await saveOk(page);
  await shot(page, "SA-061-shipping");

  await page.reload();
  await expect(page.getByRole("radio", { name: "일정 금액 이상 무료" })).toBeChecked();
  await expect(page.getByLabel("배송비", { exact: true })).toHaveValue("3500");
  await expect(page.getByLabel("무료 배송 기준")).toHaveValue("50000");
  await expect(page.getByLabel("제주 · 도서산간 추가 배송비")).toHaveValue("4000");
});

test("무료·고정으로 바꿔도 저장되고, 잘못된 금액은 막는다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByRole("radio", { name: "무료", exact: true }).check();
  await expect(page.getByTestId("fee-preview")).toHaveText("배송비 무료");
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "무료", exact: true })).toBeChecked();

  await page.getByRole("radio", { name: "고정" }).check();
  await page.getByLabel("배송비", { exact: true }).fill("-500");
  await save(page);
  await expect(page.getByText("1원 이상으로 입력해 주십시오")).toBeVisible();
  await page.getByLabel("배송비", { exact: true }).fill("200000");
  await expect(page.getByText("100,000원까지 정할 수 있습니다")).toBeVisible();
  await shot(page, "SA-061-shipping-error");

  // 기본값으로 되돌려 둔다
  await page.getByLabel("배송비", { exact: true }).fill("3000");
  await page.getByLabel("제주 · 도서산간 추가 배송비").fill("3000");
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "고정" })).toBeChecked();
  await expect(page.getByTestId("fee-preview")).toHaveText("배송비 3,000원");
});

test("무료로 바꿨다가 되돌리면 이전에 넣은 배송비·무료 기준이 그대로 있다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByRole("radio", { name: "일정 금액 이상 무료" }).check();
  await page.getByLabel("배송비", { exact: true }).fill("2500");
  await page.getByLabel("무료 배송 기준").fill("70000");
  await saveOk(page);

  await page.getByRole("radio", { name: "무료", exact: true }).check();
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("radio", { name: "무료", exact: true })).toBeChecked();
  await page.getByRole("radio", { name: "일정 금액 이상 무료" }).check();
  await expect(page.getByLabel("배송비", { exact: true })).toHaveValue("2500");
  await expect(page.getByLabel("무료 배송 기준")).toHaveValue("70000");

  // 기본값으로 되돌려 둔다
  await page.getByRole("radio", { name: "고정" }).check();
  await page.getByLabel("배송비", { exact: true }).fill("3000");
  await saveOk(page);
});

test("1440에서 도움말이 단어 중간에서 끊기지 않는다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  const help = page.getByText("우편번호로 자동 판별하고 금액은 하나로 같습니다", { exact: false });
  await expect(help).toBeVisible();
  expect(await help.evaluate((el) => getComputedStyle(el).wordBreak)).toBe("keep-all");
});

test("로그인이 풀린 뒤 다른 설정 탭으로 가면 로그인으로 보낸다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  // 첫 화면 데이터를 다 받은 뒤 로그인을 끊는다
  await expect(page.getByTestId("fee-preview")).toBeVisible();
  await page.context().clearCookies();
  await page.getByRole("link", { name: "주문 설정", exact: true }).first().click();
  await expect(page).toHaveURL(/\/seller\/login\?next=%2Fseller%2Fsettings%2Forder&reason=expired$/);
});

test("쇼핑몰 설정 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await openAs(page, "demo-viewer@example.com");
  await expect(page.getByText("필요한 권한: 쇼핑몰 설정")).toBeVisible();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
});

test("반품 · 교환 배송비: 기본 3,000원 · 6,000원, 바꾸면 저장되고 무료 배송 주문은 반품 배송비 × 2를 뺀다고 안내한다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  const ret = page.getByLabel("반품 배송비 (편도)");
  const exc = page.getByLabel("교환 배송비 (왕복)");
  await expect(page.getByText("무료 배송 주문(배송비 0원)은 반품 배송비 × 2를 뺍니다")).toBeVisible();
  await expect(page.getByText("도서산간 추가 배송비를 낸 주문은 한 번만 뺍니다", { exact: false })).toBeVisible();
  // 「알아 두세요」도 같은 환불 규칙으로 안내한다
  await expect(page.getByText("발송 뒤 상품 불량 · 오배송이면 상품값과 처음 낸 배송비를 돌려주고, 단순 변심이면 반품 배송비를 빼고 돌려줍니다.", { exact: false })).toBeVisible();
  // 교환 배송비는 아직 쓰이는 곳이 없어 「교환 접수가 열리면 적용돼요」로 안내한다
  await expect(page.getByText("기본 6,000원 · 교환 접수가 열리면 적용됩니다")).toBeVisible();
  const before = { ret: await ret.inputValue(), exc: await exc.inputValue() };

  // 빈칸·잘못된 금액은 막는다
  await ret.fill("");
  await save(page);
  await expect(page.getByText("금액을 입력해 주십시오")).toBeVisible();
  await ret.fill("-1");
  await save(page);
  await expect(page.getByText("숫자만 입력해 주십시오").or(page.getByText("0원 이상으로 입력해 주십시오")).first()).toBeVisible();
  await exc.fill("100001");
  await expect(page.getByText("100,000원까지 정할 수 있습니다")).toBeVisible();

  await ret.fill("2,500");
  await exc.fill("5000");
  await expect(page.getByTestId("return-preview")).toContainText("단순 변심 반품 배송비 2,500원 · 교환 5,000원");
  await saveOk(page);
  await page.reload();
  await expect(ret).toHaveValue("2500");
  await expect(exc).toHaveValue("5000");
  await shot(page, "SA-061-return");

  // 되돌려 둔다
  await ret.fill(before.ret);
  await exc.fill(before.exc);
  await saveOk(page);
});

// 저장 응답이 늦는 동안 칸을 고치면 늦게 온 응답이 덮는다: 저장하는 동안은 칸을 잠근다(주문·회원 정책·공유 미리보기도 같은 방식)
test("저장하는 동안에는 칸을 잠가 저장 중 수정이 응답으로 덮이지 않는다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByLabel("배송비", { exact: true }).fill("3100");
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/seller/shipping-policy", async (route) => {
    if (route.request().method() === "PUT") await held;
    await route.continue();
  });
  await save(page);
  await expect(page.getByLabel("배송비", { exact: true })).toBeDisabled();
  release();
  await saved(page);
  await expect(page.getByLabel("배송비", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("배송비", { exact: true })).toHaveValue("3100");
  await page.unrouteAll();
  await page.getByLabel("배송비", { exact: true }).fill("3000");
  await saveOk(page);
});

test("받는 방법·발송 기한·기본 택배사: 바로 받기만 켜져 있고 보관 후 받기는 준비 중, 기한 범위를 막고, 저장하면 다시 열어도 그대로다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  const methods = page.getByTestId("receive-methods");
  await expect(methods.getByLabel("바로 받기")).toBeChecked();
  await expect(methods.getByLabel("바로 받기")).toBeDisabled();
  await expect(methods.getByLabel("보관하기 · 합배송 (곧 열립니다)")).toBeDisabled();
  await expect(methods.getByLabel("보관하기 · 합배송 (곧 열립니다)")).not.toBeChecked();
  const before = { days: await page.getByLabel("발송까지 걸리는 기간").inputValue(), courier: await page.locator("#default-courier").inputValue() };

  // 범위 밖은 저장하지 않고 이유를 보인다
  for (const bad of ["0", "31", "abc", ""]) {
    await page.getByLabel("발송까지 걸리는 기간").fill(bad);
    await save(page);
    await expect(page.getByText(bad === "" ? "발송까지 걸리는 기간을 적어 주십시오" : bad === "abc" ? "숫자만 입력해 주십시오" : "1일에서 30일 사이로 입력해 주십시오").first()).toBeVisible();
  }

  await page.getByLabel("발송까지 걸리는 기간").fill("7");
  await page.locator("#default-courier").selectOption("CJ");
  const put = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/shipping-policy"));
  await save(page);
  const res = await put;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ receiveMethods: ["IMMEDIATE"], dispatchDeadlineDays: 7, defaultCourier: "CJ" });
  await saved(page);

  await page.reload();
  await expect(page.getByLabel("발송까지 걸리는 기간")).toHaveValue("7");
  await expect(page.locator("#default-courier")).toHaveValue("CJ");

  // 택배사를 정하지 않음으로 되돌리면 null로 저장되고, 처음 값으로 복원한다
  await page.locator("#default-courier").selectOption("");
  await page.getByLabel("발송까지 걸리는 기간").fill(before.days);
  const clear = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/shipping-policy"));
  await save(page);
  expect((await clear).request().postDataJSON()).toMatchObject({ defaultCourier: null, dispatchDeadlineDays: Number(before.days) });
  await saved(page);
  if (before.courier !== "") {
    await page.locator("#default-courier").selectOption(before.courier);
    await saveOk(page);
  }
});
