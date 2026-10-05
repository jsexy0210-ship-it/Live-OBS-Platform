import { expect, test } from "@playwright/test";
import { gradeOfMemberInDb, resetGradesInDb } from "./gradeDb";
import { submitSellerLogin } from "./sellerLogin";

// SA-044 회원 등급(파트너스): 이름·기준 금액 저장과 검사, 자동 재산정 켜기, 등급 추가·삭제, 회원 직접 조정(고정).
// 운영 빌드 + 데모 시드(demo-owner·demo-buyer1, 비밀번호 E2E_PASSWORD). 시작·끝에 데모 쇼핑몰의 등급 설정을 처음 상태로 돌린다.
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const SLUG = "demo-shop";
const SHOT = "tests/e2e/screenshots";

test.beforeAll(async () => {
  if (!PASSWORD) throw new Error("E2E_PASSWORD가 없어요. dev-seed가 출력한 데모 비밀번호를 넣어 주세요");
  await resetGradesInDb(SLUG);
});
test.afterAll(() => resetGradesInDb(SLUG));

test("대표자: 기준 금액 저장 → 자동 재산정 켜기 검사 → 등급 추가·삭제 → 회원 고정", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/member-grades")}`);
  await submitSellerLogin(page, "demo-owner@example.com", PASSWORD);
  await expect(page).toHaveURL(/\/seller\/member-grades$/);
  await expect(page.getByRole("link", { name: "회원 등급" })).toHaveClass(/on/);
  const rows = page.getByTestId("grade-row");
  await expect(rows.first().getByLabel(/기준 금액/)).toHaveValue("0");
  await expect(rows.first().getByLabel(/기준 금액/)).toBeDisabled();

  // 자동 재산정을 켜면 기준 금액이 순서대로 커야 한다(모두 0원이면 저장 거부)
  await page.getByRole("switch", { name: "자동 재산정" }).click();
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.locator(".msg-neg")).toContainText("높은 등급일수록 커야 합니다");

  // 기준 금액을 넣고 저장
  const count = await rows.count();
  for (let i = 1; i < count; i++) await rows.nth(i).getByLabel(/기준 금액/).fill(String(i * 100000));
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("등급 설정을 저장했습니다")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "자동 재산정" })).toHaveAttribute("aria-checked", "true");
  await expect(rows.nth(1).getByLabel(/기준 금액/)).toHaveValue("100000");
  await page.screenshot({ path: `${SHOT}/sa044-grades-1440.png`, fullPage: true });

  // 등급 추가 → 목록에 나오고, 회원이 없으니 삭제할 수 있다
  await page.getByLabel("새 등급 이름").fill("다이아");
  await page.getByLabel("새 등급 기준 금액").fill(String(count * 100000));
  await page.getByRole("button", { name: "추가" }).click();
  await expect(page.getByText("등급을 추가했습니다")).toBeVisible();
  const added = page.getByTestId("grade-row").filter({ has: page.getByLabel("다이아 기준 금액") });
  await expect(added).toHaveCount(1);
  await added.getByRole("button", { name: "삭제" }).click();
  await expect(page.getByRole("dialog", { name: /「다이아」 등급을 삭제하시겠습니까/ })).toContainText("회원이 없습니다");
  await page.getByRole("dialog").getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("등급을 지웠습니다")).toBeVisible();
  await expect(page.getByLabel("다이아 기준 금액")).toHaveCount(0);

  // 산정 기준을 바꿔 저장하고, 지금 재산정을 확인 창에서 실행한다
  const opts = page.getByRole("region", { name: "산정 기준" }).getByRole("combobox");
  await opts.nth(0).selectOption("12");
  await opts.nth(1).selectOption("WEEKLY");
  await opts.nth(2).selectOption("NONE");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("등급 설정을 저장했습니다")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "산정 기준" }).getByRole("combobox").nth(1)).toHaveValue("WEEKLY");
  await page.getByRole("button", { name: "지금 재산정" }).click();
  const recalc = page.getByRole("dialog", { name: "지금 재산정하시겠습니까?" });
  await expect(recalc).toContainText("최근 12개월 구매 금액");
  await recalc.getByRole("button", { name: "재산정" }).click();
  await expect(page.getByText(/재산정 완료 · 승급 \d+명 · 강등 \d+명/)).toBeVisible();

  // 회원 직접 조정: 고정하면 고정한 회원에 나오고 최근 변경에 남는다
  await page.getByLabel("회원 닉네임 검색").fill("");
  await page.getByRole("button", { name: "검색" }).click();
  const adjust = page.getByTestId("adjust-row").first();
  await expect(adjust).toBeVisible();
  const nick = (await adjust.locator("span").first().textContent())!.trim();
  // 지금과 다른 등급을 고른다
  const current = await adjust.getByRole("combobox").inputValue();
  const values = await adjust.getByRole("combobox").locator("option").evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  await adjust.getByRole("combobox").selectOption(values.find((v) => v !== current)!);
  await adjust.getByRole("checkbox", { name: "고정" }).check();
  const until = new Date(Date.now() + 30 * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  await adjust.getByLabel(/고정 종료일/).fill(until);
  await adjust.getByLabel(/고정 사유/).fill("방송 단골");
  await adjust.getByRole("button", { name: "적용" }).click();
  await expect(page.getByText(/등급을 조정했습니다 · 자동 재산정에서 제외/)).toBeVisible();
  await expect(page.getByRole("region", { name: "고정한 회원" })).toContainText(nick);
  await expect(page.getByRole("region", { name: "고정한 회원" })).toContainText("까지 고정 · 방송 단골");
  await expect(page.getByTestId("grade-log").filter({ hasText: `${nick} · ` }).first()).toContainText("직접 조정");
});

test("직원: 회원 · 적립금 권한이 없으면 등급 메뉴가 보이지 않는다", async ({ page }) => {
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/member-grades")}`);
  await submitSellerLogin(page, "demo-none@example.com", PASSWORD);
  await expect(page.getByRole("link", { name: "회원 등급" })).toHaveCount(0);
});
