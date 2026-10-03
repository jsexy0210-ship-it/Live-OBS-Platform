import { expect, type Page } from "@playwright/test";

// 파트너스 로그인 화면에서 데모 계정으로 로그인한다(로그인 화면은 먼저 열어 둔다).
// 대표자(demo-owner)가 아니면 직원 탭을 고른다(탭과 계정 종류가 다르면 서버가 로그인하지 않는다, AU-002).
// 직원은 본인확인을 연결하지 않았으면 연결 안내(AU-012)로 가므로 「나중에 할게요」로 원래 가려던 화면으로 넘어간다.
export async function submitSellerLogin(page: Page, email: string, password: string) {
  const staff = email !== "demo-owner@example.com";
  if (staff) await page.getByRole("tab", { name: "직원" }).click();
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  if (staff) {
    await expect(page).toHaveURL(/\/seller\/identity-link\?next=/);
    await page.getByRole("button", { name: "나중에 할게요" }).click();
  }
}
