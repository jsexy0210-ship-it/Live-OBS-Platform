import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 마스터 관리자 카페24식 틀: 청록 GNB·LNB, 역할별 메뉴 노출 차이, 로그인 → 홈 진입, 준비 중 화면.
// 마스터 관리자 계정은 폐기용 테스트 DB(이름이 _test로 끝남)에 실행마다 새로 만든다.
const password = randomBytes(12).toString("base64url");
const run = randomBytes(4).toString("hex");
const emails = { super: `shell-super-${run}@example.com`, cs: `shell-cs-${run}@example.com`, readOnly: `shell-read-${run}@example.com` };

test.beforeAll(async () => {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const passwordHash = await hashPassword(password);
    await db.platformAdmin.createMany({
      data: [
        { email: emails.super, passwordHash, name: "대표", role: "SUPER_ADMIN" },
        { email: emails.cs, passwordHash, name: "상담", role: "CS" },
        { email: emails.readOnly, passwordHash, name: "조회", role: "READ_ONLY" },
      ],
    });
  } finally {
    await db.$disconnect();
  }
});

async function login(page: Page, email: string) {
  await page.goto("/admin/login");
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

const gnb = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });
const lnb = (page: Page) => page.getByRole("complementary", { name: "마스터 관리자 메뉴" });

