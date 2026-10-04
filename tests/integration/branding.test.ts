import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as settingsGet } from "../../app/api/admin/branding/route";
import { PUT as textPut } from "../../app/api/admin/branding/[target]/route";
import { DELETE as faviconDelete, PUT as faviconPut } from "../../app/api/admin/branding/[target]/favicon/route";
import { DELETE as ogDelete, PUT as ogPut } from "../../app/api/admin/branding/[target]/og-image/route";
import { GET as previewGet } from "../../app/api/admin/branding/card-preview/route";
import { GET as publicFavicon } from "../../app/api/branding/[target]/favicon/route";
import { GET as publicOg } from "../../app/api/branding/[target]/og/route";
import { loginAdmin, loginSeller } from "../../lib/server/auth/login";
import { brandingMetadata } from "../../lib/server/branding/metadata";
import { prisma } from "../../lib/server/db";
import { PASSWORD, adminCredentials, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 화면 head 값(generateMetadata)은 요청 헤더를 읽는다: 테스트에서는 요청 헤더를 정해 준다
const reqHeaders = vi.hoisted(() => ({ value: new Headers({ host: "test.on-aircue.com" }) }));
vi.mock("next/headers", () => ({ headers: async () => reqHeaders.value }));

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const ctx = (target: string) => ({ params: Promise.resolve({ target }) });

const adminCookie = async (role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") => {
  const admin = await createAdmin(role);
  const r = await loginAdmin(db, adminCredentials(admin), {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_admin=${r.token}`;
};
const sellerCookie = async () => {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
};

const upload = (fn: typeof faviconPut, target: string, body: Buffer, cookie: string, headers: Record<string, string> = {}) =>
  fn(new Request(`${BASE}/api/admin/branding/${target}/x`, { method: "PUT", headers: { ...H, cookie, "content-type": "application/octet-stream", ...headers }, body: new Uint8Array(body) }), ctx(target));
const remove = (fn: typeof faviconDelete, target: string, cookie: string) => fn(new Request(`${BASE}/api/admin/branding/${target}/x`, { method: "DELETE", headers: { ...H, cookie } }), ctx(target));
const putText = (target: string, body: unknown, cookie: string) =>
  textPut(new Request(`${BASE}/api/admin/branding/${target}`, { method: "PUT", headers: { ...H, cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), ctx(target));
const settings = (cookie: string) => settingsGet(new Request(`${BASE}/api/admin/branding`, { headers: { ...H, cookie } }));

const png = (w: number, h: number, color = "#ff6600") => sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer();
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

describe("브랜딩 권한", () => {
  it("최고관리자만 바꾸고, 운영·고객 지원·조회 전용은 403(보기는 됨), 파트너스 세션·로그인 없음은 401, 다른 출처는 403", async () => {
    const icon = await png(64, 64);
    const superCookie = await adminCookie("SUPER_ADMIN");
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) {
      const c = await adminCookie(role);
      expect((await upload(faviconPut, "admin", icon, c)).status).toBe(403);
      expect((await remove(faviconDelete, "admin", c)).status).toBe(403);
      expect((await upload(ogPut, "seller", await png(1200, 630), c)).status).toBe(403);
      expect((await putText("seller", { title: "바꿈", description: null }, c)).status).toBe(403);
      expect((await previewGet(new Request(`${BASE}/api/admin/branding/card-preview?title=a`, { headers: { ...H, cookie: c } }))).status).toBe(403);
      const s = await settings(c);
      expect(s.status).toBe(200);
      expect((await s.json()).canEdit).toBe(false);
    }
    const seller = await sellerCookie();
    expect((await upload(faviconPut, "seller", icon, seller)).status).toBe(401);
    expect((await putText("seller", { title: "판매자", description: null }, seller)).status).toBe(401);
    expect((await settings(seller)).status).toBe(401);
    expect((await upload(faviconPut, "seller", icon, "")).status).toBe(401);
    const cross = await faviconPut(
      new Request(`${BASE}/api/admin/branding/admin/favicon`, { method: "PUT", headers: { host: "localhost:3000", origin: "https://evil.example", cookie: superCookie }, body: new Uint8Array(icon) }),
      ctx("admin"),
    );
    expect(cross.status).toBe(403);
    expect(await db.siteBranding.count()).toBe(0);
    expect(await db.auditLog.count({ where: { action: { startsWith: "branding." } } })).toBe(0);
    expect((await (await settings(superCookie)).json()).canEdit).toBe(true);
  });

  it("없는 대상은 404", async () => {
    const c = await adminCookie("SUPER_ADMIN");
    expect((await upload(faviconPut, "shop", await png(32, 32), c)).status).toBe(404);
    expect((await publicFavicon(new Request(`${BASE}/api/branding/x/favicon`), ctx("x"))).status).toBe(404);
  });
});

describe("파비콘", () => {
  it("올리면 대상별로 저장되고 공개 주소가 그 바이트를 형식·nosniff·버전 캐시와 함께 주며, 되돌리면 404. 감사 로그에 남는다", async () => {
    const c = await adminCookie("SUPER_ADMIN");
    const icon = await png(64, 64);
    const r = await upload(faviconPut, "admin", icon, c);
    expect(r.status).toBe(200);
    const { branding } = await r.json();
    expect(branding.favicon).toEqual({ url: expect.stringMatching(/^\/api\/branding\/admin\/favicon\?v=[0-9a-f]{12}$/), type: "image/png" });
    // 파트너스 관리자 쪽은 그대로
    expect((await publicFavicon(new Request(`${BASE}/api/branding/seller/favicon`), ctx("seller"))).status).toBe(404);
    const got = await publicFavicon(new Request(`${BASE}${branding.favicon.url}`), ctx("admin"));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(Buffer.from(await got.arrayBuffer()).equals(icon)).toBe(true);
    // 버전이 다르거나 없으면 짧게
    expect((await publicFavicon(new Request(`${BASE}/api/branding/admin/favicon`), ctx("admin"))).headers.get("cache-control")).toBe("public, max-age=300");
    // 바꾸면 주소(버전)가 바뀐다
    const second = await (await upload(faviconPut, "admin", await png(64, 64, "#0000ff"), c)).json();
    expect(second.branding.favicon.url).not.toBe(branding.favicon.url);
    const reset = await remove(faviconDelete, "admin", c);
    expect((await reset.json()).branding.favicon).toBeNull();
    expect((await publicFavicon(new Request(`${BASE}/api/branding/admin/favicon`), ctx("admin"))).status).toBe(404);
    const logs = await db.auditLog.findMany({ where: { targetType: "SiteBranding" }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["branding.favicon.update", "branding.favicon.update", "branding.favicon.reset"]);
    expect(logs[0]).toMatchObject({ actorType: "PLATFORM_ADMIN", targetId: "admin", after: { type: "image/png", bytes: icon.length, width: 64, height: 64 } });
  });

  it("SVG·위장 파일(PNG라고 보낸 SVG)·크기 초과는 거부하고 저장하지 않는다", async () => {
    const c = await adminCookie("SUPER_ADMIN");
    const svg = await upload(faviconPut, "seller", SVG, c, { "content-type": "image/png" });
    expect(svg.status).toBe(400);
    expect(await svg.json()).toEqual({ error: "unsupported_image", message: "파비콘은 PNG·ICO 파일만 업로드할 수 있습니다." });
    const big = await upload(faviconPut, "seller", Buffer.concat([await png(32, 32), Buffer.alloc(300 * 1024)]), c);
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "file_too_large", message: "파비콘이 256KB를 넘습니다. 256KB 이하 PNG·ICO로 줄여 주십시오." });
    expect((await upload(faviconPut, "seller", Buffer.alloc(0), c)).status).toBe(400);
    expect(await db.siteBranding.count()).toBe(0);
  });

  it("DB 제약도 형식·크기를 막는다(코드를 거치지 않은 쓰기)", async () => {
    await expect(db.siteBranding.create({ data: { target: "admin", faviconData: Buffer.from("x"), faviconType: "image/svg+xml", faviconHash: "a" } })).rejects.toThrow();
    await expect(db.siteBranding.create({ data: { target: "shop" } })).rejects.toThrow();
    // 형식만 비운 행(데이터·해시는 있음)도 막는다(Codex 지적 4차: NULL과 비교하면 CHECK를 통과하던 문제)
    await expect(db.siteBranding.create({ data: { target: "admin", faviconData: Buffer.from("x"), faviconHash: "a" } })).rejects.toThrow();
    await expect(db.siteBranding.create({ data: { target: "seller", ogImageData: Buffer.from("x"), ogImageHash: "a" } })).rejects.toThrow();
    await expect(db.siteBranding.create({ data: { target: "seller", ogImageData: Buffer.from("x"), ogImageType: "image/jpeg", ogImageHash: "a" } })).rejects.toThrow();
    await expect(db.siteBranding.create({ data: { target: "admin", faviconData: Buffer.alloc(262145), faviconType: "image/png", faviconHash: "a" } })).rejects.toThrow();
  });
});

describe("공유 카드", () => {
  it("기본값은 대상별 기본 제목으로 그린 카드(PNG 1200×630), 제목을 바꾸면 카드 주소(버전)가 바뀐다", async () => {
    const c = await adminCookie("SUPER_ADMIN");
    const before = (await (await settings(c)).json()).targets.find((t: { target: string }) => t.target === "seller");
    expect(before).toMatchObject({ title: null, description: null, favicon: null, ogImage: { uploaded: false, width: 1200, height: 630 } });
    const og = await publicOg(new Request(`${BASE}${before.ogImage.url}`), ctx("seller"));
    expect(og.headers.get("content-type")).toBe("image/png");
    expect(og.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await sharp(Buffer.from(await og.arrayBuffer())).metadata()).toMatchObject({ width: 1200, height: 630, format: "png" });
    const r = await putText("seller", { title: "온큐 파트너스 센터", description: "방송 주문을 한곳에서" }, c);
    expect(r.status).toBe(200);
    const after = (await r.json()).branding;
    expect(after).toMatchObject({ title: "온큐 파트너스 센터", description: "방송 주문을 한곳에서" });
    expect(after.ogImage.url).not.toBe(before.ogImage.url);
    expect(await db.auditLog.count({ where: { action: "branding.text.update", targetId: "seller" } })).toBe(1);
  });

  it("제목 60자·설명 160자 초과, 보이지 않는 문자는 400. 빈 값은 기본값으로", async () => {
    const c = await adminCookie("SUPER_ADMIN");
    for (const body of [{ title: "가".repeat(61), description: null }, { title: null, description: "나".repeat(161) }, { title: "‮관리자", description: null }, { title: 5 }]) {
      const r = await putText("admin", body, c);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("invalid_branding_text");
    }
    expect((await putText("admin", { title: "", description: "" }, c)).status).toBe(200);
    expect(await db.siteBranding.findUniqueOrThrow({ where: { target: "admin" }, select: { ogTitle: true, ogDescription: true } })).toEqual({ ogTitle: null, ogDescription: null });
  });

  it("1200×630 이미지를 올리면 그 이미지를 주고, 다른 크기·SVG는 거부, 되돌리면 다시 그린 카드", async () => {
    const c = await adminCookie("SUPER_ADMIN");
    expect((await upload(ogPut, "admin", await png(1000, 630), c)).status).toBe(400);
    expect((await upload(ogPut, "admin", SVG, c)).status).toBe(400);
    // JPEG는 받지 않는다(PNG만)
    expect((await upload(ogPut, "admin", await sharp({ create: { width: 1200, height: 630, channels: 3, background: "#2244aa" } }).jpeg().toBuffer(), c)).status).toBe(400);
    const image = await png(1200, 630, "#2244aa");
    const r = await upload(ogPut, "admin", image, c);
    expect(r.status).toBe(200);
    const { branding } = await r.json();
    expect(branding.ogImage.uploaded).toBe(true);
    const got = await publicOg(new Request(`${BASE}${branding.ogImage.url}`), ctx("admin"));
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await got.arrayBuffer()).equals(image)).toBe(true);
    const reset = await (await remove(ogDelete, "admin", c)).json();
    expect(reset.branding.ogImage.uploaded).toBe(false);
    expect((await publicOg(new Request(`${BASE}${reset.branding.ogImage.url}`), ctx("admin"))).headers.get("content-type")).toBe("image/png");
    expect(await db.auditLog.count({ where: { action: { in: ["branding.og_image.update", "branding.og_image.reset"] } } })).toBe(2);
  });

  it("저장 전 미리보기는 입력한 제목으로 그린 PNG를 캐시 없이 준다", async () => {
    const c = await adminCookie("SUPER_ADMIN");
    const r = await previewGet(new Request(`${BASE}/api/admin/branding/card-preview?title=${encodeURIComponent("미리보기 제목")}`, { headers: { ...H, cookie: c } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await sharp(Buffer.from(await r.arrayBuffer())).metadata()).toMatchObject({ width: 1200, height: 630 });
    expect((await previewGet(new Request(`${BASE}/api/admin/branding/card-preview?title=`, { headers: { ...H, cookie: c } }))).status).toBe(400);
  });
});

describe("관리자 화면 head 값(generateMetadata)", () => {
  it("올린 파비콘·제목·설명·카드가 대상 화면에만 들어가고, og:image는 요청 호스트 기준 절대 주소", async () => {
    const c = await adminCookie("SUPER_ADMIN");
    const empty = await brandingMetadata("seller");
    expect(empty).toMatchObject({ title: "ONQ 파트너스 관리자", twitter: { card: "summary_large_image" } });
    expect(empty.icons).toBeUndefined();
    await upload(faviconPut, "seller", await png(48, 48), c);
    await putText("seller", { title: "파트너스 센터", description: "설명입니다" }, c);
    const m = await brandingMetadata("seller");
    const s = (await (await settings(c)).json()).targets.find((t: { target: string }) => t.target === "seller");
    expect(m).toMatchObject({
      title: "파트너스 센터",
      description: "설명입니다",
      icons: { icon: [{ url: s.favicon.url, type: "image/png" }] },
      openGraph: { title: "파트너스 센터", description: "설명입니다", images: [{ url: `http://test.on-aircue.com${s.ogImage.url}`, width: 1200, height: 630 }] },
      twitter: { card: "summary_large_image", images: [`http://test.on-aircue.com${s.ogImage.url}`] },
    });
    // 마스터 관리자 쪽은 기본값 그대로
    const admin = await brandingMetadata("admin");
    expect(admin).toMatchObject({ title: "ONQ 마스터 관리자" });
    expect(admin.icons).toBeUndefined();
  });

  it("신뢰 프록시가 아니면 X-Forwarded-Host로 주소를 바꿀 수 없고, 호스트가 이상하면 og:image를 뺀다", async () => {
    reqHeaders.value = new Headers({ host: "test.on-aircue.com", "x-forwarded-host": "evil.example" });
    const m = await brandingMetadata("admin");
    expect(JSON.stringify(m.openGraph)).toContain("http://test.on-aircue.com/api/branding/admin/og?v=");
    expect(JSON.stringify(m)).not.toContain("evil.example");
    reqHeaders.value = new Headers({ host: "evil.example/x?" });
    const bad = await brandingMetadata("admin");
    expect(bad.openGraph).not.toHaveProperty("images");
    reqHeaders.value = new Headers({ host: "test.on-aircue.com" });
  });
});
