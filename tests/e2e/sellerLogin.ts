import type { Page } from "@playwright/test";

// 파트너스 로그인 화면에서 데모 계정으로 로그인한다(로그인 화면은 먼저 열어 둔다).
// 대표자(demo-owner·demo-overlay-owner)가 아니면 직원 탭을 고른다(탭과 계정 종류가 다르면 서버가 로그인하지 않는다, AU-002).
// 직원이 본인확인 연결 안내(AU-012, 본인확인을 쓸 수 있는 서버에서만 뜬다)로 가면 「나중에 하기」로 원래 가려던 화면으로 넘어간다.
export async function submitSellerLogin(page: Page, email: string, password: string) {
  const staff = !email.endsWith("-owner@example.com");
  if (staff) await page.getByRole("tab", { name: "직원" }).click();
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  if (!staff) return;
  await page.waitForURL((u) => u.pathname !== "/seller/login");
  if (new URL(page.url()).pathname === "/seller/identity-link") await page.getByRole("button", { name: "나중에 하기" }).click();
}

// 로그아웃은 확인 창을 거친다(「로그아웃하시겠습니까?」): 창의 [로그아웃]을 눌러 마친다. 창 밖 버튼(상단 유틸)은 이름이 같아 창 안에서만 찾는다.
export async function confirmLogout(page: Page) {
  await page.getByRole("dialog").getByRole("button", { name: "로그아웃", exact: true }).click();
}
