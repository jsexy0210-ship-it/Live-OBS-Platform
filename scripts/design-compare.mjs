#!/usr/bin/env node
// 디자인 정본 보드 ↔ 구현 스크린샷 나란히 비교(정본 1:1 맞춤 검수 증거, MASTER 지시 2026-10-06).
// 사용: node scripts/design-compare.mjs <보드ID> <구현1440.png> [구현390.png] <출력.png> [--state N]
//   예) node scripts/design-compare.mjs PF-007-4 tests/e2e/screenshots/PF-007-4-1440.png tests/e2e/screenshots/PF-007-4-390.png /tmp/PF-007-4.png
// 보드(design/project/<ID>.dc.html)를 임시 정적 서버로 열어 폭 1000 이상인 첫 `.app`(1440 본판)과 폭 390인 `.app`(휴대폰 변형)을 캡처하고,
// 구현 스크린샷과 한 장에 나란히 붙인다(왼쪽 정본 · 오른쪽 구현). 서체는 저장소의 Wanted Sans(public/fonts)로 맞춘다.
// 보드 런타임(support.js)이 없어 상호작용·홀({{…}})은 렌더되지 않는다(design/README.md). 출력 PNG는 PR 본문·검수 요청에 붙이는 증거이며 저장소에 커밋하지 않아도 된다.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const stateAt = args.indexOf("--state");
const state = stateAt >= 0 ? Number(args.splice(stateAt, 2)[1]) : null;
const files = args.filter((a) => a !== "-");
const [id] = files;
const out = files[files.length - 1];
const impl = files.slice(1, -1);
const tsxCanonical = id === "PF-003";
if (!id || !out || (tsxCanonical ? impl.length !== 3 : impl.length === 0 || impl.length > 2)) {
  console.error("사용: node scripts/design-compare.mjs <보드ID> <구현1440.png> [구현390.png] <출력.png> [--state N]");
  if (tsxCanonical) console.error("PF-003 TSX 정본: design:preview를 먼저 실행하고, 구현1440.png 구현1024.png 구현390.png 출력.png을 지정하세요.");
  process.exit(2);
}
const [impl1440, impl390] = impl;

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png" };
let server;
let base;
if (tsxCanonical) {
  base = process.env.DESIGN_PREVIEW_URL ?? "http://127.0.0.1:3001";
} else {
  server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
    // 폰트는 보드가 가리키는 fonts/ 대신 저장소의 public/fonts를 쓴다
    const file = u.startsWith("/fonts/") ? path.join(root, "public", u) : path.join(root, u);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "access-control-allow-origin": "*" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
const stem = out.replace(/\.png$/, "");
const shots = {};
if (tsxCanonical) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const response = await page.goto(base, { waitUntil: "networkidle" });
    if (!response?.ok()) throw new Error(`PF-003 TSX 미리보기를 열 수 없습니다: ${base} (${response?.status() ?? "응답 없음"})`);
    const image = `${stem}-tsx-${width}.png`;
    await page.screenshot({ path: image });
    shots[width] = image;
  }
} else {
  await page.goto(`${base}/design/project/${id}.dc.html`, { waitUntil: "load" });
  await page.addStyleTag({ url: `${base}/styles/wanted-sans.css` });
  await page.addStyleTag({ content: `.app,.app *{font-family:"Wanted Sans Variable","Wanted Sans",sans-serif}` });
  await page.waitForTimeout(800);
  const apps = page.locator(".app");
  let desktop = null;
  let mobile = null;
  for (let i = 0; i < (await apps.count()); i++) {
    const bb = await apps.nth(i).boundingBox();
    if (!bb) continue;
    if (desktop === null && bb.width >= 1000) desktop = i;
    if (mobile === null && Math.round(bb.width) === 390) mobile = i;
  }
  if (desktop !== null) await apps.nth(state ?? desktop).screenshot({ path: (shots.d = `${stem}-board1440.png`) });
  if (mobile !== null) await apps.nth(mobile).screenshot({ path: (shots.m = `${stem}-board390.png`) });
}
await browser.close();
server?.close();

const data = (f) => (f && fs.existsSync(f) ? `data:image/png;base64,${fs.readFileSync(f).toString("base64")}` : "");
const block = (title, board, mine) =>
  `<h3>${title}</h3><div class="pair"><figure><figcaption>정본 보드 ${id}</figcaption><img src="${data(board)}"></figure><figure><figcaption>구현</figcaption><img src="${data(mine)}"></figure></div>`;
const rows = tsxCanonical
  ? [1440, 1024, 390].map((width, index) => block(`${width}px · 1440px TSX artboard`, shots[width], impl[index])).join("")
  : `${shots.d ? block("1440", shots.d, impl1440) : ""}${shots.m ? block("390", shots.m, impl390) : ""}`;
const html = `<html><body style="margin:0;font:13px sans-serif;background:#fff"><style>h3{margin:8px}.pair{display:flex;gap:12px;align-items:flex-start;padding:0 8px}figure{margin:0;flex:1;min-width:0}figcaption{font-weight:700;padding:4px 0}img{width:100%;border:1px solid #ccc}</style>${rows}</body></html>`;
const b2 = await chromium.launch();
const pg = await b2.newPage({ viewport: { width: 2000, height: 900 } });
await pg.setContent(html);
await pg.waitForTimeout(300);
await pg.screenshot({ path: out, fullPage: true });
await b2.close();
console.log(JSON.stringify(tsxCanonical ? { id, canonical: "design/project/PF-003.dc.tsx", viewports: shots, out } : { id, board1440: shots.d ?? null, board390: shots.m ?? null, out }));
