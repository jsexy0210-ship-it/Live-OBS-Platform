import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type React from "react";
import ShopHomePage from "../../app/(shop)/shop/[slug]/page";
import { DELETE as bannerDelete, PUT as bannerPut } from "../../app/api/seller/shop-content/banners/[bannerId]/route";
import { PUT as bannerReorder } from "../../app/api/seller/shop-content/banners/reorder/route";
import { GET as bannersGet, POST as bannersPost } from "../../app/api/seller/shop-content/banners/route";
import { GET as sellerImageGet } from "../../app/api/seller/shop-content/images/[imageId]/route";
import { POST as imagePost } from "../../app/api/seller/shop-content/images/route";
import { PUT as popupPut } from "../../app/api/seller/shop-content/popups/[popupId]/route";
import { PUT as popupReorder } from "../../app/api/seller/shop-content/popups/reorder/route";
import { GET as popupsGet, POST as popupsPost } from "../../app/api/seller/shop-content/popups/route";
import { GET as publicImageGet } from "../../app/api/shop/[slug]/shop-content/images/[imageId]/route";
import { GET as publicContentGet } from "../../app/api/shop/[slug]/shop-content/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { UNUSED_IMAGE_LIMIT } from "../../lib/server/shop-content/image";
import { visibleShopContent } from "../../lib/server/shop-content/service";
import { jpeg, png, svg, svgInPng } from "../unit/shopContentFixtures";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-064 홈 배너·SA-065 이벤트 팝업(2026-10-04 대표님 지시): 권한·테넌트 격리·플랜 권한·기간(DB 시계)·링크·이미지(PNG만)·형태·감사 로그.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const json = (path: string, method: string, cookie: string, body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (path: string, cookie?: string) => new Request(BASE + path, { headers: { ...H, ...(cookie ? { cookie } : {}) } });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const MIN = 60_000;

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const settingsStaff = await createSellerUser(seller.id, { permissions: ["SHOP_SETTINGS"] });
  const otherStaff = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE", "ORDER_SHIPPING"] });
  return { seller, owner: await cookieOf(owner.email), staff: await cookieOf(settingsStaff.email), noPerm: await cookieOf(otherStaff.email) };
}

async function upload(cookie: string, bytes: Buffer, contentType = "image/png") {
  const res = await imagePost(new Request(BASE + "/api/seller/shop-content/images", { method: "POST", headers: { ...H, cookie, "content-type": contentType }, body: new Uint8Array(bytes) }));
  return { res, body: (await res.json()) as { image?: { id: string; url: string }; error?: string; message?: string } };
}

async function banner(cookie: string, extra: Record<string, unknown> = {}) {
  const img = await upload(cookie, png(1200, 400));
  const res = await bannersPost(json("/api/seller/shop-content/banners", "POST", cookie, { title: "10월 신상품", pcImageId: img.body.image!.id, ...extra }));
  return { res, body: (await res.json()) as { banner?: { id: string; status: string }; error?: string } };
}

async function popup(cookie: string, extra: Record<string, unknown> = {}) {
  const res = await popupsPost(json("/api/seller/shop-content/popups", "POST", cookie, { kind: "TEXT", title: "이번 주 방송 안내", body: "토요일 20시에 만나요", ...extra }));
  return { res, body: (await res.json()) as { popup?: { id: string; status: string }; error?: string } };
}

const publicContent = async (slug: string, page = "home") => {
  const res = await publicContentGet(get(`/api/shop/${slug}/shop-content?page=${page}`), p({ slug }));
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { banners: { id: string; pcImage: { url: string } }[]; popups: { id: string }[] }) : null };
};

const counts = async () => ({
  banners: await db.shopBanner.count(),
  popups: await db.shopPopup.count(),
  images: await db.shopContentImage.count(),
  audits: await db.auditLog.count({ where: { action: { startsWith: "shop." } } }),
});

