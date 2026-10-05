import { expect, test, type Page } from "@playwright/test";
import { refundableOrderIdInDb } from "./rewardDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-021 주문 목록 · SA-022 주문 상세 · SA-023 환불 모달. dev-seed의 데모 주문 27건(결제 대기·완료·발송·환불됨·취소, 개봉한 상품이 있는 발송 주문 2건)으로 확인한다.
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

async function login(page: Page, email = "demo-owner@example.com", next = "/seller/orders") {
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${next.replace(/\//g, "\\/")}$`));
}

const rows = (page: Page) => page.getByTestId("order-row");

// 실제 환불 시험은 시드의 발송 전 결제 주문(배송 「—」)을 환불해 하나씩 쓴다(실행마다 몇 건). 같은 DB로 여러 번 돌려 다 쓰면
// 환불할 주문이 없어 시간 초과로만 보이므로, 이유를 알려 주며 바로 실패한다. 폐기용 DB를 새로 만들면(migrate deploy → dev-seed) 다시 채워진다.
async function preShipTarget(page: Page) {
  const target = rows(page).filter({ has: page.locator("td:nth-child(6)", { hasText: "—" }) }).first();
  await expect(target, "발송 전 결제 완료 주문이 없습니다. 이전 실행이 환불로 모두 썼습니다. 폐기용 DB를 새로 만들어 다시 돌려 주십시오").toBeVisible();
  return target;
}
const listResponse = (page: Page, has?: string) =>
  page.waitForResponse((r) => r.url().includes("/api/seller/orders?") && r.request().method() === "GET" && (!has || r.url().includes(has)));

test("주문 목록: 20건씩 보이고 「주문 더 불러오기」로 나머지를 이어서 불러온다", async ({ page }) => {
  const first = listResponse(page);
  await login(page);
  await first;
  await expect(page.getByRole("heading", { name: "주문" })).toBeVisible();
  await expect(page.getByText("결제 완료된 주문만 주문대기에 올라갑니다. 미결제 주문은 「결제 대기」로 표시됩니다.")).toBeVisible();
  await expect(rows(page)).toHaveCount(20);
  await expect(page.getByText("20건 넘게")).toBeVisible();
  // 메뉴 「주문」이 이 화면을 가리킨다
  await expect(page.getByRole("link", { name: "주문", exact: true })).toHaveAttribute("href", "/seller/orders");
  await shot(page, "SA-021");
  const next = listResponse(page, "cursor=");
  await page.getByRole("button", { name: "주문 더 불러오기" }).click();
  await next;
  // 다시 돌릴 때 앞선 실행의 실제 환불로 상태만 바뀔 뿐 건수는 같다
  await expect(rows(page)).toHaveCount(27);
  await expect(page.getByRole("button", { name: "주문 더 불러오기" })).toHaveCount(0);
});

test("상태 필터·검색·기간으로 걸러 보고, 결과가 없으면 알맞은 안내를 보여 준다", async ({ page }) => {
  await login(page);
  await expect(rows(page)).toHaveCount(20);
  // 상태: 환불됨만
  await page.getByRole("button", { name: /상태: 전체/ }).click();
  await page.getByRole("group", { name: "결제 상태" }).getByLabel("환불됨").check();
  const refunded = listResponse(page, "status=REFUNDED");
  await page.getByRole("button", { name: "적용" }).click();
  await refunded;
  // 응답 뒤 화면이 새 결과로 바뀐 다음에 센다(불러오는 동안은 행이 0개)
  await expect(rows(page).first().locator(".bdg").first()).toHaveText("환불됨");
  const n = await rows(page).count();
  expect(n).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < n; i++) await expect(rows(page).nth(i).locator(".bdg").first()).toHaveText("환불됨");
  await expect(page.getByRole("button", { name: /상태: 환불됨/ })).toBeVisible();
  await shot(page, "SA-021-filter");
  await page.getByRole("button", { name: "필터 초기화" }).first().click();
  await expect(rows(page)).toHaveCount(20);

  // 검색: 닉네임
  const searched = listResponse(page, `q=${encodeURIComponent("카드왕")}`);
  await page.getByLabel("주문 검색").fill("카드왕");
  await searched;
  await expect(rows(page).first().locator("td").nth(1)).toHaveText("카드왕");
  const m = await rows(page).count();
  expect(m).toBeGreaterThan(0);
  for (let i = 0; i < m; i++) await expect(rows(page).nth(i).locator("td").nth(1)).toHaveText("카드왕");

  // 기간 + 없는 검색어: 기간을 풀면 전체 기간에서 찾는다고 안내
  await page.getByRole("button", { name: "오늘", exact: true }).click();
  const none = listResponse(page, "q=");
  await page.getByLabel("주문 검색").fill("없는닉네임");
  await none;
  await expect(page.getByText("「없는닉네임」 검색 결과가 없습니다")).toBeVisible();
  await expect(page.getByText("기간 필터 「오늘」을 해제하면 전체 기간에서 찾습니다.")).toBeVisible();
  await page.getByRole("button", { name: "전체 기간에서 검색" }).click();
  await expect(page.getByText("조건에 맞는 주문이 없습니다")).toBeVisible();
});

test("주문 상세: 상품·결제·구매자·배송을 보여 주고, 없는 주문은 안내한다", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: /상태: 전체/ }).click();
  await page.getByRole("group", { name: "결제 상태" }).getByLabel("완료").check();
  await page.getByRole("button", { name: "적용" }).click();
  await expect(rows(page).first()).toBeVisible();
  const nick = (await rows(page).first().locator("td").nth(1).textContent())!;
  await rows(page).first().locator("a.ord-link").click();
  await expect(page).toHaveURL(/\/seller\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`${nick} · `);
  await expect(page.locator(".bdg-lg").first()).toHaveText("결제 완료");
  await expect(page.getByRole("heading", { name: "주문 상품" })).toBeVisible();
  await expect(page.getByText("결제 금액")).toBeVisible();
  // 구매자 카드는 실명 없이 회원 닉네임만, 받는 분 실명·연락처는 배송 카드에만(고객 정보 보기 권한이 있는 대표자)
  const buyerCard = page.locator("section", { has: page.getByRole("heading", { name: "구매자" }) });
  await expect(buyerCard.getByText("회원")).toBeVisible();
  await expect(buyerCard.getByText(/데모구매자/)).toHaveCount(0);
  await expect(buyerCard.getByText(/010-/)).toHaveCount(0);
  await expect(page.getByText("받는 분")).toBeVisible();
  await expect(page.getByRole("button", { name: "취소 · 환불" })).toBeVisible();
  await shot(page, "SA-022");

  await page.goto("/seller/orders/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("주문을 찾을 수 없습니다")).toBeVisible();
  await expect(page.getByRole("link", { name: "주문 목록으로" })).toBeVisible();
});

