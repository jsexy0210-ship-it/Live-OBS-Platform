import { expect, test, type Page } from '@playwright/test';
test.use({ channel:'chrome' });
async function fixture(page:Page, role='READ_ONLY', productsOk=false) {
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const seller=path==='/api/seller/me', admin=path==='/api/admin/me';
    if(productsOk && path==='/api/seller/products') return route.fulfill({status:200,json:{products:[],nextCursor:null}});
    await route.fulfill({status:seller||admin?200:403,json:seller?{sellerId:'fixture',userId:'staff',isOwner:productsOk,permissions:[],access:'paid',features:['OVERLAY','STORE_OPERATIONS'],shop:{name:'검수 쇼핑몰',slug:'fixture'},user:{name:'직원',email:'fixture@example.com'},trialEndsAt:null}:admin?{id:'master',name:'검수',email:'fixture@example.com',role}:{error:'forbidden'}});
  });
}
async function cardWidth(page:Page,width:number){const card=page.getByTestId('permission-card');await expect(card.locator('.login-head')).toHaveCSS('text-align','left');await card.scrollIntoViewIfNeeded();const box=await card.boundingBox();expect(box).not.toBeNull();expect(box!.width).toBeLessThanOrEqual(420);if(width>=1024)expect(box!.width).toBe(420);expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);}
for(const width of [1440,1024,390]){
  test(`판매자403은 대표자 안내와 필요한 권한을 유지하고 이전 화면으로 이동 ${width}`,async({page})=>{
    await page.setViewportSize({width,height:900});await fixture(page);
    await page.goto('/seller');await expect(page.getByRole('heading',{name:'홈',exact:true})).toBeVisible();
    await page.goto('/seller/products');const card=page.getByTestId('permission-card');
    await expect(card).toContainText('대표자에게 허용해 달라고 요청해 주십시오 · 필요한 권한: 상품');
    await expect(card).not.toContainText('최고관리자');await expect(card.getByRole('button',{name:'권한 요청',exact:true})).toHaveCount(0);await cardWidth(page,width);
    await page.screenshot({path:`tests/e2e/screenshots/permission-card/seller-${width}.png`});
    await card.getByRole('button',{name:'이전 화면',exact:true}).click();await expect(page).toHaveURL(/\/seller$/);
  });
  test(`마스터 조회 전용403은 최고관리자 안내와 이전 경로를 유지 ${width}`,async({page})=>{
    await page.setViewportSize({width,height:900});await fixture(page);
    await page.goto('/admin/partners');await expect(page.getByRole('heading',{name:'파트너스 목록',exact:true})).toBeVisible();
    await page.evaluate(() => history.pushState(null, '', '/admin/settings/platform-business'));const card=page.getByTestId('permission-card');
    await expect(card).toContainText('조회 전용 역할입니다. 권한이 필요하면 최고관리자에게 요청해 주십시오.');
    await expect(card).not.toContainText('대표자에게');await expect(card.getByRole('button',{name:'권한 요청',exact:true})).toHaveCount(0);await cardWidth(page,width);
    await page.screenshot({path:`tests/e2e/screenshots/permission-card/master-${width}.png`});
    await card.getByRole('button',{name:'이전 화면',exact:true}).click();await expect(page).toHaveURL(/\/admin\/partners$/);
  });
  test(`대표자 전용403 직접 진입도 직원에게 대표자 안내를 표시 ${width}`,async({page})=>{
    await page.setViewportSize({width,height:900});await fixture(page);await page.goto('/seller/subscription');const card=page.getByTestId('permission-card');
    await expect(card).toContainText('이 메뉴는 파트너스 대표만 쓸 수 있습니다');await expect(card).toContainText('필요한 권한: 대표자');await cardWidth(page,width);
    await page.screenshot({path:`tests/e2e/screenshots/permission-card/owner-only-${width}.png`});
    await card.getByRole('button',{name:'이전 화면',exact:true}).click();await expect(page).toHaveURL(/\/seller$/);
  });
}
test('다른 마스터 역할을 조회 전용 역할이라고 잘못 표시하지 않는다',async({page})=>{
  await fixture(page,'CS');await page.goto('/admin/settings/platform-business');const card=page.getByTestId('permission-card');await expect(card).toContainText('최고관리자에게 요청해 주십시오');await expect(card).not.toContainText('조회 전용 역할입니다');
});

for(const path of ['/seller/products','/seller/subscription','/admin/settings/platform-business']){
  test(`짧은 모바일에서 권한 제목이 먼저 보이고 이전 화면으로 이동 ${path}`,async({page})=>{
    await page.setViewportSize({width:390,height:568});await fixture(page);
    const master=path.startsWith('/admin');const previous=master?'/admin/partners':'/seller';
    await page.goto(previous);
    if(master) await page.evaluate(path=>history.pushState(null,'',path),path);
    else await page.goto(path);
    const card=page.getByTestId('permission-card');const heading=card.getByRole('heading');await expect(heading).toBeVisible();
    const box=await heading.boundingBox();expect(box!.y).toBeGreaterThanOrEqual(0);expect(box!.y+box!.height).toBeLessThan(568);
    if(path==='/seller/products'){
      await expect(page.getByRole('searchbox',{name:'상품 검색'})).toHaveCount(0);
      await expect(page.getByRole('combobox',{name:'정렬'})).toHaveCount(0);
      await expect(page.getByRole('link',{name:'상품 등록',exact:true})).toHaveCount(0);
    }
    await page.screenshot({path:`tests/e2e/screenshots/permission-card/short-${master?'master':path.endsWith('products')?'seller':'owner-only'}.png`});
    await card.getByRole('button',{name:'이전 화면',exact:true}).click();await expect(page).toHaveURL(new RegExp(`${previous}$`));
  });
}
test('정상 상품 응답은 검색과 목록 도구 및 등록 링크를 보존한다',async({page})=>{
  await page.setViewportSize({width:390,height:568});await fixture(page,'READ_ONLY',true);await page.goto('/seller/products');
  const main=page.getByRole('main');
  await expect(page.getByTestId('permission-card')).toHaveCount(0);
  await expect(main.getByRole('searchbox',{name:'상품 검색'})).toBeVisible();
  await expect(main.getByRole('combobox',{name:'정렬'})).toBeVisible();
  await expect(main.getByRole('link',{name:'상품 등록',exact:true})).toHaveCount(2);
  await expect(main.getByRole('link',{name:'상품 등록',exact:true}).first()).toBeVisible();
  const menuLink=page.getByRole('complementary',{name:'파트너스 메뉴',includeHidden:true}).getByRole('link',{name:'상품 등록',exact:true,includeHidden:true});
  await expect(menuLink).toHaveCount(1);
  await expect(menuLink).toHaveAttribute('href','/seller/products/new');
});