describe("권한", () => {
  it("대표자·「쇼핑몰 설정」 직원은 추가·조회, 권한 없는 직원은 조회·변경 모두 403이고 아무것도 남지 않는다", async () => {
    const s = await shop();
    expect((await banner(s.owner)).res.status).toBe(201);
    expect((await banner(s.staff)).res.status).toBe(201);
    expect((await popup(s.staff)).res.status).toBe(201);
    expect((await bannersGet(get("/api/seller/shop-content/banners", s.staff))).status).toBe(200);

    const before = await counts();
    expect((await bannersGet(get("/api/seller/shop-content/banners", s.noPerm))).status).toBe(403);
    expect((await popupsGet(get("/api/seller/shop-content/popups", s.noPerm))).status).toBe(403);
    expect((await upload(s.noPerm, png(400, 400))).res.status).toBe(403);
    expect((await popup(s.noPerm)).res.status).toBe(403);
    const [b] = await db.shopBanner.findMany();
    expect((await bannersPost(json("/x", "POST", s.noPerm, { title: "권한 없음", pcImageId: b.pcImageId }))).status).toBe(403);
    expect((await bannerPut(json(`/api/seller/shop-content/banners/${b.id}`, "PUT", s.noPerm, { title: "x", pcImageId: b.pcImageId }), p({ bannerId: b.id }))).status).toBe(403);
    expect((await bannerDelete(json(`/api/seller/shop-content/banners/${b.id}`, "DELETE", s.noPerm), p({ bannerId: b.id }))).status).toBe(403);
    expect(await counts()).toEqual(before);
  });

  it("로그인 없음 401, 다른 출처 403", async () => {
    const s = await shop();
    expect((await bannersGet(get("/api/seller/shop-content/banners"))).status).toBe(401);
    const res = await bannersPost(
      new Request(BASE + "/api/seller/shop-content/banners", { method: "POST", headers: { host: "localhost:3000", origin: "https://evil.example", cookie: s.owner, "content-type": "application/json" }, body: "{}" }),
    );
    expect(res.status).toBe(403);
  });

  it("변경은 감사 로그(로그 추적)에 남고 이미지 바이트는 남기지 않는다", async () => {
    const s = await shop();
    const b = await banner(s.staff);
    const id = b.body.banner!.id;
    const row = await db.shopBanner.findUniqueOrThrow({ where: { id } });
    await bannerPut(json(`/api/seller/shop-content/banners/${id}`, "PUT", s.owner, { title: "바뀐 이름", pcImageId: row.pcImageId, linkUrl: "/products" }), p({ bannerId: id }));
    await bannerDelete(json(`/api/seller/shop-content/banners/${id}`, "DELETE", s.owner), p({ bannerId: id }));
    const logs = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: { startsWith: "shop." } }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["shop.content_image.upload", "shop.banner.create", "shop.banner.update", "shop.banner.delete"]);
    expect(logs[2].before).toMatchObject({ title: "10월 신상품", linkUrl: null });
    expect(logs[2].after).toMatchObject({ title: "바뀐 이름", linkUrl: "/products" });
    expect(JSON.stringify(logs[0].after)).not.toContain("data");
    // 배너를 지우면 그 배너만 쓰던 이미지도 지운다
    expect(await db.shopContentImage.count({ where: { sellerId: s.seller.id } })).toBe(0);
  });
});

