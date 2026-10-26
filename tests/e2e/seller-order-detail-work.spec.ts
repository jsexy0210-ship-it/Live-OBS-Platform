import { expect, test, type Page } from "@playwright/test";
import { submitSellerLogin } from "./sellerLogin";

// 소유한 합성 주문 응답만 사용한다. 주문 변경·메모 저장은 mock 밖으로 보내지 않는다.
const ids = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000c3"];
async function login(page: Page) {
  await page.goto("/seller/login");
  await submitSellerLogin(page, "demo-owner@example.com", process.env.E2E_PASSWORD ?? "");
  await expect(page).toHaveURL(/\/seller$/);
}
async function fixture(page: Page, missingIds: string[] = [], status = "PAID") {
  const posts: unknown[] = [], memoWrites: unknown[] = [], summaryReads: string[][] = [], fullReads: string[] = [];
  let memo = "", prepared = false;
  const order = (id: string) => ({ id, orderNo: ids.indexOf(id) + 1, orderNoLabel: `20261019-000${ids.indexOf(id) + 1}`, status, broadcastNicknameSnapshot: `선택 주문 ${ids.indexOf(id) + 1}`, createdAt: "2026-10-19T00:00:00Z", paidAt: status === "PAID" ? "2026-10-19T00:00:00Z" : null, cancelledAt: null, refundedAt: null, totalAmount: 1000, rewardUsedAmount: 0, shippingFee: 0, paymentMethod: "CARD", refundAmount: null, refundFault: null, returnFeeDeducted: null, items: [], shipment: null, shippingAddress: null, buyer: { id, broadcastNickname: `선택 주문 ${ids.indexOf(id) + 1}` }, queueState: id === ids[2] ? "waiting" : "done", shippingPreparedAt: prepared && id !== ids[2] ? "2026-10-19T01:00:00Z" : null, queueVersion: 1, refundPreview: null, history: [], couponRedemption: null });
  await page.route("**/api/seller/orders**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/seller/orders/bulk") {
      const body = request.postDataJSON(); posts.push(body); prepared = true;
      return route.fulfill({ json: { prepared: body.orderIds.length, results: body.orderIds.map((orderId: string) => ({ orderId, ok: true })) } });
    }
    const memoId = ids.find((id) => path === `/api/seller/orders/${id}/memo`);
    if (memoId) {
      if (request.method() === "PUT") { memoWrites.push(request.postDataJSON()); memo = request.postDataJSON().body; }
      else expect(request.method()).toBe("GET");
      return route.fulfill({ json: { memo: memo ? { body: memo } : null } });
    }
    expect(request.method()).toBe("GET");
    const query = new URL(request.url()).searchParams;
    if (path === "/api/seller/orders" && query.get("summary") === "prepare") {
      const requested = query.get("ids")!.split(","); summaryReads.push(requested);
      const found = requested.filter((id) => ids.includes(id) && !missingIds.includes(id));
      return route.fulfill({ json: { orders: found.map((id) => { const row = order(id); return { id, orderNoLabel: row.orderNoLabel, buyer: { broadcastNickname: row.buyer.broadcastNickname }, shippingPreparedAt: row.shippingPreparedAt }; }), missing: requested.length - found.length } });
    }
    if (path === "/api/seller/orders/counts") return route.fulfill({ json: { counts: { total: 3, today: 3, unpaid: 0, trackingMissing: 3, queueWaiting: 1, queueDone: 2, queueDonePending: 2, refundRequested: 0 } } });
    if (path === "/api/seller/orders") return route.fulfill({ json: { orders: ids.map((id) => ({ ...order(id), itemSummary: { firstProductName: "합성 상품", otherCount: 0 }, shipped: false, refundable: true, refundedAmount: 0, refundedQuantity: 0, remainingAmount: 1000 })), nextCursor: null } });
    const id = ids.find((id) => path === `/api/seller/orders/${id}`);
    if (id) fullReads.push(id);
    if (id && !missingIds.includes(id)) return route.fulfill({ json: order(id) });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return { posts, memoWrites, summaryReads, fullReads };
}

