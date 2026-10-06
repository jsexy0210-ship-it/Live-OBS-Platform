import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";

// AU-005 가입 승인 대기 안내 · AU-006 이용 정지 안내 · AU-007 세션 만료 안내. 시험용 쇼핑몰(demo-overlay)의 상태를 바꿨다가 되돌린다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const OWNER = "demo-overlay-owner@example.com";
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
});

async function setStatus(status: "ACTIVE" | "PENDING" | "SUSPENDED") {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    await db.seller.update({ where: { slug: "demo-overlay" }, data: { status } });
  } finally {
    await db.$disconnect();
  }
}
test.afterEach(async () => setStatus("ACTIVE"));

test("AU-005 승인 대기: 로그인하면 오류 문구 대신 승인 대기 안내 화면으로 간다", async ({ page }) => {
  await setStatus("PENDING");
  await page.goto("/seller/login");
  await submitSellerLogin(page, OWNER, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/pending$/);
  const box = page.getByTestId("seller-pending");
  await expect(box).toContainText("가입 신청을 확인하고 있습니다");
  await expect(box).toContainText("그 전에는 로그인할 수 없습니다");
  await box.getByRole("link", { name: "로그인 화면으로" }).click();
  await expect(page).toHaveURL(/\/seller\/login$/);
});

test("AU-006 이용 정지: 로그인·/seller·막힌 화면 모두 정지 안내로 가고, 주문 처리·문의하기 길은 열려 있다", async ({ page }) => {
  await setStatus("SUSPENDED");
  await page.goto("/seller/login");
  await submitSellerLogin(page, OWNER, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/suspended$/);
  await expect(page.getByRole("heading", { level: 1, name: "이용이 정지되었습니다" })).toBeVisible();
  const box = page.getByTestId("seller-suspended");
  await expect(box.getByRole("link", { name: "주문 처리" })).toHaveAttribute("href", "/seller/orders");
  await expect(box.getByRole("link", { name: "문의하기" })).toHaveAttribute("href", "/seller/inquiries/new");
  // 서버가 막는 화면(방송)을 열면 안내로 돌아온다
  await page.goto("/seller/broadcast");
  await expect(page).toHaveURL(/\/seller\/suspended$/);
  await page.goto("/seller");
  await expect(page).toHaveURL(/\/seller\/suspended$/);
  // 정지 중에도 공지 · 문의는 열린다
  await page.goto("/seller/notices");
  await expect(page.getByRole("heading", { level: 1, name: "공지 · 문의" })).toBeVisible();
});

test("AU-007 세션 만료: 로그인이 풀린 채 화면을 열면 로그인으로 가고 이유를 알려 주며, 다시 로그인하면 가려던 화면으로 간다", async ({ page }) => {
  await page.goto("/seller/login");
  await submitSellerLogin(page, OWNER, PASSWORD);
  await page.waitForURL((u) => u.pathname !== "/seller/login");
  await page.context().clearCookies();
  // 열자마자 클라이언트가 로그인으로 보내므로 이동이 끝나길 기다리지 않는다
  // 클라이언트가 곧바로 로그인으로 보내 이 이동이 끊기면(ERR_ABORTED) 정상이다. 결과는 아래 주소·문구로 확인한다
  await page.goto("/seller/broadcast", { waitUntil: "commit" }).catch((e: Error) => {
    if (!e.message.includes("ERR_ABORTED")) throw e;
  });
  await expect(page).toHaveURL(/\/seller\/login\?next=%2Fseller%2Fbroadcast/);
  await expect(page.getByText("로그인 시간이 지나 로그아웃되었습니다. 다시 로그인해 주십시오.")).toBeVisible();
  await submitSellerLogin(page, OWNER, PASSWORD);
  await expect(page).toHaveURL(/\/seller\/broadcast$/);
});