test("환불 모달: 사유 주체를 고르지 않으면 환불할 수 없고, 구매자 사정을 고르면 fault=BUYER로 보낸다", async ({ page }) => {
  await login(page);
  // 서버 환불은 흉내 내 요청 본문만 확인한다(실제 환불은 아래 테스트에서 한 번)
  let body: Record<string, unknown> | null = null;
  await page.route(/\/api\/seller\/orders\/[0-9a-f-]{36}\/refund$/, async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ refundAmount: 1000, version: 1 }) });
  });
  await page.goto(`/seller/orders/${await refundableOrderIdInDb("demo-shop", "CARD")}?refund=1`);
  const dialog = page.getByRole("dialog", { name: "취소 · 환불 처리" });
  await expect(dialog).toBeVisible();
  const run = dialog.getByRole("button", { name: /환불 실행/ });
  await expect(run).toBeDisabled();
  await dialog.getByLabel("처리 사유").selectOption("결제 오류 · 중복 결제");
  const agree = dialog.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.");
  await agree.check();
  // 사유 주체를 아직 고르지 않았다
  await expect(run).toBeDisabled();
  await expect(dialog.getByText("구매자 사정만 결제 후 취소 횟수에 포함됩니다 · 선택하지 않으면 환불할 수 없습니다")).toBeVisible();
  await dialog.getByRole("radio", { name: /구매자 사정/ }).check();
  await expect(dialog.getByText("이 취소는 구매자의 결제 후 취소 횟수에 포함됩니다")).toBeVisible();
  // 사유 주체를 고르면 금액이 바뀔 수 있어 금액 확인을 다시 받는다
  await expect(agree).not.toBeChecked();
  await expect(run).toBeDisabled();
  await agree.check();
  await expect(run).toBeEnabled();
  await shot(page, "SA-023");
  await run.click();
  await expect(page.getByText("1,000원 환불을 완료했습니다")).toBeVisible();
  expect(body).toMatchObject({ fault: "BUYER", reason: "결제 오류 · 중복 결제", confirmOpened: false });
  expect(Number.isInteger((body as unknown as { expectedVersion: number }).expectedVersion)).toBe(true);
});