test("주문 목록은 변경 요청 없이 실제 상세로 이동하고, 선택 배송 준비는 정확한 두 주문만 변경한다", async ({ page }) => {
  await login(page);
  const owned = await fixture(page);
  await page.goto("/seller/orders?period=all");
  const rows = page.getByTestId("order-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.getByRole("button", { name: "배송 준비", exact: true })).toHaveCount(0);
  await expect(rows.first().getByRole("link", { name: "배송 준비", exact: true })).toHaveAttribute("href", `/seller/orders/${ids[0]}?${new URLSearchParams({ returnTo: "/seller/orders?period=all" })}#order-preparation`);
  await rows.nth(0).getByRole("checkbox").check();
  await rows.nth(1).getByRole("checkbox").check();
  await expect(rows.nth(2).getByRole("checkbox")).toBeDisabled();
  const link = page.getByRole("link", { name: "선택 주문 작업 상세", exact: true });
  await expect(link).toHaveAttribute("href", `/seller/orders/prepare?${new URLSearchParams({ ids: ids.slice(0, 2).join(","), returnTo: "/seller/orders?period=all" })}`);
  expect(owned.posts).toEqual([]);
  await link.click();
  await expect(page).toHaveURL(`/seller/orders/prepare?${new URLSearchParams({ ids: ids.slice(0, 2).join(","), returnTo: "/seller/orders?period=all" })}`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "선택 주문 배송 준비", exact: true })).toBeVisible();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "20261019-0003", exact: true })).toHaveCount(0);
  expect(owned.summaryReads.length).toBeGreaterThan(0);
  expect(owned.summaryReads.every((requested) => JSON.stringify(requested) === JSON.stringify(ids.slice(0, 2)))).toBe(true);
  expect(owned.fullReads).toEqual([]);
  await page.getByRole("button", { name: "배송 준비로 변경", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "2건을 배송 준비로 바꿨습니다" })).toBeVisible();
  expect(owned.posts).toEqual([{ action: "prepare_shipping", orderIds: ids.slice(0, 2) }]);
  expect(owned.memoWrites).toEqual([]);
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(new URL("/seller/orders?period=all", page.url()).href);
});

test("주문 메모는 실제 상세에서만 저장하고 새로고침 후 보존하며 빈 본문으로 삭제한다", async ({ page }) => {
  await login(page);
  const owned = await fixture(page);
  await page.goto("/seller/orders?period=all");
  await page.getByTestId("order-row").first().getByRole("button", { name: /더보기/ }).click();
  const link = page.getByRole("menuitem", { name: "메모 남기기", exact: true });
  await expect(link).toHaveAttribute("href", `/seller/orders/${ids[0]}?${new URLSearchParams({ returnTo: "/seller/orders?period=all" })}#order-memo`);
  await link.click();
  await expect(page).toHaveURL(new URL(`/seller/orders/${ids[0]}?${new URLSearchParams({ returnTo: "/seller/orders?period=all" })}#order-memo`, page.url()).href);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const memo = page.getByRole("region", { name: "메모 남기기", exact: true });
  await expect(memo.getByRole("textbox", { name: "메모", exact: true })).toBeEnabled();
  await memo.getByRole("textbox", { name: "메모", exact: true }).fill("선물 포장 요청 확인");
  await memo.getByRole("button", { name: "저장", exact: true }).click();
  await expect(memo.getByRole("status")).toHaveText("메모를 저장했습니다");
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(new URL("/seller/orders?period=all", page.url()).href);
  await page.getByTestId("order-row").first().getByRole("button", { name: /더보기/ }).click();
  await expect(link).toHaveAttribute("href", `/seller/orders/${ids[0]}?${new URLSearchParams({ returnTo: "/seller/orders?period=all" })}#order-memo`);
  await link.click();
  await expect(page).toHaveURL(`/seller/orders/${ids[0]}?${new URLSearchParams({ returnTo: "/seller/orders?period=all" })}#order-memo`);
  await page.reload();
  await expect(memo.getByRole("textbox", { name: "메모", exact: true })).toHaveValue("선물 포장 요청 확인");
  await memo.getByRole("textbox", { name: "메모", exact: true }).fill("");
  await memo.getByRole("button", { name: "저장", exact: true }).click();
  await expect(memo.getByRole("status")).toHaveText("메모를 지웠습니다");
  await page.reload();
  await expect(memo.getByRole("textbox", { name: "메모", exact: true })).toHaveValue("");
  await memo.getByRole("textbox", { name: "메모", exact: true }).fill("머리글에서 버릴 입력");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(memo.getByRole("textbox", { name: "메모", exact: true })).toHaveValue("머리글에서 버릴 입력");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(new URL("/seller/orders?period=all", page.url()).href);
  await page.getByTestId("order-row").first().getByRole("button", { name: /더보기/ }).click();
  await expect(link).toHaveAttribute("href", `/seller/orders/${ids[0]}?${new URLSearchParams({ returnTo: "/seller/orders?period=all" })}#order-memo`);
  await link.click();
  await expect(page).toHaveURL(`/seller/orders/${ids[0]}?${new URLSearchParams({ returnTo: "/seller/orders?period=all" })}#order-memo`);
  await page.reload();
  await expect(memo.getByRole("textbox", { name: "메모", exact: true })).toHaveValue("");
  await memo.getByRole("textbox", { name: "메모", exact: true }).fill("버릴 입력");
  page.once("dialog", (dialog) => dialog.accept());
  await memo.getByRole("button", { name: "취소", exact: true }).click();
  await expect(memo.getByRole("textbox", { name: "메모", exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(new URL("/seller/orders?period=all", page.url()).href);
  expect(owned.memoWrites).toEqual([{ body: "선물 포장 요청 확인" }, { body: "" }]);
  expect(owned.posts).toEqual([]);
});

test("읽기 전용에서는 선택 주문 작업의 조회와 변경을 보내지 않는다", async ({ page }) => {
  await login(page);
  await page.route("**/api/seller/me", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), isOwner: false, permissions: ["ORDER_SHIPPING"], readOnly: true } });
  });
  const requests: string[] = [];
  await page.route("**/api/seller/orders**", async (route) => { requests.push(route.request().method()); await route.fulfill({ status: 403, json: { error: "forbidden" } }); });
  await page.goto(`/seller/orders/prepare?ids=${ids[0]}`);
  await expect(page.getByTestId("permission-card")).toBeVisible();
  await expect(page.getByRole("button", { name: "배송 준비로 변경", exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("선택 배송 준비는404만 제외해 남은 주문을 처리하고 유효 주문이 없으면 변경하지 않는다", async ({ page }) => {
  await login(page);
  const owned = await fixture(page, [ids[1]]);
  await page.goto(`/seller/orders/prepare?ids=${ids[0]},${ids[1]}`);
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "찾을 수 없는 주문 1건 · 남은 주문 1건" })).toBeVisible();
  await page.getByRole("button", { name: "배송 준비로 변경", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "1건을 배송 준비로 바꿨습니다" })).toBeVisible();
  expect(owned.posts).toEqual([{ action: "prepare_shipping", orderIds: [ids[0]] }]);
  await page.goto(`/seller/orders/prepare?ids=${ids[1]}`);
  await expect(page.getByRole("button", { name: "배송 준비로 변경", exact: true })).toBeDisabled();
  expect(owned.posts).toHaveLength(1);
});

