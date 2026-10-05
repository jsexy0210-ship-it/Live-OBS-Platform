import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PUT as categoryPut } from "../../app/api/admin/service-vendor-categories/[category]/route";
import { GET as logoGet, DELETE as logoDelete, PUT as logoPut } from "../../app/api/admin/service-vendors/[id]/logo/route";
import { PATCH as vendorPatch } from "../../app/api/admin/service-vendors/[id]/route";
import { GET as listGet, POST as vendorPost } from "../../app/api/admin/service-vendors/route";
import { loginAdmin, loginSeller } from "../../lib/server/auth/login";
import { vendorScore } from "../../lib/server/admin/serviceVendors";
import { PASSWORD, adminCredentials, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 외부 서비스 업체 등록·비교(/api/admin/service-vendors, 마스터 관리자). 권한(조회 전원·변경 최고관리자/운영), 점수, 추천·선택, 로고, 로그 추적.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const catCtx = (category: string) => ({ params: Promise.resolve({ category }) });

const adminCookie = async (role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "SUPER_ADMIN") => {
  const admin = await createAdmin(role);
  const r = await loginAdmin(db, adminCredentials(admin), {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_admin=${r.token}`;
};
const json = (cookie: string, method: string, body?: unknown) => ({ method, headers: { ...H, cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async (cookie: string, qs = "") => {
  const r = await listGet(new Request(`${BASE}/api/admin/service-vendors${qs}`, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
};
const create = async (cookie: string, body: unknown) => {
  const r = await vendorPost(new Request(`${BASE}/api/admin/service-vendors`, json(cookie, "POST", body)));
  return { status: r.status, body: await r.json() };
};
const patch = async (cookie: string, id: string, body: unknown) => {
  const r = await vendorPatch(new Request(`${BASE}/api/admin/service-vendors/${id}`, json(cookie, "PATCH", body)), idCtx(id));
  return { status: r.status, body: await r.json() };
};
const putCategory = async (cookie: string, category: string, body: unknown) => {
  const r = await categoryPut(new Request(`${BASE}/api/admin/service-vendor-categories/${category}`, json(cookie, "PUT", body)), catCtx(category));
  return { status: r.status, body: await r.json() };
};
const uploadLogo = async (cookie: string, id: string, data: Buffer) => {
  const r = await logoPut(new Request(`${BASE}/api/admin/service-vendors/${id}/logo`, { method: "PUT", headers: { ...H, cookie, "content-type": "application/octet-stream" }, body: new Uint8Array(data) }), idCtx(id));
  return { status: r.status, body: await r.json() };
};
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: "#0055ff" } }).png().toBuffer();
const logs = (action: string) => db.auditLog.findMany({ where: { action }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

const PG_ALL_TEN = { fee: 10, setupFee: 10, recurring: 10, methods: 10, api: 10, stability: 10, settlement: 10 };

describe("업체 목록·점수", () => {
  it("설정 행이 없어도 초기 가중치로 세 분야를 준다. 점수는 모든 항목을 평가했을 때만", async () => {
    const c = await adminCookie("READ_ONLY");
    const r = await list(c);
    expect(r.status).toBe(200);
    expect(r.body.categories.map((x: { category: string }) => x.category)).toEqual(["PG", "SHIPPING", "TRACKING"]);
    expect(r.body.categories[0].criteria).toEqual([
      { key: "fee", weight: 30 },
      { key: "setupFee", weight: 15 },
      { key: "recurring", weight: 15 },
      { key: "methods", weight: 15 },
      { key: "api", weight: 10 },
      { key: "stability", weight: 10 },
      { key: "settlement", weight: 5 },
    ]);
    const w = { fee: 30, setupFee: 15, recurring: 15, methods: 15, api: 10, stability: 10, settlement: 5 };
    expect(vendorScore({ ...PG_ALL_TEN }, w, "PG")).toBe(100);
    expect(vendorScore({ fee: 10, setupFee: 0, recurring: 10, methods: 10, api: 10, stability: 10, settlement: 10 }, w, "PG")).toBe(85);
    expect(vendorScore({ fee: 10 }, w, "PG")).toBeNull();
    expect(vendorScore({ ...PG_ALL_TEN }, { fee: 0, setupFee: 0, recurring: 0, methods: 0, api: 0, stability: 0, settlement: 0 }, "PG")).toBeNull();
  });

  it("category 쿼리로 한 분야만 보고, 모르는 분야는 400이다", async () => {
    const c = await adminCookie("CS");
    const r = await list(c, "?category=SHIPPING");
    expect(r.body.categories).toHaveLength(1);
    expect(r.body.categories[0].category).toBe("SHIPPING");
    expect((await list(c, "?category=FOO")).status).toBe(400);
  });
});

describe("업체 등록·수정", () => {
  it("등록하면 목록에 나오고 로그가 남는다. 점수는 평가를 다 채울 때 계산된다", async () => {
    const c = await adminCookie("OPERATIONS");
    const a = await create(c, { category: "PG", name: "  테스트페이  ", features: ["card", "card", "recurring"], referenceFee: "카드 3%대(공개 기준)", memo: "비교용", ratings: { fee: 8, api: 9 } });
    expect(a.status).toBe(201);
    expect(a.body.vendor).toMatchObject({ name: "테스트페이", features: ["card", "recurring"], referenceFee: "카드 3%대(공개 기준)", ratedCount: 2, score: null, active: true, logoUrl: null, recommended: false, selected: false });
    const id = a.body.vendor.id;
    const b = await patch(c, id, { ratings: { ...PG_ALL_TEN } });
    expect(b.body.vendor.score).toBe(100);
    expect(b.body.vendor.ratedCount).toBe(7);
    const keep = await patch(c, id, { ratings: { fee: null } });
    expect(keep.body.vendor).toMatchObject({ ratedCount: 6, score: null });
    expect((await logs("service_vendor.create")).length).toBe(1);
    expect((await logs("service_vendor.update")).length).toBe(2);
    const row = (await logs("service_vendor.create"))[0];
    expect(row).toMatchObject({ actorType: "PLATFORM_ADMIN", targetId: id, before: null });
  });

  it("바뀐 값이 없으면 로그를 남기지 않고, 이름 중복은 409, 다른 분야는 같은 이름이어도 된다", async () => {
    const c = await adminCookie();
    const a = await create(c, { category: "PG", name: "A업체" });
    const id = a.body.vendor.id;
    await patch(c, id, { name: "A업체" });
    expect((await logs("service_vendor.update")).length).toBe(0);
    expect((await create(c, { category: "PG", name: "A업체" })).status).toBe(409);
    expect((await create(c, { category: "SHIPPING", name: "A업체" })).status).toBe(201);
    const b = await create(c, { category: "PG", name: "B업체" });
    expect((await patch(c, b.body.vendor.id, { name: "A업체" })).body.error).toBe("duplicate_vendor");
  });

  it("잘못된 값은 400이고 아무것도 저장되지 않는다", async () => {
    const c = await adminCookie();
    const base = { category: "PG", name: "X" };
    const bad: unknown[] = [
      null,
      [],
      {},
      { category: "FOO", name: "X" },
      { category: "PG" },
      { ...base, name: "가".repeat(41) },
      { ...base, name: "a​b" },
      { ...base, features: ["invoicePrint"] },
      { ...base, features: "card" },
      { ...base, referenceFee: "가".repeat(201) },
      { ...base, memo: "가".repeat(501) },
      { ...base, ratings: { fee: 11 } },
      { ...base, ratings: { fee: 1.5 } },
      { ...base, ratings: { invoiceIssue: 5 } },
      { ...base, ratings: { fee: "9" } },
      { ...base, active: "yes" },
      { ...base, extra: 1 },
    ];
    for (const body of bad) expect((await create(c, body)).status, JSON.stringify(body)).toBe(400);
    expect(await db.serviceVendor.count()).toBe(0);
    const ok = await create(c, base);
    for (const body of [{}, [], { foo: 1 }, { name: "" }, { features: ["x"] }, { ratings: { zzz: 1 } }, { active: 0 }]) expect((await patch(c, ok.body.vendor.id, body)).status, JSON.stringify(body)).toBe(400);
    expect((await patch(c, "not-a-uuid", { memo: "x" })).status).toBe(404);
    expect((await patch(c, "00000000-0000-4000-8000-000000000000", { memo: "x" })).status).toBe(404);
  });
});

describe("추천·선택·가중치", () => {
  it("추천 1개·선택 1개를 지정하고 바꾼다. 카드 표시용 recommended·selected가 맞는다", async () => {
    const c = await adminCookie();
    const a = (await create(c, { category: "PG", name: "A" })).body.vendor.id;
    const b = (await create(c, { category: "PG", name: "B" })).body.vendor.id;
    expect((await putCategory(c, "PG", { recommendedVendorId: a })).status).toBe(200);
    let r = (await list(c, "?category=PG")).body.categories[0];
    expect(r).toMatchObject({ recommendedVendorId: a, selectedVendorId: null });
    expect(r.vendors.map((v: { id: string; recommended: boolean; selected: boolean }) => [v.id === a ? "a" : "b", v.recommended, v.selected])).toEqual([["a", true, false], ["b", false, false]]);
    await putCategory(c, "PG", { recommendedVendorId: b, selectedVendorId: a });
    r = (await list(c, "?category=PG")).body.categories[0];
    expect(r).toMatchObject({ recommendedVendorId: b, selectedVendorId: a });
    expect(r.vendors.filter((v: { recommended: boolean }) => v.recommended)).toHaveLength(1);
    await putCategory(c, "PG", { selectedVendorId: null });
    expect((await list(c, "?category=PG")).body.categories[0]).toMatchObject({ recommendedVendorId: b, selectedVendorId: null });
    expect((await logs("service_vendor.category.update")).length).toBe(3);
  });

  it("다른 분야·없는·사용 안 함 업체는 고를 수 없고, 추천·선택 중인 업체는 사용 안 함으로 못 바꾼다", async () => {
    const c = await adminCookie();
    const pg = (await create(c, { category: "PG", name: "A" })).body.vendor.id;
    const sh = (await create(c, { category: "SHIPPING", name: "S" })).body.vendor.id;
    const off = (await create(c, { category: "PG", name: "Off", active: false })).body.vendor.id;
    for (const body of [{ recommendedVendorId: sh }, { selectedVendorId: "00000000-0000-4000-8000-000000000000" }, { recommendedVendorId: off }, { selectedVendorId: "x" }, { selectedVendorId: 5 }]) {
      expect((await putCategory(c, "PG", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await db.serviceVendorSetting.count()).toBe(0);
    await putCategory(c, "PG", { selectedVendorId: pg });
    const r = await patch(c, pg, { active: false });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("vendor_in_use");
    expect((await db.serviceVendor.findUniqueOrThrow({ where: { id: pg } })).active).toBe(true);
    await putCategory(c, "PG", { selectedVendorId: null });
    expect((await patch(c, pg, { active: false })).status).toBe(200);
    // DB 제약: 다른 분야 업체를 설정 행에 직접 넣을 수 없다
    await expect(db.$executeRaw`UPDATE "ServiceVendorSetting" SET "selectedVendorId" = ${sh}::uuid WHERE "category" = 'PG'`).rejects.toThrow();
  });

  it("가중치를 바꾸면 점수가 다시 계산된다. 모든 항목 필수, 0~100 정수, 합 0 불가", async () => {
    const c = await adminCookie();
    const v = (await create(c, { category: "PG", name: "A", ratings: { ...PG_ALL_TEN, fee: 0 } })).body.vendor.id;
    expect((await list(c, "?category=PG")).body.categories[0].vendors[0].score).toBe(70);
    const w = { fee: 100, setupFee: 0, recurring: 0, methods: 0, api: 0, stability: 0, settlement: 0 };
    const r = await putCategory(c, "PG", { weights: w });
    expect(r.status).toBe(200);
    expect(r.body.category.vendors.find((x: { id: string }) => x.id === v).score).toBe(0);
    expect(r.body.category.criteria[0]).toEqual({ key: "fee", weight: 100 });
    const { fee, ...missing } = w;
    for (const weights of [missing, { ...w, fee: 101 }, { ...w, fee: -1 }, { ...w, fee: 1.5 }, { ...w, extra: 1 }, { fee: 0, setupFee: 0, recurring: 0, methods: 0, api: 0, stability: 0, settlement: 0 }, [], null]) {
      expect((await putCategory(c, "PG", { weights })).status, JSON.stringify(weights)).toBe(400);
    }
    expect(fee).toBe(100);
    expect((await list(c, "?category=PG")).body.categories[0].criteria[0].weight).toBe(100);
    expect((await putCategory(c, "FOO", { weights: w })).status).toBe(404);
    expect((await putCategory(c, "PG", {})).status).toBe(400);
  });
});

describe("로고", () => {
  it("PNG만 올라가고, 올리면 logoUrl이 생기고 내려받을 수 있다. 지우면 null로 돌아간다", async () => {
    const c = await adminCookie("OPERATIONS");
    const id = (await create(c, { category: "PG", name: "A" })).body.vendor.id;
    const up = await uploadLogo(c, id, await png(120, 40));
    expect(up.status).toBe(200);
    expect(up.body.logoUrl).toMatch(new RegExp(`^/api/admin/service-vendors/${id}/logo\\?v=[0-9a-f]{12}$`));
    expect((await list(c, "?category=PG")).body.categories[0].vendors[0].logoUrl).toBe(up.body.logoUrl);
    const got = await logoGet(new Request(`${BASE}/api/admin/service-vendors/${id}/logo`, { headers: { ...H, cookie: c } }), idCtx(id));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer()).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const lg = await logs("service_vendor.logo.set");
    expect(lg).toHaveLength(1);
    expect(lg[0].after).toMatchObject({ type: "image/png", width: 120, height: 40 });
    const del = await logoDelete(new Request(`${BASE}/api/admin/service-vendors/${id}/logo`, json(c, "DELETE")), idCtx(id));
    expect((await del.json()).logoUrl).toBeNull();
    expect((await list(c, "?category=PG")).body.categories[0].vendors[0].logoUrl).toBeNull();
    expect((await logs("service_vendor.logo.remove")).length).toBe(1);
    const del2 = await logoDelete(new Request(`${BASE}/api/admin/service-vendors/${id}/logo`, json(c, "DELETE")), idCtx(id));
    expect(del2.status).toBe(200);
    expect((await logs("service_vendor.logo.remove")).length).toBe(1);
    const gone = await logoGet(new Request(`${BASE}/api/admin/service-vendors/${id}/logo`, { headers: { ...H, cookie: c } }), idCtx(id));
    expect(gone.status).toBe(404);
  });

  it("SVG·JPEG·손상 파일·크기 초과·치수 밖은 거부하고 저장하지 않는다", async () => {
    const c = await adminCookie();
    const id = (await create(c, { category: "PG", name: "A" })).body.vendor.id;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><script>alert(1)</script></svg>');
    const jpeg = await sharp({ create: { width: 100, height: 40, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const good = await png(100, 40);
    const truncated = good.subarray(0, good.length - 20);
    const headerOnly = Buffer.concat([good.subarray(0, 33)]);
    const cases: [string, Buffer, number, string][] = [
      ["svg", svg, 400, "unsupported_image"],
      ["jpeg", jpeg, 400, "unsupported_image"],
      ["손상", truncated, 400, "unsupported_image"],
      ["머리만", headerOnly, 400, "unsupported_image"],
      ["빈 파일", Buffer.alloc(0), 400, "empty_file"],
      ["작음", await png(15, 40), 400, "wrong_image_size"],
      ["큼", await png(601, 40), 400, "wrong_image_size"],
    ];
    for (const [name, data, status, error] of cases) {
      const r = await uploadLogo(c, id, data);
      expect([name, r.status, r.body.error]).toEqual([name, status, error]);
    }
    const big = await sharp(Buffer.alloc(600 * 600 * 4, 0).map((_, i) => (i * 2654435761) >>> 24), { raw: { width: 600, height: 600, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(big.length).toBeGreaterThan(256 * 1024);
    const r = await uploadLogo(c, id, big);
    expect([r.status, r.body.error]).toEqual([413, "file_too_large"]);
    expect(await db.serviceVendorLogo.count()).toBe(0);
    expect((await uploadLogo(c, "00000000-0000-4000-8000-000000000000", good)).status).toBe(404);
    expect((await uploadLogo(c, "zzz", good)).status).toBe(404);
    expect((await logs("service_vendor.logo.set")).length).toBe(0);
  });

  it("업체 둘의 로고는 서로 섞이지 않는다", async () => {
    const c = await adminCookie();
    const a = (await create(c, { category: "PG", name: "A" })).body.vendor.id;
    const b = (await create(c, { category: "PG", name: "B" })).body.vendor.id;
    await uploadLogo(c, a, await png(100, 40));
    const v = (await list(c, "?category=PG")).body.categories[0].vendors;
    expect(v.find((x: { id: string }) => x.id === a).logoUrl).not.toBeNull();
    expect(v.find((x: { id: string }) => x.id === b).logoUrl).toBeNull();
  });
});

describe("권한", () => {
  it("조회는 모든 마스터 역할, 변경은 최고관리자·운영만. CS·조회 전용은 403이고 아무것도 바뀌지 않는다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const v = (await create(su, { category: "PG", name: "A" })).body.vendor.id;
    for (const role of ["CS", "READ_ONLY"] as const) {
      const c = await adminCookie(role);
      expect((await list(c)).status).toBe(200);
      expect((await create(c, { category: "PG", name: "Z" })).status).toBe(403);
      expect((await patch(c, v, { memo: "x" })).status).toBe(403);
      expect((await putCategory(c, "PG", { recommendedVendorId: v })).status).toBe(403);
      expect((await uploadLogo(c, v, await png(100, 40))).status).toBe(403);
      const del = await logoDelete(new Request(`${BASE}/api/admin/service-vendors/${v}/logo`, json(c, "DELETE")), idCtx(v));
      expect(del.status).toBe(403);
      expect((await logoGet(new Request(`${BASE}/api/admin/service-vendors/${v}/logo`, { headers: { ...H, cookie: c } }), idCtx(v))).status).toBe(404);
    }
    expect(await db.serviceVendor.count()).toBe(1);
    expect(await db.serviceVendorSetting.count()).toBe(0);
    expect(await db.serviceVendorLogo.count()).toBe(0);
    const ops = await adminCookie("OPERATIONS");
    expect((await create(ops, { category: "PG", name: "Z" })).status).toBe(201);
  });

  it("로그인하지 않았거나 파트너스(판매자) 세션이면 401이다. Origin이 다르면 변경은 403이다", async () => {
    expect((await list("")).status).toBe(401);
    expect((await create("", { category: "PG", name: "A" })).status).toBe(401);
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    const seller_cookie = `lo_seller=${r.token}`;
    expect((await list(seller_cookie)).status).toBe(401);
    expect((await create(seller_cookie, { category: "PG", name: "A" })).status).toBe(401);
    const c = await adminCookie();
    const cross = await vendorPost(new Request(`${BASE}/api/admin/service-vendors`, { ...json(c, "POST", { category: "PG", name: "A" }), headers: { host: "localhost:3000", origin: "http://evil.example", cookie: c, "content-type": "application/json" } }));
    expect(cross.status).toBe(403);
    expect(await db.serviceVendor.count()).toBe(0);
  });

  it("같은 이름을 동시에 등록해도 하나만 만들어진다", async () => {
    const c = await adminCookie();
    const rs = await Promise.all(Array.from({ length: 6 }, () => create(c, { category: "PG", name: "동시" })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await db.serviceVendor.count()).toBe(1);
  });
});
