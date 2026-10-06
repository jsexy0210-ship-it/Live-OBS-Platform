import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-066 쇼핑몰 공지·자주 묻는 질문: 목록·추가·수정·삭제·홈 고정(1개)·질문 순서 바꾸기. 권한 없는 직원은 조회만.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const URL_PATH = "/seller/settings/shop-notices";

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function withDb<T>(fn: (db: PrismaClient, sellerId: string) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: "demo-owner@example.com", isOwner: true }, select: { sellerId: true } });
    return await fn(db, owner.sellerId);
  } finally {
    await db.$disconnect();
  }
}

const reset = () => withDb((db, sellerId) => db.shopNotice.deleteMany({ where: { sellerId } }));

async function open(page: Page, email = "demo-owner@example.com") {
  await page.goto(`/seller/login?next=${encodeURIComponent(URL_PATH)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await expect(page).toHaveURL(new RegExp(`${URL_PATH}$`));
}

test.afterAll(reset);

test("공지: 추가·수정·홈 고정(새로 고정하면 이전 고정이 풀림)·비공개·삭제와 입력 검사", async ({ page }) => {
  await reset();
  await open(page);
  await expect(page.getByRole("heading", { name: "쇼핑몰 공지 · 자주 묻는 질문" })).toBeVisible();
  await expect(page.getByText("아직 공지가 없습니다")).toBeVisible();
  const confirmBtn = (name: string) => page.getByRole("dialog").getByRole("button", { name, exact: true });

  // 입력 검사: 비어 있으면 저장하지 않고 이유를 보인다
  await page.getByTestId("add-notice").click();
  await page.getByTestId("notice-save").click();
  await expect(page.getByText("제목을 입력해 주십시오")).toBeVisible();
  await expect(page.getByText("내용을 입력해 주십시오")).toBeVisible();

  // 첫 공지(홈 고정)
  await page.getByLabel("제목").fill("배송 지연 안내");
  await page.getByLabel("내용").fill("택배사 사정으로 이틀 늦어집니다.");
  await page.getByLabel("홈 띠에 고정").check();
  const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/seller/notices"));
  await page.getByTestId("notice-save").click();
  await confirmBtn("추가").click();
  expect((await created).status()).toBe(201);
  await expect(page.getByText("추가했습니다")).toBeVisible();
  const rows = page.getByTestId("notice-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("고정");

  // 두 번째 공지를 고정하면 첫 공지의 고정이 풀린다
  await page.getByTestId("add-notice").click();
  await page.getByLabel("제목").fill("오픈 이벤트");
  await page.getByLabel("내용").fill("오픈 기념 이벤트를 합니다.");
  await page.getByLabel("홈 띠에 고정").check();
  await page.getByTestId("notice-save").click();
  await expect(page.getByRole("dialog")).toContainText("「배송 지연 안내」 고정이 풀리고");
  await confirmBtn("바꾸기").click();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "오픈 이벤트" })).toContainText("고정");
  await expect(rows.filter({ hasText: "배송 지연 안내" })).not.toContainText("고정");

  // 수정: 비공개로 바꾸면 고정도 풀린다
  await rows.filter({ hasText: "오픈 이벤트" }).getByRole("button", { name: "수정" }).click();
  await page.getByLabel("쇼핑몰에 공개").uncheck();
  const put = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/seller/notices/"));
  await page.getByTestId("notice-save").click();
  await confirmBtn("저장").click();
  expect((await put).status()).toBe(200);
  await expect(page.getByText("저장했습니다")).toBeVisible();
  await expect(rows.filter({ hasText: "오픈 이벤트" })).toContainText("비공개");
  await expect(rows.filter({ hasText: "오픈 이벤트" })).not.toContainText("고정");

  // 숨기기·공개: 확인 창을 거친다
  await rows.filter({ hasText: "배송 지연 안내" }).getByRole("button", { name: "숨기기" }).click();
  await confirmBtn("숨기기").click();
  await expect(rows.filter({ hasText: "배송 지연 안내" })).toContainText("비공개");
  await rows.filter({ hasText: "배송 지연 안내" }).getByRole("button", { name: "공개", exact: true }).click();
  await confirmBtn("공개").click();
  await expect(rows.filter({ hasText: "배송 지연 안내" }).getByText("공개", { exact: true })).toBeVisible();

  // 삭제: 입력 표에서, 확인 창을 거친다
  await rows.filter({ hasText: "배송 지연 안내" }).getByRole("button", { name: "수정" }).click();
  await page.getByTestId("notice-delete").click();
  await expect(page.getByRole("dialog")).toContainText("「배송 지연 안내」를 삭제합니다");
  await confirmBtn("삭제").click();
  await expect(page.getByText("공지를 삭제했습니다")).toBeVisible();
  await expect(rows).toHaveCount(1);
});

test("자주 묻는 질문: 분류와 함께 추가하고, 위·아래로 순서를 바꾸면 서버에 저장되어 다시 열어도 그대로다", async ({ page }) => {
  await reset();
  await withDb((db, sellerId) =>
    db.shopNotice.createMany({
      data: [
        { sellerId, kind: "NOTICE", title: "추석 연휴 배송 안내", body: "연휴에는 순서대로 보내요.", isPinned: true, sortOrder: 0 },
        { sellerId, kind: "FAQ", title: "배송은 얼마나 걸리나요", body: "2~3일 걸립니다.", category: "배송", sortOrder: 0 },
        { sellerId, kind: "FAQ", title: "교환은 어떻게 하나요", body: "문의로 접수해 주십시오.", category: "교환", sortOrder: 1 },
      ],
    }),
  );
  await open(page);
  const rows = page.getByTestId("faq-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("배송은 얼마나 걸리나요");

  // 추가: 맨 뒤에 붙는다
  await page.getByTestId("add-faq").click();
  const ed = page.getByTestId("notice-editor");
  await ed.getByLabel("질문", { exact: true }).fill("환불은 언제 되나요");
  await ed.getByLabel("분류").fill("환불");
  await ed.getByLabel("답변").fill("승인 후 3일 안에 됩니다.");
  await page.getByTestId("notice-save").click();
  await page.getByRole("dialog").getByRole("button", { name: "추가", exact: true }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText("환불은 언제 되나요");
  await expect(rows.nth(2)).toContainText("환불");

  // 첫 질문을 아래로
  const order = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/api/seller/notices/faq-order"));
  const down = page.getByRole("button", { name: "배송은 얼마나 걸리나요 아래로" });
  await down.focus(); // 순서 버튼은 키보드 초점이 있을 때 펼쳐진다
  await down.click();
  const res = await order;
  expect(res.status()).toBe(200);
  expect((res.request().postDataJSON() as { ids: string[] }).ids).toHaveLength(3);
  await expect(rows.nth(0)).toContainText("교환은 어떻게 하나요");
  await expect(rows.nth(1)).toContainText("배송은 얼마나 걸리나요");
  await expect(page.getByRole("button", { name: "교환은 어떻게 하나요 위로", includeHidden: true })).toBeDisabled();

  await page.reload();
  await page.getByTestId("add-faq").click();
  await page.getByTestId("notice-editor").getByLabel("질문", { exact: true }).fill("환불은 언제 되나요");
  await page.getByTestId("notice-editor").getByLabel("답변").fill("승인 후 3일 안에 됩니다.");
  for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: `tests/e2e/screenshots/SA-066-notices-${w}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(rows.nth(0)).toContainText("교환은 어떻게 하나요");
  await expect(rows.nth(1)).toContainText("배송은 얼마나 걸리나요");
});

test("쇼핑몰 설정 권한이 없는 직원은 목록만 보고, 추가·수정·삭제 버튼은 보이지 않는다", async ({ page }) => {
  await reset();
  await withDb((db, sellerId) => db.shopNotice.create({ data: { sellerId, kind: "NOTICE", title: "읽기 전용 확인", body: "본문", sortOrder: 0 } }));
  await open(page, "demo-none@example.com");
  await expect(page.getByTestId("notice-row")).toHaveCount(1);
  await expect(page.getByText("목록만 볼 수 있습니다")).toBeVisible();
  await expect(page.getByTestId("add-notice")).toHaveCount(0);
  await expect(page.getByTestId("add-faq")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "수정" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "삭제" })).toHaveCount(0);
});