test("환불 모달: 개봉한 상품이 있으면 사유 주체를 바꿀 때마다 실제 환불 금액과 뺀 항목을 다시 보여 주고, 다 개봉했으면 「환불할 금액이 없어요」", async ({ page }) => {
  // dev-seed: 2번(카드왕, 스타라이트 1박스 189,000원 개봉 + 문라이트 컬렉션 1박스 132,000원, 배송비 3,000원, 발송함, 반품 배송비 3,000원)
  //           1번(민트컨디션, 스타라이트 낱개 1팩 ×2 = 12,000원 개봉, 배송비 3,000원, 발송함)
  const openOrder = async (has: (r: ReturnType<typeof rows>) => ReturnType<typeof rows>) => {
    await page.goto("/seller/orders");
    await page.getByRole("button", { name: "주문 더 불러오기" }).click();
    await has(rows(page)).getByRole("link", { name: "환불 처리" }).click();
    const dialog = page.getByRole("dialog", { name: "취소 · 환불 처리" });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const kv = (dialog: ReturnType<Page["getByRole"]>, label: string) => dialog.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
  await login(page);

  let dialog = await openOrder((r) => r.filter({ hasText: "외 1건" }).filter({ hasText: "카드왕" }));
  const amount = dialog.getByTestId("refund-amount");
  const agree = dialog.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.");
  const run = dialog.getByRole("button", { name: /환불 실행/ });
  // 사유 주체에 따라 금액이 달라서 고르기 전에는 금액을 단정하지 않는다. 개봉 확인은 처음부터 받는다
  await expect(amount).toHaveText("사유 주체를 선택하면 표시됩니다");
  await expect(dialog.getByLabel("개봉한 상품이 있는 것을 확인했습니다")).toBeVisible();
  await dialog.getByRole("radio", { name: /구매자 사정/ }).check();
  await expect(amount).toHaveText("129,000원");
  await expect(kv(dialog, "개봉한 상품 · 스타라이트 부스터 박스")).toHaveText("−189,000원");
  await expect(kv(dialog, "처음 배송비")).toHaveText("−3,000원");
  await expect(kv(dialog, "반품 배송비")).toHaveText("−3,000원");
  await expect(run).toHaveText("129,000원 환불 실행");
  await dialog.getByLabel("처리 사유").selectOption("기타");
  await dialog.getByLabel("개봉한 상품이 있는 것을 확인했습니다").check();
  await agree.check();
  await expect(run).toBeEnabled();
  await shot(page, "SA-023-opened");
  // 판매자 사정으로 바꾸면 개봉한 상품·배송비까지 모두 돌려주고, 금액 확인을 다시 받는다
  await dialog.getByRole("radio", { name: /파트너스 사정/ }).check();
  await expect(amount).toHaveText("324,000원");
  await expect(dialog.locator("dt", { hasText: "반품 배송비" })).toHaveCount(0);
  await expect(dialog.locator("dt", { hasText: "개봉한 상품" })).toHaveCount(0);
  await expect(agree).not.toBeChecked();
  await expect(run).toBeDisabled();
  await expect(run).toHaveText("324,000원 환불 실행");
  await dialog.getByRole("button", { name: "취소", exact: true }).click();

  // 하나뿐인 상품을 개봉했으면 구매자 사정으로는 돌려줄 금액이 0원이라 환불 버튼 대신 안내만 보인다
  dialog = await openOrder((r) => r.filter({ hasText: "민트컨디션" }).filter({ hasText: "15,000원" }));
  await dialog.getByRole("radio", { name: /구매자 사정/ }).check();
  await expect(dialog.getByTestId("refund-amount")).toHaveText("0원");
  await expect(dialog.getByText("환불할 금액이 없습니다")).toBeVisible();
  await expect(kv(dialog, "개봉한 상품 · 스타라이트 부스터 박스")).toHaveText("−12,000원");
  await expect(dialog.getByRole("button", { name: /환불 실행/ })).toHaveCount(0);
  await expect(dialog.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.")).toHaveCount(0);
  await shot(page, "SA-023-nothing");
  await dialog.getByRole("radio", { name: /파트너스 사정/ }).check();
  await expect(dialog.getByTestId("refund-amount")).toHaveText("15,000원");
  await expect(dialog.getByText("환불할 금액이 없습니다")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /환불 실행/ })).toHaveText("15,000원 환불 실행");
});

