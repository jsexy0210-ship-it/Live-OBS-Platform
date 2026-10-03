import { expect, test, type Page } from "@playwright/test";

// SA-063 주문 설정: 입금 기한·자동 취소·자동 구매 제한·자동 배송 완료·자동 구매 확정을 실제로 바꾸고 저장해 확인한다.
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

// 다른 테스트·이전 실행이 바꾼 값에 기대지 않게, 시작할 때 주문 설정을 기본값으로 맞춘다(대표자로 로그인한 뒤)
async function resetPolicy(page: Page) {
  const status = await page.evaluate(async () => {
    const res = await fetch("/api/seller/order-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        autoCancelEnabled: true,
        paymentDueHours: 24,
        unpaidRestrictionEnabled: true,
        restockOnCancel: true,
        autoDeliverEnabled: true,
        autoDeliverDays: 7,
        autoConfirmEnabled: true,
        autoConfirmDays: 7,
      }),
    });
    return res.status;
  });
  expect(status).toBe(200);
  await page.reload();
}

async function openAs(page: Page, email: string) {
  await page.goto("/seller/login?next=%2Fseller%2Fsettings%2Forder");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/settings\/order$/);
  if (email === "demo-owner@example.com") await resetPolicy(page);
}

const save = (page: Page) => page.getByRole("button", { name: "저장", exact: true }).last().click();
// 저장이 실제로 끝날 때까지(PUT 응답) 기다린다. 앞서 띄운 같은 알림이 남아 있어도 다음 단계로 먼저 넘어가지 않게
async function saveOk(page: Page) {
  await Promise.all([page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/order-policy") && r.ok()), save(page)]);
  await expect(page.getByText("주문 설정을 저장했어요", { exact: false }).first()).toBeVisible();
}

test("저장한 적 없는 판매자도 입금 기한이 기본 24시간으로 보이고, 메뉴로 들어갈 수 있다", async ({ page }) => {
  // 새 DB에서 처음 돌릴 때는 주문 설정 행이 없어서 서버 기본값(24시간)이 그대로 보인다. 다시 돌려도 앞 테스트가 24시간으로 되돌려 둔다
  await page.goto("/seller/login");
  await page.getByLabel("이메일").fill("demo-owner@example.com");
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/seller\/products$/);
  await page.getByRole("link", { name: "쇼핑몰 설정" }).click();
  await expect(page).toHaveURL(/\/seller\/settings\/shipping$/);
  await page.getByRole("link", { name: "주문 설정" }).click();
  await expect(page).toHaveURL(/\/seller\/settings\/order$/);
  await expect(page.getByRole("link", { name: "쇼핑몰 설정" })).toHaveClass(/\bon\b/);
  // 새 DB 첫 실행에서는 저장한 적 없는 상태(서버 기본값)를 그대로 본다. 다시 돌릴 때는 이전 실행이 남긴 값이 있을 수 있어 기본값으로 맞춘 뒤 본다
  if ((await page.getByLabel("입금 기한", { exact: true }).inputValue()) !== "24") await resetPolicy(page);
  await expect(page.getByLabel("입금 기한", { exact: true })).toHaveValue("24");
  await expect(page.getByRole("radio", { name: "시간" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("buyer-preview")).toContainText("주문 후 24시간 안에 입금");
  // 정기 실행이 연결되기 전까지는 자동 취소가 아직 돌지 않는다고 알려 준다
  await expect(page.getByTestId("auto-cancel-pending")).toContainText("아직 자동으로 취소되지 않아요");
  await expect(page.getByTestId("restriction-pending")).toContainText("주문 막기도 시작되지 않았어요");
});

test("입금 기한을 3일·24시간으로 바꿔 저장하면 다시 열어도 그대로이고 구매자 안내에 보인다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await expect(page.getByText("기본 24시간", { exact: false })).toBeVisible();

  // 일 단위: 3일 = 72시간으로 저장되고 다시 열면 3일로 보인다
  await page.getByRole("radio", { name: "일" }).click();
  await page.getByLabel("입금 기한", { exact: true }).fill("3");
  await expect(page.getByTestId("buyer-preview")).toContainText("주문 후 3일 안에 입금");
  await saveOk(page);
  await page.reload();
  await expect(page.getByLabel("입금 기한", { exact: true })).toHaveValue("3");
  await expect(page.getByRole("radio", { name: "일" })).toHaveAttribute("aria-checked", "true");

  // 시간 단위: 기본값인 24시간으로 되돌린다
  await page.getByRole("radio", { name: "시간" }).click();
  await expect(page.getByLabel("입금 기한", { exact: true })).toHaveValue("72");
  await page.getByLabel("입금 기한", { exact: true }).fill("24");
  await expect(page.getByTestId("buyer-preview")).toHaveText("주문서 · 무통장 입금: 「주문 후 24시간 안에 입금하면 주문대기에 올라가요」");
  await saveOk(page);
  await shot(page, "SA-063-order");

  await page.reload();
  await expect(page.getByLabel("입금 기한", { exact: true })).toHaveValue("24");
  await expect(page.getByRole("radio", { name: "시간" })).toHaveAttribute("aria-checked", "true");
});

test("잘못된 기한은 저장하지 않고 안내한다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByRole("radio", { name: "시간" }).click();
  await page.getByLabel("입금 기한", { exact: true }).fill("0");
  await save(page);
  await expect(page.getByText("1 이상으로 적어 주세요 · 자동 취소를 끄려면 위 스위치를 꺼 주세요")).toBeVisible();
  await page.getByRole("radio", { name: "일" }).click();
  await page.getByLabel("입금 기한", { exact: true }).fill("31");
  await expect(page.getByText("입금 기한은 30일(720시간)까지 정할 수 있어요")).toBeVisible();
  await shot(page, "SA-063-order-error");
  await page.reload();
  await expect(page.getByLabel("입금 기한", { exact: true })).not.toHaveValue("31");
});

test("자동 취소·주문 막기를 끄면 저장되고, 다시 켤 수 있다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByRole("switch", { name: "기한이 지나면 자동 취소" }).click();
  await expect(page.getByText("미입금 주문이 쌓이면 재고가 묶여요")).toBeVisible();
  await page.getByRole("switch", { name: "미입금으로 3번 취소되면 30일 동안 주문 막기" }).click();
  await page.getByRole("switch", { name: "취소·반품하면 재고 되돌리기" }).click();
  await saveOk(page);
  await shot(page, "SA-063-order-off");

  await page.reload();
  await expect(page.getByRole("switch", { name: "기한이 지나면 자동 취소" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "미입금으로 3번 취소되면 30일 동안 주문 막기" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "취소·반품하면 재고 되돌리기" })).toHaveAttribute("aria-checked", "false");

  await page.getByRole("switch", { name: "기한이 지나면 자동 취소" }).click();
  await page.getByRole("switch", { name: "미입금으로 3번 취소되면 30일 동안 주문 막기" }).click();
  await page.getByRole("switch", { name: "취소·반품하면 재고 되돌리기" }).click();
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("switch", { name: "취소·반품하면 재고 되돌리기" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "기한이 지나면 자동 취소" })).toHaveAttribute("aria-checked", "true");
});

