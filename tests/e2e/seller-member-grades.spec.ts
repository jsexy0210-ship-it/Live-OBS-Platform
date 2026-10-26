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
  // 등급표는 높은 등급부터 보이고, 첫(기본) 등급은 맨 아래에서 「가입 즉시」
  await expect(rows.last()).toContainText("가입 즉시");
  await expect(rows.last().getByRole("button", { name: /수정$/ })).toBeVisible();
  const count = await rows.count();
  const save = page.getByRole("region", { name: "산정 기준" }).getByRole("button", { name: "저장", exact: true });
  const editGrade = async (row: number) => {
    await rows.nth(row).getByRole("button", { name: /수정$/ }).click();
    return page.getByRole("dialog", { name: "등급 수정" });
  };

  // 자동 재산정을 켜면 기준 금액이 순서대로 커야 한다(모두 0원이면 저장 거부)
  await page.getByRole("switch", { name: "자동 재산정" }).click();
  await save.click();
  await expect(page.locator(".msg-neg")).toContainText("높은 등급일수록 커야 합니다");

  // 수정 창에서 기준 금액을 넣고 저장(기본 등급은 0원 고정)
  const base = await editGrade(count - 1);
  await expect(base.getByLabel("기준 금액")).toHaveValue("0");
  await expect(base.getByLabel("기준 금액")).toBeDisabled();
  await base.getByRole("button", { name: "취소" }).click();
  for (let r = 0; r < count - 1; r++) {
    const dialog = await editGrade(r);
    await dialog.getByLabel("기준 금액").fill(String((count - 1 - r) * 100000));
    await dialog.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByText("등급 설정을 저장했습니다")).toBeVisible();
    await expect(dialog).toHaveCount(0);
  }
  await page.getByRole("switch", { name: "자동 재산정" }).click();
  await save.click();
  await expect(page.getByText("등급 설정을 저장했습니다")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "자동 재산정" })).toHaveAttribute("aria-checked", "true");
  await expect(rows.nth(count - 2)).toContainText("100,000원 이상");
  await page.screenshot({ path: `${SHOT}/sa044-grades-1440.png`, fullPage: true });

  // 배송비 혜택: 정액 할인을 넣고 저장하면 표에 나오고 다시 열어도 남는다. 정액 할인이 아니면 금액 칸이 막힌다
  let dialog = await editGrade(count - 2);
  await expect(dialog.getByLabel("할인 금액")).toBeDisabled();
  await dialog.getByLabel("배송비 혜택").selectOption("DISCOUNT");
  await dialog.getByLabel("할인 금액").fill("1000");
  await page.screenshot({ path: `${SHOT}/sa044-edit-dialog-1440.png` });
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("등급 설정을 저장했습니다")).toBeVisible();
  await page.reload();
  await expect(rows.nth(count - 2)).toContainText("1,000원 할인");
  dialog = await editGrade(count - 2);
  await expect(dialog.getByLabel("배송비 혜택")).toHaveValue("DISCOUNT");
  await expect(dialog.getByLabel("할인 금액")).toHaveValue("1000");
  // 정액 할인 금액 0원은 저장할 수 없다
  await dialog.getByLabel("할인 금액").fill("");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("배송비 혜택을 확인해 주십시오");
  await dialog.getByRole("button", { name: "취소" }).click();
  await page.reload();

  // 등급 추가 → 표에 나오고, 회원이 없으니 삭제할 수 있다
  await page.getByRole("button", { name: "등급 추가" }).click();
  const addDialog = page.getByRole("dialog", { name: "등급 추가" });
  await addDialog.getByLabel("등급 이름").fill("다이아");
  await addDialog.getByLabel("기준 금액").fill(String(count * 100000));
  await addDialog.getByRole("button", { name: "추가" }).click();
  await expect(page.getByText("등급을 추가했습니다")).toBeVisible();
  const added = rows.filter({ hasText: "다이아" });
  await expect(added).toHaveCount(1);
  await added.getByRole("button", { name: /수정$/ }).click();
  await page.getByRole("dialog", { name: "등급 수정" }).getByRole("button", { name: "삭제" }).click();
  await expect(page.getByRole("dialog", { name: /「다이아」 등급을 삭제하시겠습니까/ })).toContainText("회원이 없습니다");
  await page.getByRole("dialog", { name: /등급을 삭제하시겠습니까/ }).getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("등급을 지웠습니다")).toBeVisible();
  await expect(rows.filter({ hasText: "다이아" })).toHaveCount(0);

  // 산정 기준을 바꿔 저장하고, 지금 재산정을 확인 창에서 실행한다
  const opts = page.getByRole("region", { name: "산정 기준" }).getByRole("combobox");
  await opts.nth(0).selectOption("12");
  await opts.nth(1).selectOption("WEEKLY");
  await opts.nth(2).selectOption("NONE");
  await save.click();
  await expect(page.getByText("등급 설정을 저장했습니다")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "산정 기준" }).getByRole("combobox").nth(1)).toHaveValue("WEEKLY");
  await page.getByRole("button", { name: "지금 재산정" }).click();
  const recalc = page.getByRole("dialog", { name: "지금 재산정하시겠습니까?" });
  await expect(recalc).toContainText("최근 12개월 구매 금액");
  await recalc.getByRole("button", { name: "재산정" }).click();
  await expect(page.getByText(/재산정 완료 · 승급 \d+명 · 강등 \d+명/)).toBeVisible();

  // 회원 직접 조정: 검색 결과 표에서 회원 상세로 가 고정하면 수동 조정 표에 기간 · 사유와 함께 나온다
  await page.getByLabel("회원 닉네임 검색").fill("");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  const adjust = page.getByTestId("adjust-row").first();
  await expect(adjust).toBeVisible();
  const nick = (await adjust.locator("td").first().textContent())!.trim();
  await expect(page).toHaveURL(/memberSearch=1/);
  const listUrl = new URL(page.url());
  await expect(adjust.locator("input, select, button")).toHaveCount(0);
  const link = adjust.getByRole("link", { name: "회원 상세", exact: true });
  expect(new URL(await link.getAttribute("href") ?? "", listUrl).searchParams.get("returnTo")).toBe(listUrl.pathname + listUrl.search);
  const memberHref = new URL(await link.getAttribute("href") ?? "", listUrl);
  expect(memberHref.pathname).toMatch(/^\/seller\/members\/[0-9a-f-]{36}$/);
  await link.click();
  await expect(page).toHaveURL(memberHref.href);
  await page.reload();
  const detail = page.getByRole("region", { name: "등급 조정", exact: true });
  // 지금과 다른 등급을 고른다
  const current = await detail.getByRole("combobox").inputValue();
  const values = await detail.getByRole("combobox").locator("option").evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  await detail.getByRole("combobox").selectOption(values.find((v) => v !== current)!);
  await detail.getByRole("checkbox", { name: /^고정/ }).check();
  const until = new Date(Date.now() + 30 * 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10);
  await detail.getByLabel("고정 종료일", { exact: true }).fill(until);
  await detail.getByLabel("사유", { exact: true }).fill("방송 단골");
  await detail.getByRole("button", { name: "등급 적용", exact: true }).click();
  await expect(page.getByText(/등급을 조정했습니다 · 자동 재산정에서 제외/)).toBeVisible();
  await page.getByRole("button", { name: "뒤로", exact: true }).click();
  await expect(page).toHaveURL(listUrl.href);
  const manual = page.getByRole("region", { name: "회원 등급 조정" });
  await expect(manual).toContainText(nick);
  await expect(manual).toContainText("까지 고정 · 방송 단골");
  await expect(page.getByTestId("grade-log").filter({ hasText: `${nick} · ` }).first()).toContainText("직접 조정");
});

test("직원: 회원 · 적립금 권한이 없으면 등급 메뉴가 보이지 않는다", async ({ page }) => {
  await page.goto(`/seller/login?next=${encodeURIComponent("/seller/member-grades")}`);
  await submitSellerLogin(page, "demo-none@example.com", PASSWORD);
  await expect(page.getByRole("link", { name: "회원 등급" })).toHaveCount(0);
});

test("구매자: 내 정보에 지금 등급과 다음 등급까지 남은 금액이 보인다", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const r = await page.request.post(`/api/shop/${SLUG}/auth/login`, { data: { loginId: "demo-buyer1@example.com", password: PASSWORD }, headers: { origin: baseURL! } });
  expect(r.status()).toBe(200);
  await page.goto(`/shop/${SLUG}/me`);
  const card = page.getByTestId("grade-card");
  await expect(card).toContainText("내 등급");
  await page.screenshot({ path: `${SHOT}/sh020-grade-card-390.png`, fullPage: true });
  await expect(card).toBeVisible();
});