test("파트너스 목록: 실제 로그인 후 공통 틀 3폭 geometry와 이번 SHA 캡처를 확인한다", async ({ page }) => {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const captures = [];
  await login(page, emails.super);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/partners");
    await expect(page.getByRole("heading", { name: "파트너스 목록", exact: true })).toBeVisible();
    await expect(page.getByTestId("partner-row").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.evaluate(() => {
      const main = document.querySelector(".main")!.getBoundingClientRect();
      const head = document.querySelector(".au-ph")!.getBoundingClientRect();
      return { mainX: main.x, headY: head.y, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry).toEqual({ mainX: width < 768 ? 0 : 196, headY: 112, overflow: false });
    const path = `tests/e2e/screenshots/current-shell-${sourceSha}/admin-partners-list-${width}.png`;
    const png = await page.screenshot({ path, fullPage: true });
    captures.push({ width, path, geometry, sha256: createHash("sha256").update(png).digest("hex") });
  }
  const manifest = { sourceSha, route: "/admin/partners", state: "CI seeded test DB, authenticated SUPER_ADMIN", captures };
  writeFileSync(`tests/e2e/screenshots/current-shell-${sourceSha}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.info("Current shell captures:", JSON.stringify(manifest));
});

test("최고관리자: 홈 중복 경로는 생략하고 운영 화면의 LNB 제목 줄·경로 줄은 같은 높이를 유지한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, emails.super);
  await expect(gnb(page).getByRole("link")).toHaveText(["홈", "파트너스", "요금 · 결제", "운영", "고객지원", "설정"]);
  await expect(page.getByRole("heading", { name: "통합 대시보드", level: 1 })).toBeVisible();
  // 메뉴 이름은 「홈」, 화면 제목은 「통합 대시보드」
  await expect(lnb(page).getByRole("link", { name: "홈", exact: true })).toHaveAttribute("aria-current", "page");
  const bg = await page.locator(".gnb").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(15, 118, 110)");
  await expect(page.locator(".loc-bar")).toHaveCount(0);
  expect(await page.locator(".lnb-sec.on .lnb-h").evaluate((el) => el.getBoundingClientRect().height)).toBe(48);
  await gnb(page).getByRole("link", { name: "운영" }).click();
  await expect(page.locator(".loc-bar")).toBeVisible();
  const h = await page.evaluate(() => ({ lnb: document.querySelector(".lnb-sec.on .lnb-h")!.getBoundingClientRect().height, loc: document.querySelector(".loc-bar")!.getBoundingClientRect().height }));
  expect(h.lnb).toBe(48);
  expect(h.loc).toBe(48);
  await expect(lnb(page).getByRole("link", { name: "실시간 감시" })).toBeVisible();
  await expect(lnb(page).locator(".lnb-sec.on .lnb-i")).toHaveText(["실시간 방송", "주문 · 방송 화면 접속", "실시간 감시", "자동 연결 작업", "인프라 · 비용"]);
  await expect(lnb(page).getByRole("link", { name: "자동 연결 작업" })).toHaveAttribute("href", "/admin/ops/automation");
  await gnb(page).getByRole("link", { name: "설정" }).click();
  // 설정은 소제목 「시스템」「관리자」로 나뉜다(관리자 그룹은 설정으로 합쳐짐)
  await expect(lnb(page).locator(".lnb-sec.on .lnb-sub")).toHaveText(["시스템", "관리자"]);
  await expect(lnb(page).getByRole("link", { name: "관리자 계정" })).toBeVisible();
  await expect(lnb(page).getByRole("link", { name: "역할별 권한" })).toBeVisible();
  await expect(lnb(page).getByRole("link", { name: "로그 추적" })).toBeVisible();
  await gnb(page).getByRole("link", { name: "파트너스" }).click();
  await expect(lnb(page).locator(".lnb-sec.on .lnb-i")).toHaveText(["파트너스 목록", "가입 신청", "결제 연결 상태", "적립금 실제 지급 켠 파트너스"]);
  await gnb(page).getByRole("link", { name: "요금 · 결제" }).click();
  await expect(lnb(page).locator(".lnb-sec.on .lnb-i")).toHaveText(["요금제", "구독 현황", "청구 · 결제 내역", "구독료 수납", "환불 요청"]);
});

test("CS: 설정은 조회하고 로그 추적은 막는다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, emails.cs);
  await gnb(page).getByRole("link", { name: "운영" }).click();
  await expect(lnb(page).getByRole("link", { name: "실시간 방송" })).toBeVisible();
  await expect(lnb(page).getByRole("link", { name: "실시간 감시" })).toBeVisible();
  await expect(gnb(page).getByRole("link", { name: "설정" })).toBeVisible();
  for (const [path, title] of [["/admin/settings/branding", "파비콘 · 공유 카드"], ["/admin/settings/maintenance", "점검 모드"]]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByTestId("admin-no-access")).toHaveCount(0);
  }
  await page.goto("/admin/logs");
  await expect(page.getByTestId("admin-no-access")).toBeVisible();
});

test("조회 전용: 확정된 설정 6화면은 열리고 변경 버튼은 없다", async ({ page }) => {
  await login(page, emails.readOnly);
  const settings = [
    ["/admin/settings/policy", "플랫폼 기본 정책"],
    ["/admin/settings/maintenance", "점검 모드"],
    ["/admin/settings/assistant", "도우미 설정"],
    ["/admin/settings/branding", "파비콘 · 공유 카드"],
    ["/admin/settings/messages", "발송 단가"],
    ["/admin/settings/platform-business", "플랫폼 정보"],
  ];
  for (const [path, title] of settings) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByTestId("admin-no-access")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /저장|켜기|끄기|수정|등록|변경/ })).toHaveCount(0);
  }
});

test("메뉴에 없는 주소는 관리자 404(합니다체·대시보드로), 화면 있는 메뉴(파비콘·공유 카드)는 그대로 열린다", async ({ page }) => {
  await login(page, emails.super);
  await page.goto("/admin/nothing-here");
  await expect(page.getByTestId("admin-coming-soon")).toHaveCount(0);
  await expect(page.getByTestId("not-found")).toContainText("페이지를 찾을 수 없습니다");
  await expect(page.getByRole("link", { name: "대시보드로" })).toHaveAttribute("href", "/admin");
  await page.goto("/admin/settings/branding");
  await expect(page.getByRole("heading", { name: "파비콘 · 공유 카드" })).toBeVisible();
});

test("마스터 상단: 전역 검색과 알림 버튼이 있고 검색 패널이 열린다", async ({ page }) => {
  await login(page, emails.super);
  await expect(page.getByRole("button", { name: /^알림/ })).toBeVisible();
  await page.getByRole("button", { name: "빠른 찾기", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "전체 검색" });
  await dialog.getByRole("searchbox").fill("zzz없는검색어");
  await expect(dialog.getByText("「zzz없는검색어」 검색 결과가 없습니다.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("마스터 상단 「알림」(DS-NAV, 화면 이름은 알림 센터)은 /admin/notifications로 연결되고 종 「모두 보기」도 같은 곳을 가리킨다", async ({ page }) => {
  await login(page, emails.super);
  await expect(page.locator(".util-desk").getByRole("link", { name: "알림", exact: true })).toHaveAttribute("href", "/admin/notifications");
  await page.getByRole("button", { name: /^알림/ }).click();
  await expect(page.getByRole("dialog", { name: "알림" }).getByRole("link", { name: "모두 보기" })).toHaveAttribute("href", "/admin/notifications");
});