test("환불 모달: 확인한 금액을 함께 보내고, 그사이 금액이 바뀌었다는 응답(refund_amount_changed)이면 새 금액을 보여 주고 다시 확인받는다", async ({ page }) => {
  await login(page);
  // 환불은 흉내 낸다. 첫 요청은 「금액이 바뀌었어요」, 그 뒤 상세는 구매자 사정 금액을 120,000원으로 바꿔 돌려준다
  const bodies: Record<string, unknown>[] = [];
  let changed = false;
  await page.route(/\/api\/seller\/orders\/[0-9a-f-]{36}\/refund$/, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      changed = true;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "refund_amount_changed" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ refundAmount: 120000, version: 1 }) });
  });
  await page.route(/\/api\/seller\/orders\/[0-9a-f-]{36}$/, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    if (changed && json.refundPreview) json.refundPreview.byFault.BUYER.refundAmount = 120000;
    await route.fulfill({ response: res, json });
  });
  await page.getByRole("button", { name: "주문 더 불러오기" }).click();
  await rows(page).filter({ hasText: "외 1건" }).filter({ hasText: "카드왕" }).getByRole("link", { name: "환불 처리" }).click();
  const dialog = page.getByRole("dialog", { name: "취소 · 환불 처리" });
  const agree = dialog.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.");
  const run = dialog.getByRole("button", { name: /환불 실행/ });
  await dialog.getByRole("radio", { name: /구매자 사정/ }).check();
  await dialog.getByLabel("처리 사유").selectOption("기타");
  await dialog.getByLabel("개봉한 상품이 있는 것을 확인했습니다").check();
  await agree.check();
  await expect(run).toHaveText("129,000원 환불 실행");
  await run.click();
  await expect(dialog.getByRole("alert")).toHaveText("그사이 환불 금액이 변경되었습니다. 금액을 다시 확인해 주십시오");
  await expect(dialog.getByTestId("refund-amount")).toHaveText("120,000원");
  await expect(agree).not.toBeChecked();
  await expect(run).toBeDisabled();
  await agree.check();
  await expect(run).toHaveText("120,000원 환불 실행");
  await run.click();
  await expect(page.getByText("120,000원 환불을 완료했습니다")).toBeVisible();
  expect(bodies.map((b) => b.expectedRefundAmount)).toEqual([129000, 120000]);
  // 환불 뒤 상세를 다시 읽는 요청이 아직 route.fetch 중일 수 있다. 테스트가 끝나 페이지가 닫히면 그 콜백이 오류를 내므로 라우트를 정리한다
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("실제 환불: 판매자 사정으로 환불하면 완료 알림이 뜨고 주문이 환불됨으로 바뀐다", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: /상태: 전체/ }).click();
  await page.getByRole("group", { name: "결제 상태" }).getByLabel("완료").check();
  await page.getByRole("button", { name: "적용" }).click();
  await expect(rows(page).first()).toBeVisible();
  // 발송 전 주문(배송 「—」)을 고른다
  const target = await preShipTarget(page);
  await target.getByRole("link", { name: "환불 처리" }).click();
  const dialog = page.getByRole("dialog", { name: "취소 · 환불 처리" });
  await dialog.getByRole("radio", { name: /파트너스 사정/ }).check();
  await dialog.getByLabel("처리 사유").selectOption("품절 · 재고 없음");
  await dialog.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.").check();
  const refund = page.waitForResponse((r) => r.url().endsWith("/refund") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: /환불 실행/ }).click();
  expect((await refund).status()).toBe(200);
  await expect(page.getByText(/원 환불을 완료했습니다/)).toBeVisible();
  await expect(page.locator(".bdg-lg").first()).toHaveText("환불됨");
  await expect(page.getByText("파트너스 사정")).toBeVisible();
  await expect(page.getByRole("button", { name: "취소 · 환불" })).toHaveCount(0);
  await shot(page, "SA-022-refunded");
});