describe("테넌트 격리", () => {
  it("다른 쇼핑몰의 배너·팝업은 404, 다른 쇼핑몰 이미지는 쓸 수도 볼 수도 없다", async () => {
    const a = await shop();
    const b = await shop();
    const ab = await banner(a.owner);
    const ap = await popup(a.owner);
    const aRow = await db.shopBanner.findUniqueOrThrow({ where: { id: ab.body.banner!.id } });
    const before = await counts();

    expect((await bannerPut(json("/x", "PUT", b.owner, { title: "탈취", pcImageId: aRow.pcImageId }), p({ bannerId: aRow.id }))).status).toBe(404);
    expect((await bannerDelete(json("/x", "DELETE", b.owner), p({ bannerId: aRow.id }))).status).toBe(404);
    expect((await popupPut(json("/x", "PUT", b.owner, { title: "탈취" }), p({ popupId: ap.body.popup!.id }))).status).toBe(404);
    // B가 A의 이미지 id로 배너를 만들면 거부
    const res = await bannersPost(json("/api/seller/shop-content/banners", "POST", b.owner, { title: "남의 이미지", pcImageId: aRow.pcImageId }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_image");
    // 관리자 미리보기 이미지도 404
    expect((await sellerImageGet(get("/x", b.owner), p({ imageId: aRow.pcImageId }))).status).toBe(404);
    // 순서 바꾸기에 남의 id를 섞으면 409
    expect((await bannerReorder(json("/x", "PUT", b.owner, { ids: [aRow.id] }))).status).toBe(409);
    // B 쇼핑몰 주소로 A 이미지를 열 수 없다
    expect((await publicImageGet(get("/x"), p({ slug: b.seller.slug, imageId: aRow.pcImageId }))).status).toBe(404);
    expect(await counts()).toEqual(before);
    expect((await db.shopBanner.findUniqueOrThrow({ where: { id: aRow.id } })).title).toBe("10월 신상품");
  });

  it("DB도 다른 쇼핑몰 이미지를 가리키는 배너를 막는다(복합 외래키)", async () => {
    const a = await shop();
    const b = await shop();
    const img = await upload(a.owner, png(400, 400));
    await expect(db.shopBanner.create({ data: { sellerId: b.seller.id, title: "x", pcImageId: img.body.image!.id } })).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("플랜 기능 권한", () => {
  it("오버레이 전용은 관리 API 403 plan_feature_required, 구매자 표시·이미지는 404, 홈은 안내 화면", async () => {
    const s = await shop();
    const b = await banner(s.owner);
    const row = await db.shopBanner.findUniqueOrThrow({ where: { id: b.body.banner!.id } });
    const plan = await db.subscriptionPlan.upsert({ where: { code: "OVERLAY_ONLY" }, create: { code: "OVERLAY_ONLY", name: "OVERLAY_ONLY", listPrice: 99_000, salePrice: 69_000 }, update: {} });
    await db.sellerSubscription.create({ data: { sellerId: s.seller.id, planId: plan.id, status: "ACTIVE" } });
    const before = await counts();

    for (const res of [
      await bannersGet(get("/x", s.owner)),
      await popupsGet(get("/x", s.owner)),
      await bannerDelete(json("/x", "DELETE", s.owner), p({ bannerId: row.id })),
    ]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("plan_feature_required");
    }
    for (const r of [await upload(s.owner, png(400, 400)), await popup(s.owner)]) {
      expect(r.res.status).toBe(403);
      expect(r.body.error).toBe("plan_feature_required");
    }
    expect((await publicContent(s.seller.slug)).status).toBe(404);
    expect((await publicImageGet(get("/x"), p({ slug: s.seller.slug, imageId: row.pcImageId }))).status).toBe(404);
    const html = renderToStaticMarkup((await ShopHomePage({ params: Promise.resolve({ slug: s.seller.slug }) })) as React.ReactElement);
    expect(html).toContain("지금은 쇼핑몰을 이용할 수 없어요");
    expect(html).not.toContain("hb-track");
    expect(await counts()).toEqual(before);
  });
});

describe("기간(DB 시계)·대상·노출", () => {
  it("시작 전·종료 뒤·숨김은 구매자에게 안 보이고, 기간 안만 보인다", async () => {
    const s = await shop();
    const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const live = await banner(s.owner, { startsAt: iso(-MIN), endsAt: iso(60 * MIN) });
    const future = await banner(s.owner, { startsAt: iso(60 * MIN) });
    const ended = await banner(s.owner, { endsAt: iso(-1) });
    const hidden = await banner(s.owner, { isActive: false });
    const open = await banner(s.owner);
    expect([live, future, ended, hidden, open].map((b) => b.body.banner!.status)).toEqual(["live", "scheduled", "ended", "hidden", "live"]);

    const c = await publicContent(s.seller.slug);
    expect(c.body!.banners.map((b) => b.id)).toEqual([live.body.banner!.id, open.body.banner!.id]);
    // 공개 이미지: 보이는 배너 이미지만 열리고, 예약 배너 이미지는 404
    const liveImg = await publicImageGet(get(c.body!.banners[0].pcImage.url), p({ slug: s.seller.slug, imageId: (await db.shopBanner.findUniqueOrThrow({ where: { id: live.body.banner!.id } })).pcImageId }));
    expect(liveImg.status).toBe(200);
    expect(liveImg.headers.get("content-type")).toBe("image/png");
    expect(liveImg.headers.get("x-content-type-options")).toBe("nosniff");
    expect(liveImg.headers.get("cache-control")).toContain("immutable");
    const futureRow = await db.shopBanner.findUniqueOrThrow({ where: { id: future.body.banner!.id } });
    expect((await publicImageGet(get("/x"), p({ slug: s.seller.slug, imageId: futureRow.pcImageId }))).status).toBe(404);
  });

  it("경계(DB 시계 T): 시작 = T면 게시, 종료 = T면 종료, 종료 = T+1ms면 게시, 시작 = T+1ms면 예약", async () => {
    const s = await shop();
    const b = await banner(s.owner);
    const id = b.body.banner!.id;
    // 한 트랜잭션 안에서는 now()가 같은 값이라 경계값을 정확히 맞출 수 있다(기간 칸과 같은 밀리초 정밀도로 자른 값 T)
    const visibleAt = (set: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      db.$transaction(async (tx) => {
        await set(tx);
        const c = await visibleShopContent(tx as unknown as PrismaClient, s.seller.slug, "home");
        return c!.banners.length;
      });
    expect(await visibleAt((tx) => tx.$executeRaw`UPDATE "ShopBanner" SET "startsAt" = date_trunc('milliseconds', now()), "endsAt" = NULL WHERE "id" = ${id}::uuid`)).toBe(1);
    expect(await visibleAt((tx) => tx.$executeRaw`UPDATE "ShopBanner" SET "startsAt" = NULL, "endsAt" = date_trunc('milliseconds', now()) WHERE "id" = ${id}::uuid`)).toBe(0);
    expect(await visibleAt((tx) => tx.$executeRaw`UPDATE "ShopBanner" SET "startsAt" = NULL, "endsAt" = date_trunc('milliseconds', now()) + interval '1 millisecond' WHERE "id" = ${id}::uuid`)).toBe(1);
    expect(await visibleAt((tx) => tx.$executeRaw`UPDATE "ShopBanner" SET "startsAt" = date_trunc('milliseconds', now()) + interval '1 millisecond', "endsAt" = NULL WHERE "id" = ${id}::uuid`)).toBe(0);
  });

  it("팝업 대상: 홈은 HOME·ALL, 다른 화면은 ALL만. 배너는 홈에서만", async () => {
    const s = await shop();
    const home = await popup(s.owner, { target: "HOME" });
    const all = await popup(s.owner, { target: "ALL", showOnPc: false });
    await banner(s.owner);
    const h = await publicContent(s.seller.slug, "home");
    expect(h.body!.popups.map((x) => x.id)).toEqual([home.body.popup!.id, all.body.popup!.id]);
    const o = await publicContent(s.seller.slug, "other");
    expect(o.body!.popups.map((x) => x.id)).toEqual([all.body.popup!.id]);
    expect(o.body!.banners).toEqual([]);
  });

  it("홈 화면은 보이는 배너와 팝업을 그린다", async () => {
    const s = await shop();
    await banner(s.owner, { linkUrl: "/products/abc" });
    await popup(s.owner, { title: "추석 연휴 배송 안내" });
    const html = renderToStaticMarkup((await ShopHomePage({ params: Promise.resolve({ slug: s.seller.slug }) })) as React.ReactElement);
    expect(html).toContain("hb-track");
    expect(html).toContain("hb-pc");
    expect(html).toContain("hb-m");
    expect(html).toContain(`href="/shop/${s.seller.slug}/products/abc"`);
    expect(html).toContain(`/api/shop/${s.seller.slug}/shop-content/images/`);
  });
});

describe("입력 검사", () => {
  it("링크: javascript:·data:·//·/\\는 400이고 저장되지 않는다", async () => {
    const s = await shop();
    const img = await upload(s.owner, png(400, 400));
    for (const linkUrl of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", " JavaScript:alert(1)"]) {
      const res = await bannersPost(json("/x", "POST", s.owner, { title: "x", pcImageId: img.body.image!.id, linkUrl }));
      expect(res.status, linkUrl).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_link");
      expect((await popup(s.owner, { linkUrl })).res.status).toBe(400);
    }
    expect(await db.shopBanner.count()).toBe(0);
    expect(await db.shopPopup.count()).toBe(0);
    // DB CHECK도 막는다
    await expect(db.shopBanner.create({ data: { sellerId: s.seller.id, title: "x", pcImageId: img.body.image!.id, linkUrl: "javascript:alert(1)" } })).rejects.toThrow();
  });

  it("기간·기기·제목 검사", async () => {
    const s = await shop();
    expect((await popup(s.owner, { startsAt: "2026-10-05T10:00:00+09:00", endsAt: "2026-10-05T10:00:00+09:00" })).body.error).toBe("invalid_period");
    expect((await popup(s.owner, { startsAt: "2026-10-05T10:00" })).body.error).toBe("invalid_period"); // 시간대 없는 값
    expect((await popup(s.owner, { showOnPc: false, showOnMobile: false })).body.error).toBe("invalid_device");
    expect((await popup(s.owner, { title: "가".repeat(41) })).body.error).toBe("invalid_title");
    expect((await popup(s.owner, { title: "‮방향 바꿈" })).body.error).toBe("invalid_title");
    expect((await popup(s.owner, { target: "CART" })).body.error).toBe("invalid_target");
    const ok = await popup(s.owner, { startsAt: "2026-10-05T10:00:00+09:00", endsAt: "2026-10-06T00:00:00+09:00" });
    const row = await db.shopPopup.findUniqueOrThrow({ where: { id: ok.body.popup!.id } });
    expect(row.startsAt!.toISOString()).toBe("2026-10-05T01:00:00.000Z");
  });

  it("이미지: PNG만, 내용으로 확인한다(PNG라고 보낸 JPEG·SVG·위장 파일 거부), 2MB 초과는 413", async () => {
    const s = await shop();
    expect((await upload(s.owner, svg(), "image/png")).body).toMatchObject({ error: "unsupported_image", message: "PNG 파일만 올릴 수 있습니다" });
    expect((await upload(s.owner, svgInPng())).body.error).toBe("unsupported_image");
    expect((await upload(s.owner, jpeg(1200, 400), "image/png")).body.error).toBe("unsupported_image");
    expect((await upload(s.owner, png(50, 50))).body.error).toBe("wrong_image_size");
    expect((await upload(s.owner, Buffer.alloc(2 * 1024 * 1024 + 1))).res.status).toBe(413);
    expect(await db.shopContentImage.count()).toBe(0);
    const ok = await upload(s.owner, png(750, 750), "image/jpeg");
    expect(ok.res.status).toBe(201);
    expect((await db.shopContentImage.findUniqueOrThrow({ where: { id: ok.body.image!.id } })).contentType).toBe("image/png");
    const pv = await sellerImageGet(get(ok.body.image!.url, s.owner), p({ imageId: ok.body.image!.id }));
    expect(pv.headers.get("content-type")).toBe("image/png");
    expect(pv.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pv.headers.get("cache-control")).toContain("private");
    // DB도 PNG가 아닌 형식을 막는다
    await expect(
      db.shopContentImage.create({ data: { sellerId: s.seller.id, data: new Uint8Array(4), contentType: "image/jpeg", byteSize: 4, width: 200, height: 200, sha256: "0".repeat(64) } }),
    ).rejects.toThrow();
  });

  it("팝업 형태: 이미지 팝업은 이미지, 글 팝업은 내용이 필요하고, 상단 띠는 이미지·내용·버튼 이름을 버린다", async () => {
    const s = await shop();
    expect((await popup(s.owner, { kind: "IMAGE" })).body.error).toBe("invalid_image");
    expect((await popup(s.owner, { kind: "TEXT", body: "" })).body.error).toBe("invalid_body");
    expect((await popup(s.owner, { kind: "POPUP" })).body.error).toBe("invalid_kind");
    expect((await popup(s.owner, { dismissDays: 3 })).body.error).toBe("invalid_dismiss");
    const img = await upload(s.owner, png(600, 600));
    const image = await popup(s.owner, { kind: "IMAGE", imageId: img.body.image!.id, body: null, dismissDays: 7 });
    expect(image.res.status).toBe(201);
    const bar = await popup(s.owner, { kind: "BAR", imageId: img.body.image!.id, body: "버려짐", linkUrl: "/products", linkLabel: "버려짐", dismissDays: 0, target: "ALL" });
    expect(bar.res.status).toBe(201);
    const row = await db.shopPopup.findUniqueOrThrow({ where: { id: bar.body.popup!.id } });
    expect(row).toMatchObject({ kind: "BAR", imageId: null, body: null, linkLabel: null, linkUrl: "/products", dismissDays: 0 });
    const c = await publicContent(s.seller.slug, "other");
    expect(c.body!.popups).toEqual([expect.objectContaining({ id: row.id, kind: "BAR", dismissDays: 0, link: { href: `/shop/${s.seller.slug}/products`, external: false } })]);
    // DB CHECK: 이미지 없는 이미지 팝업, 정해지지 않은 보지 않기 기간
    await expect(db.shopPopup.create({ data: { sellerId: s.seller.id, kind: "IMAGE", title: "x" } })).rejects.toThrow();
    await expect(db.shopPopup.create({ data: { sellerId: s.seller.id, kind: "BAR", title: "x", dismissDays: 3 } })).rejects.toThrow();
  });

  it("팝업 「보지 않기」 버전: 순서·기간·노출만 바꾸면 그대로, 구매자에게 보이는 내용을 바꾸면 달라진다", async () => {
    const s = await shop();
    const a = (await popup(s.owner, { title: "첫째" })).body.popup!.id;
    const b = (await popup(s.owner, { title: "둘째" })).body.popup!.id;
    const versions = async () => Object.fromEntries((await publicContent(s.seller.slug)).body!.popups.map((x) => [x.id, (x as unknown as { version: string }).version]));
    const before = await versions();
    expect((await popupReorder(json("/x", "PUT", s.owner, { ids: [b, a] }))).status).toBe(200);
    await popupPut(json("/x", "PUT", s.owner, { kind: "TEXT", title: "첫째", body: "토요일 20시에 만나요", endsAt: "2099-01-01T00:00:00+09:00" }), p({ popupId: a }));
    expect(await versions()).toEqual(before);
    await popupPut(json("/x", "PUT", s.owner, { kind: "TEXT", title: "첫째", body: "일요일로 바뀌었어요" }), p({ popupId: a }));
    const after = await versions();
    expect(after[a]).not.toBe(before[a]);
    expect(after[b]).toBe(before[b]);
  });

  it("배너 표시 기기: PC만·모바일만은 구매자 응답에 그대로, 둘 다 끄면 400", async () => {
    const s = await shop();
    expect((await banner(s.owner, { showOnPc: false, showOnMobile: false })).body.error).toBe("invalid_device");
    const pcOnly = await banner(s.owner, { showOnMobile: false });
    expect(pcOnly.res.status).toBe(201);
    const c = await publicContent(s.seller.slug);
    expect(c.body!.banners).toEqual([expect.objectContaining({ id: pcOnly.body.banner!.id, showOnPc: true, showOnMobile: false })]);
  });

  it(`쓰지 않은 이미지는 ${UNUSED_IMAGE_LIMIT}개까지`, async () => {
    const s = await shop();
    const bytes = png(120, 120);
    await db.shopContentImage.createMany({
      data: Array.from({ length: UNUSED_IMAGE_LIMIT }, () => ({ sellerId: s.seller.id, data: new Uint8Array(bytes), contentType: "image/png", byteSize: bytes.length, width: 120, height: 120, sha256: "0".repeat(64) })),
    });
    expect((await upload(s.owner, bytes)).body.error).toBe("too_many_unused_images");
    // 하루 지난 쓰지 않은 이미지는 다음 업로드 때 지운다
    await db.$executeRaw`UPDATE "ShopContentImage" SET "createdAt" = now() - interval '2 days' WHERE "sellerId" = ${s.seller.id}::uuid`;
    expect((await upload(s.owner, bytes)).res.status).toBe(201);
    expect(await db.shopContentImage.count({ where: { sellerId: s.seller.id } })).toBe(1);
  });
});

describe("순서", () => {
  it("끌어서 바꾼 순서를 저장하고, 빠지거나 겹친 목록은 409", async () => {
    const s = await shop();
    const ids = [(await banner(s.owner)).body.banner!.id, (await banner(s.owner)).body.banner!.id, (await banner(s.owner)).body.banner!.id];
    expect((await bannerReorder(json("/x", "PUT", s.staff, { ids: [ids[2], ids[0], ids[1]] }))).status).toBe(200);
    const list = (await (await bannersGet(get("/x", s.owner))).json()) as { banners: { id: string }[] };
    expect(list.banners.map((b) => b.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect((await publicContent(s.seller.slug)).body!.banners.map((b) => b.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect((await bannerReorder(json("/x", "PUT", s.owner, { ids: [ids[0], ids[1]] }))).status).toBe(409);
    expect((await bannerReorder(json("/x", "PUT", s.owner, { ids: [ids[0], ids[0], ids[1]] }))).status).toBe(409);
    expect((await bannerReorder(json("/x", "PUT", s.noPerm, { ids }))).status).toBe(403);
  });

  it("배너는 10개까지", async () => {
    const s = await shop();
    for (let i = 0; i < 10; i++) expect((await banner(s.owner)).res.status).toBe(201);
    const over = await banner(s.owner);
    expect(over.res.status).toBe(409);
    expect(over.body.error).toBe("too_many");
  });
});
