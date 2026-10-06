import { expect, test, type Page } from '@playwright/test';
test.use({ channel: 'chrome' });
async function fixture(page: Page, access = 'paid', role = 'READ_ONLY') {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const seller = path === '/api/seller/me';
    const admin = path === '/api/admin/me';
    await route.fulfill({ status: seller || admin ? 200 : 503, json: seller ? { sellerId:'fixture',userId:'owner',isOwner:true,permissions:[],access,features:['OVERLAY','STORE_OPERATIONS'],shop:{name:'검수 쇼핑몰',slug:'fixture'},user:{name:'검수',email:'fixture@example.com'},trialEndsAt:null } : admin ? {id:'master',name:'검수',email:'fixture@example.com',role} : {error:'fixture_unavailable'} });
  });
}

test('홈 경로 행을 생략해도 체험·결제 실패·이용 종료 안내는 보존', async ({page}) => {
  await page.setViewportSize({width:390,height:900});
  for (const [access, text] of [['trial','체험 중입니다'],['grace','구독료 결제가 되지 않았습니다'],['expired','이용 기간이 끝났습니다']]) {
    await fixture(page, access);
    await page.goto('/seller');
    await expect(page.locator('.loc-bar')).toHaveCount(0);
    await expect(page.locator('.access-banner')).toContainText(text);
  }
});

test('최고관리자 홈에서 운영으로 이동하면 경로 행48px 계약을 유지', async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  await fixture(page, 'paid', 'SUPER_ADMIN');
  await page.goto('/admin');
  await expect(page.locator('.loc-bar')).toHaveCount(0);
  expect(await page.locator('.lnb-sec.on .lnb-h').evaluate(el => el.getBoundingClientRect().height)).toBe(48);
  await page.getByRole('navigation', {name:'주 메뉴'}).getByRole('link', {name:'운영',exact:true}).click();
  await expect(page.locator('.loc-bar')).toBeVisible();
  expect(await page.locator('.loc-bar').evaluate(el => el.getBoundingClientRect().height)).toBe(48);
  expect(await page.locator('.lnb-sec.on .lnb-h').evaluate(el => el.getBoundingClientRect().height)).toBe(48);
});
for (const width of [1440, 1024, 390]) {
  test(`판매자 홈은 반복 경로 행 없이 제목을 유지하고 하위 경로는 보존 ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:900}); await fixture(page);
    await page.goto('/seller');
    await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'홈',exact:true})).toHaveAttribute('aria-describedby', /.+/);
    await expect(page.locator('.loc-bar')).toHaveCount(0);
    await expect(page.getByText('검수 쇼핑몰의 오늘 상황입니다',{exact:true})).toBeVisible();
    await page.screenshot({path:`tests/e2e/screenshots/root-header/seller-home-${width}.png`});
    await page.goto('/seller/settings/legal');
    await expect(page.getByRole('heading',{name:'법정 고지 · 약관',exact:true})).toBeVisible();
    await expect(page.locator('.loc-bar')).toHaveCount(1);
    await page.screenshot({path:`tests/e2e/screenshots/root-header/seller-child-${width}.png`});
  });
  test(`마스터 홈의 반복 경로 행만 생략하고 파트너스 경로는 보존 ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:900}); await fixture(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading',{name:'통합 대시보드',exact:true})).toBeVisible();
    await expect(page.locator('.loc-bar')).toHaveCount(0);
    await page.screenshot({path:`tests/e2e/screenshots/root-header/admin-home-${width}.png`});
    await page.goto('/admin/partners');
    await expect(page.getByRole('heading',{name:'파트너스 목록',exact:true})).toBeVisible();
    await expect(page.locator('.loc-bar')).toHaveCount(1);
    await page.screenshot({path:`tests/e2e/screenshots/root-header/admin-child-${width}.png`});
  });
}
