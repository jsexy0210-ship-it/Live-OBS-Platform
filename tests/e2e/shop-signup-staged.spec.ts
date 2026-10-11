import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { okConfirm } from "./shopConfirm";

const base = "/shop/demo-shop/signup";
const evidence = "tests/e2e/screenshots/sh011-staged";

async function capture(page: import("@playwright/test").Page, stage: number) {
  mkdirSync(evidence, { recursive: true });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${evidence}/stage${stage}-${width}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
  }
}

async function agree(page: import("@playwright/test").Page) {
  await page.getByLabel("이용약관 동의 (필수)").check();
  await page.getByLabel("개인정보 수집 · 이용 동의 (필수)").check();
  await page.getByLabel("만 14세 이상이에요 (필수)").check();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page).toHaveURL(`${base}/verify`);
}

test("SH-011 네 단계: 약관·본인확인·계정·완료를 기존 가짜 공급자와 가입 API로 진행", async ({ page }) => {
  const unique = String(Date.now()).slice(-8);
  await page.goto(base);
  await expect(page.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await agree(page);
  await page.getByLabel("이름", { exact: true }).fill(`검수${unique}`);
  await page.getByLabel("생년월일").fill("19990101");
  await page.getByRole("button", { name: "여", exact: true }).click();
  await page.getByLabel("통신사").selectOption("KT");
  await page.getByLabel("휴대폰번호", { exact: true }).fill(`010${unique}`);
  await page.getByLabel("본인확인 이용 약관에 모두 동의해요").check();
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기" }).click();
  await expect(page.getByText("본인확인을 마쳤어요")).toBeVisible();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page).toHaveURL(`${base}/account`);
  await page.getByLabel("아이디 (이메일)").fill(`buyer-${unique}@example.test`);
  await page.getByLabel("비밀번호", { exact: true }).fill(`Aa${unique}safe!`);
  await page.getByLabel("비밀번호 확인").fill(`Aa${unique}safe!`);
  await page.getByLabel("방송 닉네임").fill(`검수닉${unique}`);
  await page.getByRole("button", { name: "가입하기" }).click();
  await okConfirm(page, "가입하기");
  await expect(page).toHaveURL(`${base}/done`);
  await expect(page.getByRole("heading", { name: "가입했어요" })).toBeVisible();
});

test("중간 주소 직접 접근과 새로고침은 약관 단계로 돌아가며 계정 정보를 보이지 않는다", async ({ page }) => {
  await page.goto(`${base}/account`);
  await expect(page).toHaveURL(base);
  await expect(page.getByLabel("아이디 (이메일)")).toHaveCount(0);
  await agree(page);
  await page.reload();
  await expect(page).toHaveURL(base);
  await expect(page.getByLabel("인증번호")).toHaveCount(0);
});

test("브라우저 뒤로가기와 앞으로가기는 허용된 가입 단계 화면과 URL을 함께 바꾼다", async ({ page }) => {
  await page.goto(base);
  await agree(page);
  await page.getByLabel("이름", { exact: true }).fill("뒤로가기 확인");
  await page.goBack();
  await expect(page).toHaveURL(base);
  await expect(page.getByLabel("이용약관 동의 (필수)")).toBeChecked();
  await expect(page.getByLabel("이름", { exact: true })).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(`${base}/verify`);
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue("뒤로가기 확인");
});

test("이전 단계는 입력을 유지하고 인증번호 오류를 복구하며 비밀번호만 지운다", async ({ page }) => {
  const unique = String(Date.now()).slice(-8);
  await page.goto(base);
  await agree(page);
  await page.getByLabel("이름", { exact: true }).fill(`복귀${unique}`);
  await page.getByRole("button", { name: "이전 단계" }).click();
  await expect(page).toHaveURL(base);
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue(`복귀${unique}`);
  await page.getByLabel("생년월일").fill("19990101");
  await page.getByRole("button", { name: "여", exact: true }).click();
  await page.getByLabel("통신사").selectOption("KT");
  await page.getByLabel("휴대폰번호", { exact: true }).fill(`010${unique}`);
  await page.getByLabel("본인확인 이용 약관에 모두 동의해요").check();
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await page.getByLabel("인증번호").fill("123456");
  await page.getByRole("button", { name: "인증번호 확인하기" }).click();
  await expect(page.locator("#idv-code-err")).toContainText("인증번호");
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기" }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await page.getByLabel("아이디 (이메일)").fill(`keep-${unique}@example.test`);
  await page.getByLabel("비밀번호", { exact: true }).fill("Password123!");
  await page.getByLabel("비밀번호 확인").fill("Password123!");
  await page.getByLabel("방송 닉네임").fill(`유지${unique}`);
  await page.getByRole("button", { name: "이전 단계" }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page.getByLabel("아이디 (이메일)")).toHaveValue(`keep-${unique}@example.test`);
  await expect(page.getByLabel("방송 닉네임")).toHaveValue(`유지${unique}`);
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue("");
});

test("같은 fixture의 네 단계 1440·1024·390 실제 화면", async ({ page }) => {
  const unique = String(Date.now()).slice(-8);
  await page.goto(base);
  await capture(page, 1);
  await agree(page);
  await capture(page, 2);
  await page.getByLabel("이름", { exact: true }).fill(`화면${unique}`);
  await page.getByLabel("생년월일").fill("19990101");
  await page.getByRole("button", { name: "여", exact: true }).click();
  await page.getByLabel("통신사").selectOption("KT");
  await page.getByLabel("휴대폰번호", { exact: true }).fill(`010${unique}`);
  await page.getByLabel("본인확인 이용 약관에 모두 동의해요").check();
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await page.getByLabel("인증번호").fill("000000");
  await page.getByRole("button", { name: "인증번호 확인하기" }).click();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await capture(page, 3);
  await page.getByLabel("아이디 (이메일)").fill(`view-${unique}@example.test`);
  await page.getByLabel("비밀번호", { exact: true }).fill(`Aa${unique}safe!`);
  await page.getByLabel("비밀번호 확인").fill(`Aa${unique}safe!`);
  await page.getByLabel("방송 닉네임").fill(`화면닉${unique}`);
  await page.getByRole("button", { name: "가입하기" }).click();
  await okConfirm(page, "가입하기");
  await expect(page).toHaveURL(`${base}/done`);
  await capture(page, 4);
});
