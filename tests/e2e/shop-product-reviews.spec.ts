import { expect, test } from "@playwright/test";

// IA ④ 상품 상세 리뷰: 요약(평균·분포·사진 리뷰 수)·목록·더 보기·빈 상태·오류 재시도.
// 데모 시드에는 공개 리뷰가 없어서 빈 상태는 실제 응답으로, 나머지는 같은 모양의 응답을 끼워 넣어(page.route) 화면만 확인한다.
const SLUG = "demo-shop";

const review = (id: string, over: object = {}) => ({
  id,
  author: "별빛**",
  rating: 5,
  body: `리뷰 본문 ${id}`,
  optionName: "1팩",
  images: [],
  reply: null,
  repliedAt: null,
  createdAt: "2026-10-04T15:30:00.000Z", // KST 10/05 00:30
  ...over,
});

async function productId(page: import("@playwright/test").Page) {
  const list = (await (await page.request.get(`/api/shop/${SLUG}/products`)).json()) as { products: { id: string; name: string }[] };
  return list.products.find((p) => p.name === "탑로더 25장")!.id;
}

test("리뷰가 없으면 빈 상태 안내(실제 응답)", async ({ page }) => {
  await page.goto(`/shop/${SLUG}/products/${await productId(page)}`);
  const sec = page.getByRole("region", { name: /^리뷰/ });
  await expect(sec.getByText("아직 리뷰가 없어요")).toBeVisible();
});

test("요약·목록·사진·판매자 답글·더 보기", async ({ page }) => {
  const id = await productId(page);
  let calls = 0;
  await page.route(`**/api/shop/${SLUG}/products/${id}/reviews**`, async (route) => {
    calls++;
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const body = cursor
      ? { average: 4.5, total: 3, photoCount: 1, distribution: [{ rating: 5, count: 2 }, { rating: 4, count: 0 }, { rating: 3, count: 0 }, { rating: 2, count: 1 }, { rating: 1, count: 0 }], reviews: [review("r3", { rating: 2, body: "아쉬워요" })], nextCursor: null }
      : {
          average: 4.5,
          total: 3,
          photoCount: 1,
          distribution: [{ rating: 5, count: 2 }, { rating: 4, count: 0 }, { rating: 3, count: 0 }, { rating: 2, count: 1 }, { rating: 1, count: 0 }],
          reviews: [review("r1", { images: [{ id: "i1", width: 10, height: 10, url: "/api/shop/demo-shop/reviews/public-images/none" }], reply: "감사합니다" }), review("r2")],
          nextCursor: "r2",
        };
    await route.fulfill({ json: body });
  });
  await page.goto(`/shop/${SLUG}/products/${id}`);
  const sec = page.getByRole("region", { name: /^리뷰/ });
  await expect(sec.getByRole("heading", { name: "리뷰 3" })).toBeVisible();
  await expect(sec.getByText("4.5", { exact: true })).toBeVisible();
  await expect(sec.getByText("사진 리뷰 1개")).toBeVisible();
  const dist = sec.getByRole("list", { name: "별점 분포" });
  await expect(dist.locator("li").first()).toContainText("5점");
  await expect(dist.locator("li").first()).toContainText("2");
  await expect(sec.getByText("리뷰 본문 r1")).toBeVisible();
  await expect(sec.getByText("2026.10.05").first()).toBeVisible(); // KST
  await expect(sec.getByText("판매자 답글")).toBeVisible();
  await expect(sec.getByRole("img", { name: "리뷰 사진" })).toHaveCount(1);

  await sec.getByRole("button", { name: "리뷰 더 보기" }).click();
  await expect(sec.getByText("아쉬워요")).toBeVisible();
  await expect(sec.getByRole("button", { name: "리뷰 더 보기" })).toHaveCount(0);
  expect(calls).toBe(2);
});

test("불러오지 못하면 이 영역에서만 안내하고 다시 시도할 수 있다", async ({ page }) => {
  const id = await productId(page);
  let fail = true;
  await page.route(`**/api/shop/${SLUG}/products/${id}/reviews**`, (route) => (fail ? route.fulfill({ status: 500, json: { error: "x" } }) : route.fulfill({ json: { average: null, total: 0, photoCount: 0, distribution: [], reviews: [], nextCursor: null } })));
  await page.goto(`/shop/${SLUG}/products/${id}`);
  const sec = page.getByRole("region", { name: /^리뷰/ });
  await expect(sec.getByText("리뷰를 불러오지 못했어요")).toBeVisible();
  await expect(page.getByRole("heading", { name: "탑로더 25장", level: 1 })).toBeVisible(); // 상세는 그대로
  fail = false;
  await sec.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(sec.getByText("아직 리뷰가 없어요")).toBeVisible();
});
