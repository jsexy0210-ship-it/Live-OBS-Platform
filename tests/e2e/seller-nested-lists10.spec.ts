import { expect, test, type Page, type Locator } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hashPassword } from "../../lib/server/auth/password";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { submitSellerLogin } from "./sellerLogin";
import type { getMemberGrades, listGradeChanges } from "../../lib/server/shop-member-grades/service";

// 단독 CI job의 고유 폐기 테넌트에서 등급 GET만 조회한다. 쿠폰/알림의 합성 GET·읽음 응답은 실제 쓰기로 전달하지 않는다.
const run = randomBytes(6).toString("hex"), email = "nested-" + run + "-owner@example.com";
const password = randomBytes(12).toString("base64url");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const evidence = "tests/e2e/screenshots/current-shell-" + sha;
let db: PrismaClient, sellerId: string | undefined, ownerId: string | undefined;
const slug = "nested-" + run, names = Array.from({length:23},(_,i)=>"합성 등급 회원 " + run + "-" + i);
test.beforeAll(async ({}, info) => {
  expect(process.env.CI).toBe("true"); expect(process.env.GITHUB_JOB).toBe("e2e-smoke");
  expect(process.env.NODE_ENV).not.toBe("production"); expect(info.config.workers).toBe(1);
  const url=assertTestDatabaseUrl(process.env.DATABASE_URL), base=new URL(String(info.project.use.baseURL));
  expect(new URL(url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/); expect(new URL(url).pathname).toBe("/live_obs_test");
  expect(base.hostname).toMatch(/^(localhost|127\.0\.0\.1)$/); expect(base.port).toBe("3100");
  db=new PrismaClient({datasources:{db:{url}}}); mkdirSync(evidence,{recursive:true});
  const now=new Date();
  sellerId=(await db.seller.create({data:{slug,shopName:"하위 목록 조회",status:"ACTIVE",approvedAt:now,trialEndsAt:new Date(now.getTime()+7*86400000)}})).id;
  ownerId=(await db.sellerUser.create({data:{sellerId,email,passwordHash:await hashPassword(password),name:"조회 담당",isOwner:true}})).id;
  const grade=await db.memberGrade.create({data:{sellerId,displayName:"일반",systemKey:"BASIC",sortOrder:0}});
  for(let i=0;i<23;i++) {
    const at=new Date(now.getTime()-i*60000);
    const buyer=await db.buyerMember.create({data:{sellerId,gradeId:grade.id,loginId:"nested-"+run+"-"+i,passwordHash:"unused",name:names[i],broadcastNickname:names[i],phone:"synthetic-"+run+"-"+i,ciHash:"nested-"+run+"-"+i,identityVerifiedAt:now}});
    await db.memberGradeHistory.create({data:{sellerId,buyerMemberId:buyer.id,fromName:"일반",toName:"합성 상위",reason:"AUTO_UP",amount:1000+i,createdAt:at}});
    await db.memberGradeOverride.create({data:{sellerId,buyerMemberId:buyer.id,until:null,reason:"합성 고정",createdAt:at}});
  }
});
test.afterAll(async()=>{
  if(!db) return;
  try { if(sellerId) {
    const where={sellerId};
    await db.memberGradeHistory.deleteMany({where}); await db.memberGradeOverride.deleteMany({where});
    await db.buyerMember.deleteMany({where}); await db.memberGrade.deleteMany({where});
    if(ownerId) { await db.sellerSession.deleteMany({where:{sellerId,sellerUserId:ownerId}}); await db.sellerUser.deleteMany({where:{id:ownerId,sellerId}}); }
    await db.seller.deleteMany({where:{id:sellerId}});
  }} finally {await db.$disconnect();}
});
async function login(page:Page) {
  await page.goto("/seller/login"); await submitSellerLogin(page,email,password); await expect(page).toHaveURL(/\/seller$/);
}
async function capture(page:Page,id:string,state:string,role="owned-owner") {
  const metrics=await page.evaluate(()=>{
    const main=document.querySelector("main.main") ?? document.querySelector(".cb"), rows=Array.from(document.querySelectorAll('[data-testid="grade-log"],[data-testid="grade-locked-row"],[data-testid="grade-change-row"],[data-testid="notif-row"],.cb-item'));
    return {innerWidth,innerHeight,dpr:devicePixelRatio,scale:visualViewport?.scale??null,scrollY,main:main?{rect:main.getBoundingClientRect().toJSON(),clientWidth:main.clientWidth,scrollWidth:main.scrollWidth}:null,rows:rows.map(r=>({text:r.textContent,rect:r.getBoundingClientRect().toJSON()}))};
  });
  const name=id+"-nested10-"+metrics.innerWidth+"-"+state;
  await page.screenshot({path:"tests/e2e/screenshots/"+name+".png",fullPage:true});
  writeFileSync(evidence+"/"+name+".json",JSON.stringify({actualGitSha:sha,role,state,route:page.url(),fixture:"current-job-owned-synthetic",browserZoom:"UNVERIFIED",metrics},null,2));
  expect(metrics.main).not.toBeNull();
}
async function shots(page:Page,id:string,state:string,role?:string) {
  for(const width of [1440,1024]) { await page.setViewportSize({width,height:900}); await capture(page,id,state,role); }
}
async function numbered(page:Page,rows:Locator,text:Locator,expected:string[]) {
  const nav=page.getByRole("navigation",{name:"페이지 이동",exact:true}), count=Math.ceil(expected.length/10);
  for(let n=1;n<=count;n++) {
    await expect(rows).toHaveCount(Math.min(10,expected.length-(n-1)*10)); await expect(text).toHaveText(expected.slice((n-1)*10,n*10));
    await expect(nav.getByRole("button",{name:n+"페이지",exact:true})).toHaveAttribute("aria-current","page");
    if(n<count) await nav.getByRole("button",{name:"다음",exact:true}).click();
  }
  await expect(nav.getByRole("button",{name:"다음",exact:true})).toBeDisabled();
  await nav.getByRole("button",{name:"처음",exact:true}).click(); await expect(text).toHaveText(expected.slice(0,10));
  await nav.getByRole("button",{name:"마지막",exact:true}).click(); await nav.getByRole("button",{name:"이전",exact:true}).click();
  await expect(text).toHaveText(expected.slice((count-2)*10,(count-1)*10));
}
test("SA-044: 하위 세 목록은 동일 GET 조건으로 10·10·3과 끝/앞/처음을 보존한다",async({page})=>{
  try {
    await login(page);
    const root="/api/seller/member-grades";
    const firstResponse=await page.request.get(root); expect(firstResponse.status()).toBe(200);
    const first:Awaited<ReturnType<typeof getMemberGrades>>=await firstResponse.json();
    expect(first.lockedCount).toBe(23); expect(first.recent).toHaveLength(10); expect(first.locked).toHaveLength(10);
    for(const key of ["recent","locked"] as const) {
      const seen:string[]=[]; let data=first;
      for(const size of [10,10,3]) {
        expect(data[key]).toHaveLength(size); seen.push(...data[key].map(r=>r.nickname)); expect(data.lockedCount).toBe(23);
        const cursor=data[key==="recent"?"recentNextCursor":"lockedNextCursor"];
        if(cursor) {const response=await page.request.get(root+"?"+key+"Cursor="+encodeURIComponent(cursor));expect(response.status()).toBe(200);data=await response.json();} else expect(size).toBe(3);
      }
      expect(seen).toEqual(names); expect(new Set(seen).size).toBe(23);
    }
    await page.goto("/seller/member-grades");
    await page.getByRole("button",{name:"승급 회원 보기",exact:true}).click();
    const targets=[{section:page.getByRole("region",{name:"최근 변경",exact:true}),row:"grade-log",key:"recent"},{section:page.getByRole("region",{name:"고정한 회원",exact:true}),row:"grade-locked-row",key:"locked"},{section:page.getByRole("region",{name:"승급 회원",exact:true}),row:"grade-change-row",key:"changes"}];
    for(const target of targets) {
      const rows=target.section.getByTestId(target.row), nav=target.section.getByRole("navigation",{name:"페이지 이동",exact:true});
      for(let n=1;n<=3;n++) {
        await expect(rows).toHaveCount(n===3?3:10);
        const displayed=rows.locator(target.key==="changes"?":scope > span:first-child":":scope > .col > span:first-child");
        await expect(displayed).toHaveText(names.slice((n-1)*10,n*10).map(name=>name+(target.key==="locked"?" · 일반":" · 일반 → 합성 상위")));
        await expect(nav.getByRole("button",{name:n+"페이지",exact:true})).toHaveAttribute("aria-current","page");
        if(n<3) await nav.getByRole("button",{name:"다음",exact:true}).click();
      }
      await expect(nav.getByRole("button",{name:"다음",exact:true})).toBeDisabled();
      await nav.getByRole("button",{name:"이전",exact:true}).click(); await expect(rows).toHaveCount(10);
      await nav.getByRole("button",{name:"처음",exact:true}).click(); await expect(rows).toHaveCount(10);
      await expect(rows.locator(target.key==="changes"?":scope > span:first-child":":scope > .col > span:first-child")).toHaveText(names.slice(0,10).map(name=>name+(target.key==="locked"?" · 일반":" · 일반 → 합성 상위")));
    }
    const changesResponse=await page.request.get(root+"/changes?kind=up"); expect(changesResponse.status()).toBe(200);
    let changes:Awaited<ReturnType<typeof listGradeChanges>>=await changesResponse.json(), changeNames:string[]=[];
    for(const size of [10,10,3]) {
      expect(changes.changes).toHaveLength(size);changeNames.push(...changes.changes.map(r=>r.nickname));
      if(changes.nextCursor) {const r=await page.request.get(root+"/changes?kind=up&cursor="+encodeURIComponent(changes.nextCursor));expect(r.status()).toBe(200);changes=await r.json();} else expect(size).toBe(3);
    }
    expect(changeNames).toEqual(names);expect(new Set(changeNames).size).toBe(23);
    await shots(page,"SA-044","three-lists-first");
    await page.getByRole("button",{name:"강등 회원 보기",exact:true}).click();
    await expect(page.getByRole("region",{name:"강등 회원",exact:true}).getByText("해당하는 회원이 없습니다",{exact:true})).toBeVisible();
    await expect(page.getByRole("region",{name:"강등 회원",exact:true}).getByRole("navigation")).toHaveCount(0);
    await page.reload(); await expect(page.getByTestId("grade-changes")).toHaveCount(0);
    await expect(page.getByTestId("grade-log")).toHaveCount(10);
    const badCursor=await page.request.get(root+"?recentCursor=invalid");expect(badCursor.status()).toBe(400);
    await page.route("**/api/seller/member-grades",route=>{expect(route.request().method()).toBe("GET");return route.fulfill({json:{...first,recent:[],locked:[],lockedCount:0,recentNextCursor:null,lockedNextCursor:null}});});
    await page.reload();await expect(page.getByText("등급 변경 기록이 없습니다",{exact:true})).toBeVisible();
    await expect(page.getByText("고정한 회원이 없습니다",{exact:true})).toBeVisible();
    await expect(page.getByRole("region",{name:"최근 변경",exact:true}).getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("region",{name:"고정한 회원",exact:true}).getByRole("navigation")).toHaveCount(0);
  } catch(error) {try{await capture(page,"SA-044","failed");}catch{}throw error;}
});
test("SH-028: 기존 두 탭 전체 배열을 보존하며 10개·끝·빈 상태를 표시한다",async({page})=>{
  const at="2026-10-01T00:00:00Z", end="2099-10-01T00:00:00Z";
  const coupons=(past=false)=>Array.from({length:23},(_,i)=>({couponId:"synthetic-"+past+"-"+i,name:(past?"지난 쿠폰 ":"사용 쿠폰 ")+i,benefit:"AMOUNT",value:1000,maxDiscount:null,minOrderAmount:0,excludeDiscounted:false,allowWithReward:true,productScoped:false,startsAt:at,endsAt:end,validDays:null,issuedAt:at,expiresAt:end,usedAt:past?at:null,state:past?"used":"usable"}));
  let usable=coupons(),past=coupons(true);
  await page.route("**/api/shop/"+slug+"/coupons",route=>{expect(route.request().method()).toBe("GET");return route.fulfill({json:{usable,past,claimable:[],claimableMore:false,now:at,shopOpen:true}});});
  try {
    await page.goto("/shop/"+slug+"/coupons");
    const rows=page.locator(".cb-list > .cb-item"), text=rows.locator(".cb-body > .t-b2");
    await numbered(page,rows,text,usable.map(c=>c.name));
    await page.getByRole("tab",{name:/^사용 · 만료/}).click();await numbered(page,rows,text,past.map(c=>c.name));
    await shots(page,"SH-028","past-page2","synthetic-buyer-GET");
    await page.getByRole("tab",{name:/^쓸 수 있는 쿠폰/}).click();await expect(text).toHaveText(usable.slice(10,20).map(c=>c.name));
    usable=usable.slice(0,10);past=past.slice(0,10);await page.reload();await expect(rows).toHaveCount(10);
    await expect(page.getByRole("navigation",{name:"페이지 이동",exact:true})).toHaveCount(0);
    usable=[];past=[];await page.reload();await expect(page.getByText("쓸 수 있는 쿠폰이 없어요",{exact:true})).toBeVisible();
    await expect(rows).toHaveCount(0);await expect(page.getByRole("navigation",{name:"페이지 이동",exact:true})).toHaveCount(0);
    await page.getByRole("tab",{name:/^사용 · 만료/}).click();await expect(page.getByText("사용하거나 만료된 쿠폰이 없어요",{exact:true})).toBeVisible();
  } catch(error) {try{await capture(page,"SH-028","failed","synthetic-buyer-GET");}catch{}throw error;}
});
test("SA-130: 최근 30개 feed와 읽음 계약을 보존하며 10개 이동·새로 고침 첫 쪽을 표시한다",async({page})=>{
  let items=Array.from({length:30},(_,i)=>({id:"synthetic-"+i,kind:"NOTICE",title:"합성 알림 "+i,href:"/seller/notices",createdAt:"2026-10-01T00:00:00Z",unread:true}));
  let gets=0,reads=0;
  await page.route("**/api/seller/notifications",route=>{expect(route.request().method()).toBe("GET");gets++;return route.fulfill({json:{items,unreadCount:items.length}});});
  await page.route("**/api/seller/notifications/read",route=>{expect(route.request().method()).toBe("POST");reads++;return route.fulfill({json:{ok:true}});});
  try {
    await login(page);await page.goto("/seller/notifications");
    const rows=page.getByTestId("notif-row"),text=rows.locator("td > a");
    await numbered(page,rows,text,items.map(i=>i.title));await expect(page.getByTestId("notif-unread")).toHaveText("읽지 않은 알림 30건");
    await shots(page,"SA-130","page2-recent30");
    const count=gets;await page.getByRole("button",{name:"새로 고침",exact:true}).click();await expect(text).toHaveText(items.slice(0,10).map(i=>i.title));
    expect(gets).toBe(count+1);await expect.poll(()=>reads).toBe(gets);
    items=[];await page.getByRole("button",{name:"새로 고침",exact:true}).click();await expect(page.getByText("새 알림이 없습니다",{exact:true})).toBeVisible();
    await expect(rows).toHaveCount(0);await expect(page.getByRole("navigation",{name:"페이지 이동",exact:true})).toHaveCount(0);
  } catch(error) {try{await capture(page,"SA-130","failed");}catch{}throw error;}
});
