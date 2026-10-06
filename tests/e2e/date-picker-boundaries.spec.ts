import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let server: Server;
let origin: string;
let dir: string;
test.use({ channel: "chrome" });
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "onq-date-"));
  await build({entryPoints:["tests/e2e/fixtures/date-picker.tsx"],outfile:join(dir,"fixture.js"),bundle:true,platform:"browser",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"'}});
  server = createServer((req,res) => {
    const path = req.url;
    if (path === "/fixture.js") {res.setHeader("Content-Type","text/javascript");res.end(readFileSync(join(dir,"fixture.js")));}
    else if (path === "/tokens.css" || path === "/lop.css") {res.setHeader("Content-Type","text/css");res.end(readFileSync(`styles${path}`));}
    else res.end('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/lop.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
test.afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));rmSync(dir,{recursive:true,force:true});});
test.beforeEach(async({page})=>{await page.goto(origin);});
for (const width of [1440,1024,390]) {
  test(`viewport ${width}: clipped parent escaped and sheet reachable`,async({page})=>{
    await page.setViewportSize({width,height:width===390?320:900});
    await page.getByLabel("날짜",{exact:true}).click();
    const popup=page.getByRole("dialog");
    await expect(popup).toBeVisible();
    const rect=await popup.boundingBox();
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y+rect!.height).toBeLessThanOrEqual(width===390?320:900);
    await expect(page.getByRole("button",{name:"2026.10.06",exact:true})).toBeEnabled();
    const hit=await popup.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+Math.min(r.height/2,100)));});
    expect(hit).toBe(true);
    if(width===390) await page.getByRole("button",{name:"적용",exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`tests/e2e/screenshots/date-picker/boundaries-${width}.png`});
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
  });
}
test("scroll anchor offscreen closes floating calendar",async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.getByLabel("날짜",{exact:true}).click();
  await page.evaluate(()=>window.scrollTo(0,350));
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("keyboard Enter opens, Down enters, arrows move, Escape restores",async({page})=>{
  const field=page.getByLabel("날짜",{exact:true});
  await field.focus();await expect(page.getByRole("dialog")).toHaveCount(0);
  await field.press("Enter");await expect(page.getByRole("dialog")).toBeVisible();
  await field.press("ArrowDown");await expect(page.getByRole("button",{name:"2026.10.06",exact:true})).toBeFocused();
  await page.keyboard.press("ArrowRight");await expect(page.getByRole("button",{name:"2026.10.07",exact:true})).toBeFocused();
  await page.keyboard.press("Escape");await expect(field).toBeFocused();
});
test("datetime same-day minimum, exact maximum and manual time bounds",async({page})=>{
  await page.getByLabel("예약 날짜",{exact:true}).click();
  await expect(page.getByRole("button",{name:"2026.10.06",exact:true})).toBeEnabled();
  await expect(page.getByRole("button",{name:"2026.10.05",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"2026.10.06",exact:true}).click();
  const time=page.getByLabel("예약 시각",{exact:true});
  await time.fill("09:00");await expect(time).toHaveAttribute("aria-invalid","true");
  await expect(page.getByTestId("datetime-value")).toHaveText("2026-10-06T10:00");
  await time.fill("10:30");await expect(page.getByTestId("datetime-value")).toHaveText("2026-10-06T10:30");
  await page.getByLabel("예약 날짜",{exact:true}).fill("2026-10-08");
  await time.fill("18:16");await expect(time).toHaveAttribute("aria-invalid","true");
  await time.fill("18:15");await expect(page.getByTestId("datetime-value")).toHaveText("2026-10-08T18:15");
});
test("range does not silently swap and direct reverse blocks form validity",async({page})=>{
  await page.getByLabel("시작일",{exact:true}).click();
  await page.getByRole("button",{name:"2026.10.08",exact:true}).click();
  await expect(page.getByRole("button",{name:"2026.10.07",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"2026.10.09",exact:true}).click();
  await page.getByRole("button",{name:"적용",exact:true}).click();
  await expect(page.getByTestId("range-value")).toHaveText('{"from":"2026-10-08","to":"2026-10-09"}');
  const to=page.getByLabel("종료일",{exact:true});await to.fill("2026-10-07");
  await expect(to).toHaveAttribute("aria-invalid","true");
  expect(await to.evaluate((el:HTMLInputElement)=>el.checkValidity())).toBe(false);
  await expect(page.getByRole("alert")).toContainText("종료일은 시작일 이후");
});
test("standalone time selector exact boundaries, manual input, readonly, disabled",async({page})=>{
  const time=page.getByLabel("단독 시각",{exact:true});
  await time.click();await expect(page.getByRole("button",{name:"10:00",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"11:45",exact:true}).click();
  await expect(page.getByTestId("time-value")).toHaveText("11:45");
  await time.fill("12:00");await expect(time).toHaveAttribute("aria-invalid","true");
  await expect(page.getByTestId("time-value")).toHaveText("11:45");
  await time.fill("1030");await time.blur();await expect(time).toHaveValue("10:30");
  await page.getByLabel("읽기 전용 시각",{exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("비활성 시각",{exact:true})).toBeDisabled();
});
test("parent modal focus remains usable and first Escape only closes calendar",async({page})=>{
  await page.getByRole("button",{name:"모달 열기",exact:true}).click();
  const field=page.getByLabel("모달 날짜",{exact:true});await field.click();await field.press("ArrowDown");
  await page.keyboard.press("Tab");expect(await page.evaluate(()=>!!document.activeElement?.closest(".dt-pop"))).toBe(true);
  await page.keyboard.press("Escape");await expect(page.getByRole("dialog",{name:"날짜 모달",exact:true})).toBeVisible();await expect(field).toBeFocused();
  await page.keyboard.press("Escape");await expect(page.getByRole("dialog")).toHaveCount(0);
});
