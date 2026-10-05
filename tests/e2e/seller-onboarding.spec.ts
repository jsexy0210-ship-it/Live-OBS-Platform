import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// SA-003 시작하기 · SA-004 온보딩: 플랜별 단계 체크리스트, 첫 미완료 단계에서 이어 하기, 닫기·다시 열기, 오버레이 주소 복사 단계.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function resetOnboarding(slug: string) {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    await db.sellerOnboarding.deleteMany({ where: { sellerId: seller.id } });
  } finally {
    await db.$disconnect();
  }
}
test.beforeEach(async () => {
  await resetOnboarding("demo-shop");
  await resetOnboarding("demo-overlay");
});

async function login(page: Page, email: string, next = "/seller/onboarding") {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/seller/login?next=${encodeURIComponent(next)}`);
  await submitSellerLogin(page, email, PASSWORD);
  await page.waitForURL((u) => u.pathname === next);
}
type Api = { track: string | null; steps: { key: string; done: boolean; href: string }[]; doneCount: number; total: number; currentStep: string | null; dismissed: boolean };
const apiState = async (page: Page) => (await (await page.request.get("/api/seller/onboarding")).json()) as Api;

test("쇼핑몰 통합: 단계가 서버 순서·완료 상태 그대로 보이고, 첫 미완료 단계에서 이어 하며, 닫았다 다시 열 수 있다", async ({ page }) => {
  await login(page, "demo-owner@example.com");
  const s = await apiState(page);
  expect(s.track).toBe("INTEGRATED");
  const rows = page.getByTestId("ob-step");
  await expect(rows).toHaveCount(s.steps.length);
  for (const [i, step] of s.steps.entries()) {
    await expect(rows.nth(i)).toHaveAttribute("data-key", step.key);
    await expect(rows.nth(i)).toHaveAttribute("data-done", step.done ? "true" : "false");
  }
  await expect(page.getByTestId("ob-count")).toHaveText(`${s.doneCount} / ${s.total} 완료`);
  // 첫 미완료 단계만 「진행 차례」이고 「이어서 하기」가 그 단계 주소로 간다
  expect(s.currentStep).not.toBeNull();
  await expect(page.locator('[data-testid="ob-step"][data-current="true"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="ob-step"][data-current="true"]')).toHaveAttribute("data-key", s.currentStep!);
  const href = s.steps.find((x) => x.key === s.currentStep)!.href;
  await expect(page.getByTestId("ob-continue")).toHaveAttribute("href", href);

  // 닫기 → 단계 목록이 숨고 서버에도 닫힘, 다시 열기 → 돌아옴
  await page.getByRole("button", { name: "안내 숨기기" }).click();
  await expect(page.getByText("시작하기를 닫았습니다")).toBeVisible();
  await expect(rows).toHaveCount(0);
  expect((await apiState(page)).dismissed).toBe(true);
  await page.getByRole("button", { name: "다시 보이기" }).click();
  await expect(rows).toHaveCount(s.steps.length);
  expect((await apiState(page)).dismissed).toBe(false);

  await page.getByTestId("ob-continue").click();
  await expect(page).toHaveURL(new RegExp(`${href.replace(/\//g, "\\/")}$`));
});

test("오버레이 전용: 외부 쇼핑몰 연동·오버레이 설정·주소 복사 3단계, 오버레이 화면에서 주소를 복사하면 마지막 단계가 완료된다", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, "demo-overlay-owner@example.com");
  const s = await apiState(page);
  expect(s.track).toBe("OVERLAY_ONLY");
  expect(s.steps.map((x) => x.key)).toEqual(["external_shop", "overlay", "overlay_url"]);
  await expect(page.getByTestId("ob-step")).toHaveCount(3);
  expect(s.steps.find((x) => x.key === "overlay_url")!.done).toBe(false);

  // 오버레이 편집기에서 주소를 발급해 복사하면 서버에 「주소 복사」가 남는다
  await page.goto("/seller/overlay");
  await page.getByRole("button", { name: "주소 발급" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "발급" }).click();
  await expect(page.getByTestId("ovu-urls")).toBeVisible();
  await page.getByRole("button", { name: "주소 복사" }).first().click();
  await expect(page.getByText("주소를 복사했습니다")).toBeVisible();
  await expect.poll(async () => (await apiState(page)).steps.find((x) => x.key === "overlay_url")!.done).toBe(true);

  await page.goto("/seller/onboarding");
  await expect(page.locator('[data-testid="ob-step"][data-key="overlay_url"]')).toHaveAttribute("data-done", "true");
});

test("쇼핑몰 설정 권한이 없는 직원은 체크리스트는 보지만 닫기 버튼은 없다", async ({ page }) => {
  await login(page, "demo-viewer@example.com");
  await expect(page.getByTestId("ob-step").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "안내 숨기기" })).toHaveCount(0);
});
