import { expect, test } from "@playwright/test";

test("아이디 찾기 초기 화면은 세 폭에서 통신사 선택을 안내한다", async ({ page }) => {
  await page.goto("/seller/find-id");
  const carrier = page.locator("#idv-carrier");
  const send = page.getByRole("button", { name: "인증번호 문자 받기", exact: true });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("이메일(아이디)을 찾습니다");
    await expect(carrier).toHaveValue("");
    await expect(carrier.locator('option[value=""]')).toHaveText("통신사 선택");
    await expect(send).toBeDisabled();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `tests/e2e/screenshots/au011-find-id-initial-${width}.png`, fullPage: true });
  }
});

// PF-002 기능 안내 · PF-003 요금 안내 · PF-004 자주 묻는 질문 (로그인 없이 열린다)
test("기능 안내가 열리고 머리에서 현재 메뉴가 표시된다", async ({ page }) => {
  await page.goto("/features");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("기능 안내");
  await expect(page.getByRole("heading", { name: "OBS 방송 화면" })).toBeVisible();
  await expect(page.getByText("자동 점검을 통과하면 바로 승인돼요. 오버레이 전용은 승인되면 7일 동안 체험할 수 있어요.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "주요 메뉴" }).getByRole("link", { name: "기능" })).toHaveAttribute("aria-current", "page");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const checks = page.locator(".pf-chk svg");
    await expect(checks).toHaveCount(14);
    for (const check of await checks.all()) {
      const box = await check.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBe(20);
      expect(box!.height).toBe(20);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `tests/e2e/screenshots/pf002-features-${width}.png`, fullPage: true });
  }
});

// 요금은 서버 요금제 값이다. E2E_PLAN_PRICE가 있으면(시험 DB 값) 그 금액이 화면에 보이는지도 확인한다.
test("요금 안내는 서버 요금제 값을 보여 주거나 불러오지 못했다고 알린다", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("요금");
  const plans = page.locator("[data-plan]");
  if ((await plans.count()) > 0) {
    await expect(plans.first()).toContainText(/\d{1,3}(,\d{3})*원/);
    const overlayPlan = page.locator('[data-plan="OVERLAY_ONLY"]');
    if (await overlayPlan.count()) await expect(overlayPlan).toContainText("운영 중인 외부 쇼핑몰 웹훅 연결");
    const integratedPlan = page.locator('[data-plan="INTEGRATED"]');
    if (await integratedPlan.count()) await expect(integratedPlan).toContainText("ONQ 스토어 · 상품 · 주문 운영");
    const price = process.env.E2E_PLAN_PRICE;
    if (price) await expect(page.locator('[data-plan="OVERLAY_ONLY"]')).toContainText(price);
  } else {
    await expect(page.getByRole("status")).toContainText("불러오지 못했어요");
  }
  const pricingFaq = page.locator(".pf-faq details");
  await expect(pricingFaq).toHaveCount(4);
  await expect(page.locator(".pf-faq details:not([open])")).toHaveCount(0);
  const paymentFailure = pricingFaq.filter({ hasText: "결제가 실패하면 어떻게 되나요?" });
  await expect(paymentFailure).toContainText(/처음 실패한 날부터 \d+일까지는|정해진 유예 기간/);
  await expect(paymentFailure).toContainText(/하루 간격으로 \d+번 다시 시도/);
  await expect(paymentFailure).toContainText(/잠긴 지 \d+일이 지나면 체험 종료일이 등록된 계정은 자동으로 해지/);
  const failureCopy = (await paymentFailure.textContent()) ?? "";
  if (/처음 실패한 날부터 \d+일까지는/.test(failureCopy)) {
    await expect(paymentFailure).toContainText("구독 기간은 원래 결제일부터 이어서 세요");
  }
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.locator(".pf-foot-links a").first()).toHaveCSS("text-decoration-line", "underline");
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({ path: `tests/e2e/screenshots/pf003-pricing-${width}.png`, fullPage: true });
  }
});

test("자주 묻는 질문은 분류와 검색으로 좁혀진다", async ({ page }) => {
  await page.goto("/faq");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("자주 묻는 질문");
  await expect(page.getByText("가입 신청은 어떻게 처리되나요?")).toBeVisible();
  await expect(page.locator("details").first()).toContainText("자동 점검을 통과하면 바로 승인돼요. 확인이 필요한 신청은 마스터 관리자가 살펴본 뒤 승인하거나, 보완을 요청하거나 반려해요.");
  await expect(page.getByText("운영팀이 평일 10~18시에 답해요. 평균 첫 답변 4시간.")).toBeVisible();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.locator(".pf-info-section")).toHaveCSS("padding-top", width === 390 ? "40px" : "72px");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("details")).toHaveCount(8);
    await expect(page.locator("details").first()).toHaveAttribute("open", "");
    await page.screenshot({ path: `tests/e2e/screenshots/pf004-faq-${width}.png`, fullPage: true });
  }
  const all = await page.locator("details").count();
  await page.getByRole("button", { name: "적립금" }).click();
  await expect(page.locator("details")).toHaveCount(1);
  await page.getByRole("button", { name: "전체" }).click();
  await expect(page.locator("details")).toHaveCount(all);
  await page.getByLabel("질문 검색").fill("도메인");
  await expect(page.locator("details")).toHaveCount(1);
  await page.getByLabel("질문 검색").fill("없는말없는말");
  await expect(page.getByRole("status")).toContainText("맞는 질문이 없어요");
});

test("개인정보처리방침 준비 안내는 세 폭에서 정본 여백을 유지한다", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("개인정보처리방침");
  await expect(page.getByTestId("privacy-pending")).toContainText("개인정보처리방침을 아직 준비 중이에요");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.locator(".pf-document-section")).toHaveCSS("padding-top", width === 390 ? "40px" : "56px");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("privacy-pending")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `tests/e2e/screenshots/pf009-privacy-pending-${width}.png`, fullPage: true });
  }
});

test("이용약관 초안 안내는 세 폭에서 정본 여백을 유지한다", async ({ page }) => {
  await page.goto("/terms");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("이용약관");
  await expect(page.getByTestId("terms-draft")).toContainText("시행 전 초안");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.locator(".pf-document-section")).toHaveCSS("padding-top", width === 390 ? "40px" : "56px");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("terms-draft")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `tests/e2e/screenshots/pf008-terms-draft-${width}.png`, fullPage: true });
  }
});
