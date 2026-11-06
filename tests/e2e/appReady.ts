import type { Page } from "@playwright/test";

// 페이지를 연 직후 화면을 누르거나 history.pushState로 주소를 바꾸는 시험은, Next 앱 라우터가 마운트되기 전이면 반응하지 않는다.
// 앱 라우터는 마운트될 때 window.history.pushState를 자기 함수로 바꾸므로, 네이티브 함수가 아니게 된 때가 준비된 때다.
export async function appReady(page: Page) {
  await page.waitForFunction(() => !/\[native code\]/.test(window.history.pushState.toString()));
}
