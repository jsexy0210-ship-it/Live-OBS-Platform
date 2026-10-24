import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// SA-027 배송 처리: 발송 대기 주문에 송장을 저장하면 배송 중으로, 배송 완료 처리하면 배송 완료로 옮겨 가는지 실제 API로 확인한다.
// dev-seed 데모 주문 중 발송 대기 1건을 실행마다 배송 완료까지 보낸다(폐기용 DB). 발송 대기가 다 떨어지면 DB를 새로 만들고 dev-seed를 다시 돌린다.
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

const post = (page: Page, path: string) => page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(path));

test("대표자: 송장 저장 → 배송 중 → 배송 완료로 옮겨 가고, 잘못된 송장은 그 줄에만 실패를 알린다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fshipping");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/shipping$/);
  const menu = page.getByRole("complementary", { name: "파트너스 메뉴" });
  await expect(menu.locator("strong.lnb-parent").filter({ hasText: /^배송 · 송장$/ })).toBeVisible();
  await expect(menu.locator("a.lnb-sub-i").filter({ hasText: /^배송 준비$/ })).toHaveAttribute("href", "/seller/shipping");

  const rows = page.getByTestId("shipment-row");
  await expect(rows.first()).toBeVisible();
  const ready = await page.evaluate(async () => (await (await fetch("/api/seller/shipments?tab=ready&limit=200")).json()).shipments as { orderId: string; orderNo: number }[]);
  expect(ready.length, "발송 대기 주문이 없습니다. dev-seed를 새 DB에 다시 돌려 주십시오").toBeGreaterThan(1);
  const [a, b] = ready;
  await shot(page, "SA-027-shipping-ready");

  await expect(rows.locator("select, input:not([type=checkbox])")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "선택 배송 작업 상세", exact: true })).toBeDisabled();
  await page.getByLabel(`주문 ${a.orderNo} 선택`).check();
  await page.getByLabel(`주문 ${b.orderNo} 선택`).check();
  const work = page.getByRole("link", { name: "선택 배송 작업 상세 (2)", exact: true });
  expect(new URL(await work.getAttribute("href") ?? "", "http://localhost").searchParams.get("ids")?.split(",")).toEqual([a.orderId, b.orderId]);
  await work.click();
  await expect(page).toHaveURL(/\/seller\/shipping\/process\?/);
  await page.reload();
  await expect(page.getByRole("region", { name: "배송 처리 상세", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // a는 올바른 송장, b는 너무 짧은 송장 → a만 저장되고 b 줄에 실패 사유가 남는다
  const tracking = `E2E${Date.now()}`;
  // 일괄로 한진택배를 고른 뒤 a 줄만 롯데택배로 바꾼다
  await page.getByLabel("택배사 일괄 선택").selectOption("HANJIN");
  await expect(page.getByLabel(`주문 ${b.orderNo} 택배사`)).toHaveValue("HANJIN");
  await page.getByLabel(`주문 ${a.orderNo} 택배사`).selectOption("LOTTE");
  await page.getByLabel(`주문 ${a.orderNo} 송장번호`).fill(tracking);
  await page.getByLabel(`주문 ${b.orderNo} 송장번호`).fill("12");
  const shipped = post(page, "/api/seller/shipments");
  await page.getByRole("button", { name: "송장 저장 (2)" }).click();
  await page.getByRole("button", { name: "송장 저장", exact: true }).click();
  const shippedRes = await shipped;
  const sent = shippedRes.request().postDataJSON().items as { orderId: string; courier: string }[];
  expect(sent.find((x) => x.orderId === a.orderId)?.courier).toBe("LOTTE");
  expect(sent.find((x) => x.orderId === b.orderId)?.courier).toBe("HANJIN");
  const results = (await shippedRes.json()).results as { orderId: string; ok: boolean }[];
  expect(results.find((r) => r.orderId === a.orderId)?.ok).toBe(true);
  expect(results.find((r) => r.orderId === b.orderId)?.ok).toBe(false);
  await expect(page.getByText("1건 송장 저장 · 1건은 처리하지 못했습니다. 빨간 글씨를 확인해 주십시오")).toBeVisible();
  await expect(page.getByLabel(`주문 ${a.orderNo} 송장번호`)).toHaveCount(0);
  await expect(page.locator("section.au-fs").filter({ has: page.getByLabel(`주문 ${b.orderNo} 송장번호`) })).toContainText("송장번호");
  await expect(page.locator(".err[role=alert]")).toHaveCount(1);

  // 부분 실패 입력은 남아 있으므로 확인 후 버리고 원래 목록으로 복귀한다.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(/\/seller\/shipping$/);
  // 배송 중 탭에서 찾아 배송 완료 처리
  await page.getByRole("button", { name: "배송 중", exact: true }).click();
  await page.getByLabel("배송 검색").fill(tracking);
  const row = rows.filter({ hasText: tracking });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("롯데택배");
  await shot(page, "SA-027-shipping-in-transit");
  await row.getByRole("checkbox").check();
  await page.getByRole("link", { name: "선택 배송 작업 상세 (1)", exact: true }).click();
  await expect(page.getByRole("region", { name: "배송 처리 상세", exact: true })).toContainText(tracking);
  const delivered = post(page, "/api/seller/shipments/deliver");
  await page.getByRole("button", { name: "배송 완료 처리 (1)" }).click();
  await page.getByRole("button", { name: "배송 완료로 바꾸기", exact: true }).click();
  expect((await delivered).status()).toBe(200);
  await expect(page.getByText("1건 배송 완료")).toBeVisible();
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page.getByLabel("배송 검색")).toHaveValue(tracking);
  await expect(row).toHaveCount(0);

  await page.getByRole("button", { name: "배송 완료", exact: true }).click();
  await expect(rows.filter({ hasText: tracking })).toHaveCount(1);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await shot(page, "SA-027-shipping-delivered");
});