test("로그인이 풀린 뒤 저장하면 로그인으로 보내고, 로그아웃이 실패하면 화면에 남는다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.route("**/api/seller/auth/logout", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page.getByText("로그아웃하지 못했어요. 다시 시도해 주세요")).toBeVisible();
  await expect(page).toHaveURL(/\/seller\/settings\/order$/);
  await page.unroute("**/api/seller/auth/logout");

  await page.context().clearCookies();
  await page.getByRole("switch", { name: "미입금으로 3번 취소되면 30일 동안 주문 막기" }).click();
  await save(page);
  await expect(page).toHaveURL(/\/seller\/login\?next=%2Fseller%2Fsettings%2Forder$/);
});

test("자동 취소를 꺼 둔 상태에서는 숨겨진 입금 기한 값이 틀려도 저장 버튼이 켜지지 않는다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByRole("switch", { name: "기한이 지나면 자동 취소" }).click();
  await saveOk(page);
  // 다시 켜서 틀린 값을 적고 끄면, 저장된 상태와 같으므로 저장 버튼은 꺼져 있다
  await page.getByRole("switch", { name: "기한이 지나면 자동 취소" }).click();
  await page.getByLabel("입금 기한", { exact: true }).fill("0");
  await page.getByRole("switch", { name: "기한이 지나면 자동 취소" }).click();
  await expect(page.getByRole("button", { name: "저장", exact: true }).last()).toBeDisabled();
  await resetPolicy(page);
});

test("쇼핑몰 설정 권한이 없는 직원은 권한 안내를 본다", async ({ page }) => {
  await openAs(page, "demo-viewer@example.com");
  await expect(page.getByText("이 기능은 권한이 필요해요")).toBeVisible();
  await expect(page.getByText("필요한 권한: 쇼핑몰 설정")).toBeVisible();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
});