test("선택 배송 준비는100개를 한 요약 요청으로 읽고 조회 오류를 빈 성공으로 바꾸지 않는다", async ({ page }) => {
  await login(page);
  const selected = Array.from({ length: 100 }, (_, n) => `a2222222-2222-4222-8222-${String(n).padStart(12, "0")}`);
  const reads: string[][] = [], otherRequests: string[] = [];
  let failure = 503;
  await page.route("**/api/seller/orders**", (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.pathname !== "/api/seller/orders" || url.searchParams.get("summary") !== "prepare") {
      otherRequests.push(`${route.request().method()} ${url.pathname}`);
      return route.fulfill({ status: 500, json: { error: "unexpected_request" } });
    }
    const requested = url.searchParams.get("ids")!.split(","); reads.push(requested);
    if (failure) return route.fulfill({ status: failure, json: { error: "owned_failure" } });
    return route.fulfill({ json: { orders: requested.map((id, n) => ({ id, orderNoLabel: `20261021-${String(n + 1).padStart(4, "0")}`, buyer: { broadcastNickname: `검토 ${n + 1}` }, shippingPreparedAt: null })), missing: 0 } });
  });
  await page.goto(`/seller/orders/prepare?${new URLSearchParams({ ids: [...selected, selected[0].toUpperCase()].join(",") })}`);
  await expect(page.getByText("선택한 주문을 불러오지 못했습니다", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "배송 준비로 변경", exact: true })).toHaveCount(0);
  expect(reads).toEqual([selected]);
  failure = 0;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(100);
  expect(reads).toEqual([selected, selected]);
  expect(otherRequests).toEqual([]);
  failure = 403;
  await page.reload();
  await expect(page.getByTestId("permission-card")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "배송 준비로 변경", exact: true })).toHaveCount(0);
  expect(otherRequests).toEqual([]);
});

test("선택 입금 확인은404만 제외하고 남은 주문과 상세 버전만 전송한다", async ({ page }) => {
  await login(page);
  await fixture(page, [ids[1]], "PENDING_PAYMENT");
  const writes: unknown[] = [];
  await page.route("**/api/seller/queue/version", (route) => route.fulfill({ json: { version: 77 } }));
  await page.route("**/api/seller/payments/deposits/confirm", (route) => {
    const body = route.request().postDataJSON(); writes.push(body);
    return route.fulfill({ json: { results: body.orderIds.map((orderId: string) => ({ orderId, result: "paid" })) } });
  });
  await page.goto(`/seller/orders/deposits/confirm?${new URLSearchParams({ ids: ids.slice(0, 2).join(","), returnTo: "/seller/orders/deposits?q=입금" })}`);
  await page.reload();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "찾을 수 없는 주문 1건 · 남은 주문 1건" })).toBeVisible();
  await page.getByRole("region", { name: "입금을 확인하시겠습니까?" }).getByRole("button", { name: "입금 확인", exact: true }).click();
  await expect(page.getByText("1건 입금 확인 · 주문대기(방송에서 개봉할 순서 목록)에 올라갔습니다", { exact: true })).toBeVisible();
  expect(writes).toEqual([{ orderIds: [ids[0]], expectedVersion: 77 }]);
  await page.getByRole("button", { name: "목록으로", exact: true }).click();
  await expect(page).toHaveURL(new URL("/seller/orders/deposits?q=%EC%9E%85%EA%B8%88", page.url()).href);
  await page.goto(`/seller/orders/deposits/confirm?ids=${ids[1]}`);
  await expect(page.getByRole("region", { name: "입금을 확인하시겠습니까?" }).getByRole("button", { name: "입금 확인", exact: true })).toBeDisabled();
  expect(writes).toHaveLength(1);
});