test("주문·배송 권한이 없는 직원은 메뉴가 안 보이고, 주소로 들어와도 권한 안내를 본다", async ({ page }) => {
  await page.goto("/seller/login?next=%2Fseller%2Fshipping");
  await submitSellerLogin(page, "demo-staff@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/shipping$/);
  await expect(page.getByText("필요한 권한: 주문·배송", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "배송 · 송장", exact: true })).toHaveCount(0);
});

test("배송 작업 상세는 삭제된 선택만 제외하며 조회 오류와 읽기 전용에서는 전송하지 않는다", async ({ page }) => {
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller$/);
  const ids = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b2"];
  const writes: unknown[] = [];
  let failure = 404;
  await page.route("**/api/seller/orders/**", async (route) => {
    expect(route.request().method()).toBe("GET");
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    return id === ids[0] ? route.fulfill({ json: { id, orderNo: 1, orderNoLabel: "합성 주문 1", status: "PAID", shipment: null, shippingAddress: { isRemote: false }, buyer: { broadcastNickname: "배송 합성" } } }) : route.fulfill({ status: failure, json: { error: failure === 404 ? "not_found" : "server_error" } });
  });
  await page.route("**/api/seller/shipments**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { shipments: [], nextCursor: null } });
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON(); writes.push(body);
    return route.fulfill({ json: { results: body.items.map((item: { orderId: string }) => ({ orderId: item.orderId, ok: true })) } });
  });
  const work = `/seller/shipping/process?${new URLSearchParams({ ids: [ids[0], ids[0].toUpperCase(), ids[1]].join(","), action: "ship", returnTo: "/seller/shipping?tab=ready&q=배송" })}`;
  await page.goto(work);
  await page.reload();
  const detail = page.getByRole("region", { name: "배송 처리 상세", exact: true });
  await expect(detail.getByRole("status")).toHaveText("찾을 수 없는 주문 1건 · 남은 주문 1건");
  await expect(detail.locator("section.au-fs")).toHaveCount(1);
  await detail.getByRole("textbox", { name: "주문 1 송장번호", exact: true }).fill("OWNED123456");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(work);
  await expect(detail.getByRole("textbox", { name: "주문 1 송장번호", exact: true })).toHaveValue("OWNED123456");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(new URL("/seller/shipping?tab=ready&q=%EB%B0%B0%EC%86%A1", page.url()).href);
  expect(writes).toEqual([]);
  await page.goto(work);
  await detail.getByRole("textbox", { name: "주문 1 송장번호", exact: true }).fill("OWNED123456");
  await detail.getByRole("button", { name: "송장 저장 (1)", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "송장 저장", exact: true }).click();
  await expect(detail.locator("section.au-fs")).toHaveCount(0);
  expect(writes).toEqual([{ items: [{ orderId: ids[0], courier: "CJ", trackingNumber: "OWNED123456" }] }]);
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(new URL("/seller/shipping?tab=ready&q=%EB%B0%B0%EC%86%A1", page.url()).href);
  failure = 500;
  await page.goto(work);
  await expect(page.getByText("선택한 주문을 불러오지 못했습니다", { exact: true })).toBeVisible();
  await expect(detail).toHaveCount(0);
  expect(writes).toHaveLength(1);
  await page.route("**/api/seller/me", async (route) => {
    const response = await route.fetch();
    const me = await response.json();
    await route.fulfill({ response, json: { ...me, isOwner: false, permissions: ["ORDER_SHIPPING"], readOnly: true } });
  });
  await page.goto(`/seller/shipping/${ids[0]}`);
  await expect(detail).toBeVisible();
  await expect(detail.locator("input, select, button")).toHaveCount(0);
  expect(writes).toHaveLength(1);
});