test("자동 배송 완료·자동 구매 확정: 기본 7일, 기간을 바꾸거나 끄면 저장되고 다시 열어도 그대로다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await expect(page.getByTestId("auto-deliver-pending")).toBeVisible();
  // 기간은 주문마다 따로 저장되지 않아, 바꾸면 진행 중인 주문에도 적용된다고 알린다
  await expect(page.getByTestId("delivery-existing")).toHaveText("기간을 바꾸면 이미 배송 중이거나 배송 완료된 주문도 바뀐 기간으로 계산해요.");
  await expect(page.getByLabel("자동 배송 완료 기간")).toHaveValue("7");
  await expect(page.getByLabel("자동 구매 확정 기간")).toHaveValue("7");
  await expect(page.getByTestId("delivery-preview")).toContainText("배송 중 7일이 지나면 배송 완료로 바뀌어요 · 배송 완료 7일 뒤 자동으로 구매 확정돼요");
  await shot(page, "SA-063-delivery");

  // 기간 검사: 1~30일
  await page.getByLabel("자동 배송 완료 기간").fill("31");
  await save(page);
  await expect(page.getByText("1일부터 30일까지 정할 수 있어요")).toBeVisible();
  await page.getByLabel("자동 배송 완료 기간").fill("0");
  await expect(page.getByText("1일부터 30일까지 정할 수 있어요")).toBeVisible();
  // 빈칸은 따로 안내한다
  await page.getByLabel("자동 배송 완료 기간").fill("");
  await expect(page.getByText("기간을 적어 주세요")).toBeVisible();

  // 3일·끄기로 저장 → 다시 열어도 그대로
  await page.getByLabel("자동 배송 완료 기간").fill("3");
  await page.getByRole("switch", { name: "배송 완료 뒤 일정 기간이 지나면 자동 구매 확정" }).click();
  await expect(page.getByLabel("자동 구매 확정 기간")).toHaveCount(0);
  await expect(page.getByTestId("delivery-preview")).toContainText("배송 중 3일이 지나면 배송 완료로 바뀌어요");
  await expect(page.getByTestId("delivery-preview")).not.toContainText("구매 확정돼요");
  await saveOk(page);
  await page.reload();
  await expect(page.getByLabel("자동 배송 완료 기간")).toHaveValue("3");
  await expect(page.getByRole("switch", { name: "배송 완료 뒤 일정 기간이 지나면 자동 구매 확정" })).toHaveAttribute("aria-checked", "false");

  // 다시 켜면 이전 기간(7일)이 그대로 있다
  await page.getByRole("switch", { name: "배송 완료 뒤 일정 기간이 지나면 자동 구매 확정" }).click();
  await expect(page.getByLabel("자동 구매 확정 기간")).toHaveValue("7");
  await page.getByLabel("자동 구매 확정 기간").fill("14");
  await saveOk(page);
  await page.reload();
  await expect(page.getByLabel("자동 구매 확정 기간")).toHaveValue("14");
  // 원래 값(7일·7일)으로 되돌려 둔다
  await page.getByLabel("자동 배송 완료 기간").fill("7");
  await page.getByLabel("자동 구매 확정 기간").fill("7");
  await saveOk(page);
});

test("자동 구매 확정을 꺼 둔 상태에서는 숨겨진 기간 값이 틀려도 저장할 수 있다", async ({ page }) => {
  await openAs(page, "demo-owner@example.com");
  await page.getByLabel("자동 구매 확정 기간").fill("99");
  await page.getByRole("switch", { name: "배송 완료 뒤 일정 기간이 지나면 자동 구매 확정" }).click();
  // 꺼짐으로 바뀐 것만 저장되고, 기간은 저장된 7일 그대로 보낸다
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("switch", { name: "배송 완료 뒤 일정 기간이 지나면 자동 구매 확정" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "배송 완료 뒤 일정 기간이 지나면 자동 구매 확정" }).click();
  await expect(page.getByLabel("자동 구매 확정 기간")).toHaveValue("7");
  // 켜진 상태로 되돌려 저장해 둔다
  await saveOk(page);
  await page.reload();
  await expect(page.getByRole("switch", { name: "배송 완료 뒤 일정 기간이 지나면 자동 구매 확정" })).toHaveAttribute("aria-checked", "true");
});