test("주문·배송 권한이 없는 직원은 메뉴에 주문이 없고, 주소로 들어오면 권한 안내를 본다", async ({ page }) => {
  await login(page, "demo-staff@example.com", "/seller/products");
  await expect(page.getByRole("link", { name: "주문", exact: true })).toHaveCount(0);
  await page.goto("/seller/orders");
  await expect(page.getByText("이 계정은 이 일을 할 수 없습니다")).toBeVisible();
  await expect(page.getByText("필요한 권한: 주문·배송")).toBeVisible();
});

test("환불 모달: 결제 수단이 카드면 「카드 승인 취소」를 보여 주고, 실패하면 「다시 시도」로 다시 보내며, 권한 오류는 두 줄로 알린다", async ({ page }) => {
  await login(page);
  let calls = 0;
  await page.route(/\/api\/seller\/orders\/[0-9a-f-]{36}\/refund$/, (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    if (calls === 2) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ refundAmount: 2000, version: 1 }) });
  });
  // 카드 결제 주문(발송 전·개봉 전 최근 건 — 앞선 시험이 남긴 주문에 좌우되지 않게 DB에서 고른다)
  await page.goto(`/seller/orders/${await refundableOrderIdInDb("demo-shop", "CARD")}?refund=1`);
  const dialog = page.getByRole("dialog", { name: "취소 · 환불 처리" });
  await expect(dialog.locator(".refund-opt.on").first()).toContainText("카드 승인 취소");
  await dialog.getByRole("radio", { name: /파트너스 사정/ }).check();
  // 사유 주체를 고르면 실제 환불액이 카드 승인 취소 금액으로 보인다
  await expect(dialog.locator(".refund-opt.on").first()).toContainText(/\d원 · 카드 승인 취소$/);
  await dialog.getByLabel("처리 사유").selectOption("기타");
  await dialog.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.").check();
  await dialog.getByRole("button", { name: /환불 실행/ }).click();
  await expect(dialog.getByRole("alert")).toHaveText("환불하지 못했습니다. 결제는 그대로입니다. 잠시 후 다시 시도해 주십시오.");
  await dialog.getByRole("button", { name: "다시 시도" }).click();
  await expect(dialog.getByRole("alert")).toContainText("이 계정은 이 일을 할 수 없습니다");
  await expect(dialog.getByRole("alert")).toContainText("대표자에게 허용해 달라고 요청해 주십시오 · 필요한 권한: 주문·배송");
  await dialog.getByRole("button", { name: /환불 실행/ }).click();
  await expect(page.getByText("2,000원 환불을 완료했습니다")).toBeVisible();
  expect(calls).toBe(3);
});

test("주문·배송 권한만 있는 직원(방송 진행 권한 없음)도 실제로 환불할 수 있다", async ({ page }) => {
  await login(page, "demo-viewer@example.com");
  await page.getByRole("button", { name: /상태: 전체/ }).click();
  await page.getByRole("group", { name: "결제 상태" }).getByLabel("완료").check();
  await page.getByRole("button", { name: "적용" }).click();
  await expect(rows(page).first().locator(".bdg").first()).toHaveText("완료");
  const target = await preShipTarget(page);
  await target.getByRole("link", { name: "환불 처리" }).click();
  const dialog = page.getByRole("dialog", { name: "취소 · 환불 처리" });
  await dialog.getByRole("radio", { name: /파트너스 사정/ }).check();
  await dialog.getByLabel("처리 사유").selectOption("품절 · 재고 없음");
  await dialog.getByLabel("위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.").check();
  const refund = page.waitForResponse((r) => r.url().endsWith("/refund") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: /환불 실행/ }).click();
  expect((await refund).status()).toBe(200);
  await expect(page.getByText(/원 환불을 완료했습니다/)).toBeVisible();
  await expect(page.locator(".bdg-lg").first()).toHaveText("환불됨");
});

test("발송한 주문의 송장은 택배사 코드가 아니라 화면 이름(CJ대한통운)으로 보인다", async ({ page }) => {
  await login(page);
  const shipped = rows(page).filter({ has: page.locator("td:nth-child(6)", { hasText: "발송함" }) }).first();
  await shipped.locator("a.ord-link").click();
  await expect(page).toHaveURL(/\/seller\/orders\/[0-9a-f-]{36}$/);
  const dd = page.locator("dt", { hasText: "송장" }).locator("xpath=following-sibling::dd[1]");
  await expect(dd).toHaveText(/^CJ대한통운 \d+$/);
});
