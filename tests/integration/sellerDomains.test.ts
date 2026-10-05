import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as verifyPost } from "../../app/api/seller/domains/[id]/verify/route";
import { DELETE as domainDelete } from "../../app/api/seller/domains/[id]/route";
import { GET as domainsGet, POST as domainsPost } from "../../app/api/seller/domains/route";
import { loginSeller } from "../../lib/server/auth/login";
import { PENDING_EXPIRE_MS, VERIFY_COOLDOWN_MS, normalizeHostname, setTxtResolverForTest, verifyDomain } from "../../lib/server/seller-settings/domains";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쇼핑몰 도메인 연결(/api/seller/domains, SA-060): 등록·DNS 안내·소유 확인(DNS 조회는 시험에서 바꿔 끼움)·해제, 이름 검사, 선점 방지, 한도, 권한, 격리, 로그.
beforeEach(resetDb);
afterEach(() => setTxtResolverForTest(null));
afterAll(() => db.$disconnect());

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, cookie: await cookieOf(owner.email) };
}
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, any> });
const list = (cookie: string) => domainsGet(new Request(`${BASE}/api/seller/domains`, { headers: { ...H, cookie } })).then(j);
const add = (cookie: string, body: unknown) => domainsPost(new Request(`${BASE}/api/seller/domains`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) })).then(j);
const verify = (cookie: string, id: string) => verifyPost(new Request(`${BASE}/api/seller/domains/${id}/verify`, { method: "POST", headers: { ...H, cookie } }), idCtx(id)).then(j);
const remove = (cookie: string, id: string) => domainDelete(new Request(`${BASE}/api/seller/domains/${id}`, { method: "DELETE", headers: { ...H, cookie } }), idCtx(id)).then(j);
const logs = (sellerId: string) => db.auditLog.findMany({ where: { sellerId, action: { startsWith: "shop.domain." } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("도메인 이름 검사", () => {
  it("소문자 호스트 이름만 받는다(앞뒤 공백·끝 점은 정리)", () => {
    for (const ok of ["shop.example.com", " shop.example.com ", "shop.example.com.", "a-b.co.kr", "xn--hq1bm8jm9l.com", "a.io"]) expect(normalizeHostname(ok), ok).not.toBeNull();
    expect(normalizeHostname(" Shop.Example.com")).toBeNull(); // 대문자
    const bad: unknown[] = ["", "example", "localhost", "127.0.0.1", "::1", "https://shop.example.com", "shop.example.com/path", "shop.example.com:8080", "*.example.com", "-a.example.com", "a-.example.com", "a..example.com", "a b.example.com", "exa_mple.com", "a.c", "a.123", `${"a".repeat(64)}.com`, `${"a.".repeat(130)}com`, null, 5, {}, ["a.com"], "상점.한국"];
    for (const v of bad) expect(normalizeHostname(v), String(v)).toBeNull();
  });
});

describe("등록·안내·확인·해제", () => {
  it("등록하면 소유 확인 안내(TXT)와 연결 안내(CNAME)가 나오고 목록에 보인다. 로그가 남는다", async () => {
    const s = await shop();
    const r = await add(s.cookie, { hostname: "Shop.Example.com".toLowerCase() });
    expect(r.status).toBe(201);
    const d = r.body.domain;
    expect(d).toMatchObject({ hostname: "shop.example.com", status: "PENDING_VERIFICATION", verifiedAt: null, certStatus: null });
    expect(d.dns.verify).toMatchObject({ type: "TXT", name: "_onq-verify.shop.example.com" });
    expect(d.dns.verify.value).toMatch(/^onq-verify=[0-9a-f]{32}$/);
    expect(d.dns.connect).toMatchObject({ type: "CNAME", name: "shop.example.com", value: "shops.on-aircue.com" });
    expect(new Date(d.expiresAt).getTime() - new Date(d.createdAt).getTime()).toBe(PENDING_EXPIRE_MS);
    const l = await list(s.cookie);
    expect(l.body.domains).toHaveLength(1);
    expect(l.body.limit).toBe(3);
    expect(l.body.targets).toEqual({ cname: "shops.on-aircue.com", a: null });
    expect((await logs(s.seller.id)).map((x) => [x.action, x.after])).toEqual([["shop.domain.create", { hostname: "shop.example.com" }]]);
  });

  it("DNS에 TXT가 있으면 확인되고, 없으면 verified:false로 바뀌는 것 없이 끝난다. 확인 뒤에는 다시 확인할 수 없다", async () => {
    const s = await shop();
    const d = (await add(s.cookie, { hostname: "shop.example.com" })).body.domain;
    const asked: string[] = [];
    setTxtResolverForTest(async (name) => {
      asked.push(name);
      return ["v=spf1 -all"];
    });
    const no = await verify(s.cookie, d.id);
    expect(no).toMatchObject({ status: 200, body: { verified: false, domain: { status: "PENDING_VERIFICATION" } } });
    expect(asked).toEqual(["_onq-verify.shop.example.com"]);
    expect((await logs(s.seller.id)).length).toBe(1);
    // 15초 안에 다시 누르면 DNS를 다시 묻지 않고 429
    const soon = await verify(s.cookie, d.id);
    expect([soon.status, soon.body.error]).toEqual([429, "verify_too_soon"]);
    expect(asked).toHaveLength(1);
    // 시각을 되돌려 제한을 풀고, 틀린 값·남의 값은 확인되지 않는다
    await db.sellerDomain.update({ where: { id: d.id }, data: { lastCheckedAt: new Date(Date.now() - VERIFY_COOLDOWN_MS - 1000) } });
    setTxtResolverForTest(async () => ["onq-verify=" + "0".repeat(32), `x onq-verify=${d.dns.verify.value.slice(11)}`]);
    expect((await verify(s.cookie, d.id)).body.verified).toBe(false);
    await db.sellerDomain.update({ where: { id: d.id }, data: { lastCheckedAt: new Date(Date.now() - VERIFY_COOLDOWN_MS - 1000) } });
    setTxtResolverForTest(async () => ["other", d.dns.verify.value]);
    const yes = await verify(s.cookie, d.id);
    expect(yes).toMatchObject({ status: 200, body: { verified: true, domain: { status: "VERIFIED", certStatus: "PENDING", expiresAt: null } } });
    expect((await logs(s.seller.id)).map((x) => x.action)).toEqual(["shop.domain.create", "shop.domain.verify"]);
    const again = await verify(s.cookie, d.id);
    expect([again.status, again.body.error]).toEqual([409, "already_verified"]);
  });

  it("DNS 조회가 실패(오류·시간 초과)해도 서버 오류가 아니라 확인 실패로 끝난다", async () => {
    const s = await shop();
    const d = (await add(s.cookie, { hostname: "shop.example.com" })).body.domain;
    setTxtResolverForTest(async () => []);
    expect((await verify(s.cookie, d.id)).body.verified).toBe(false);
    expect((await db.sellerDomain.findUniqueOrThrow({ where: { id: d.id } })).verifiedAt).toBeNull();
  });

  it("동시에 확인해도 DNS 조회는 한 번만 일어난다", async () => {
    const s = await shop();
    const d = (await add(s.cookie, { hostname: "shop.example.com" })).body.domain;
    let calls = 0;
    setTxtResolverForTest(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return [d.dns.verify.value];
    });
    const rs = await Promise.all(Array.from({ length: 6 }, () => verify(s.cookie, d.id)));
    expect(calls).toBe(1);
    expect(rs.filter((r) => r.body.verified === true)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(5);
    expect((await logs(s.seller.id)).filter((x) => x.action === "shop.domain.verify")).toHaveLength(1);
  });

  it("해제하면 지워지고 로그가 남는다. 없는 도메인은 404", async () => {
    const s = await shop();
    const d = (await add(s.cookie, { hostname: "shop.example.com" })).body.domain;
    expect((await remove(s.cookie, d.id)).status).toBe(200);
    expect((await list(s.cookie)).body.domains).toEqual([]);
    expect((await remove(s.cookie, d.id)).status).toBe(404);
    expect((await remove(s.cookie, "not-a-uuid")).status).toBe(404);
    expect((await verify(s.cookie, d.id)).status).toBe(404);
    const l = await logs(s.seller.id);
    expect(l[1]).toMatchObject({ action: "shop.domain.delete", before: { hostname: "shop.example.com", verified: false } });
    expect((await add(s.cookie, { hostname: "shop.example.com" })).status).toBe(201); // 해제하면 다시 등록 가능
  });
});

describe("검사·선점 방지·한도", () => {
  it("잘못된 이름·플랫폼 도메인·모르는 키는 거부하고 저장하지 않는다", async () => {
    const s = await shop();
    for (const body of [{}, [], null, { hostname: "" }, { hostname: "example" }, { hostname: "http://a.com" }, { hostname: "A.com" }, { hostname: "a.com", extra: 1 }, { host: "a.com" }]) {
      const r = await add(s.cookie, body);
      expect([JSON.stringify(body), r.status, r.body.error]).toEqual([JSON.stringify(body), 400, "invalid_domain"]);
    }
    for (const hostname of ["on-aircue.com", "shop.on-aircue.com", "a.b.on-aircue.com"]) {
      const r = await add(s.cookie, { hostname });
      expect([hostname, r.status, r.body.error]).toEqual([hostname, 400, "reserved_domain"]);
    }
    expect((await add(s.cookie, { hostname: "xon-aircue.com" })).status).toBe(201); // 접미사만 닮은 다른 도메인은 허용
    expect(await db.sellerDomain.count()).toBe(1);
  });

  it("다른 쇼핑몰이 쓰는 이름은 409(누구 것인지 알려 주지 않음). 같은 이름을 동시에 등록해도 하나만", async () => {
    const a = await shop();
    const b = await shop();
    expect((await add(a.cookie, { hostname: "shop.example.com" })).status).toBe(201);
    const r = await add(b.cookie, { hostname: "shop.example.com" });
    expect([r.status, r.body.error]).toEqual([409, "domain_taken"]);
    expect(JSON.stringify(r.body)).not.toContain(a.seller.id);
    const rs = await Promise.all(Array.from({ length: 5 }, () => add(b.cookie, { hostname: "race.example.com" })));
    expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
    expect(rs.filter((x) => x.status === 409)).toHaveLength(4);
  });

  it("소유 확인 못 한 등록은 7일 뒤 만료되어 같은 이름을 다른 쇼핑몰이 등록할 수 있고, 확인된 등록은 만료되지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const stale = (await add(a.cookie, { hostname: "old.example.com" })).body.domain;
    const kept = (await add(a.cookie, { hostname: "kept.example.com" })).body.domain;
    await db.sellerDomain.update({ where: { id: kept.id }, data: { verifiedAt: new Date() } });
    const past = new Date(Date.now() - PENDING_EXPIRE_MS - 60_000);
    await db.sellerDomain.updateMany({ where: { id: { in: [stale.id, kept.id] } }, data: { createdAt: past } });
    expect((await list(a.cookie)).body.domains.map((d: { hostname: string }) => d.hostname)).toEqual(["kept.example.com"]);
    expect((await add(b.cookie, { hostname: "old.example.com" })).status).toBe(201);
    expect((await add(b.cookie, { hostname: "kept.example.com" })).status).toBe(409);
    expect(await db.sellerDomain.count({ where: { sellerId: a.seller.id } })).toBe(1);
  });

  it("쇼핑몰마다 3개까지(만료된 미확인은 세지 않음)", async () => {
    const s = await shop();
    for (const h of ["a.example.com", "b.example.com", "c.example.com"]) expect((await add(s.cookie, { hostname: h })).status).toBe(201);
    const r = await add(s.cookie, { hostname: "d.example.com" });
    expect([r.status, r.body.error]).toEqual([409, "too_many_domains"]);
    await db.sellerDomain.updateMany({ where: { hostname: "a.example.com" }, data: { createdAt: new Date(Date.now() - PENDING_EXPIRE_MS - 1000) } });
    expect((await add(s.cookie, { hostname: "d.example.com" })).status).toBe(201);
  });

  it("한도 직전에 동시에 등록해도 한도를 넘지 않는다", async () => {
    const s = await shop();
    await add(s.cookie, { hostname: "a.example.com" });
    await add(s.cookie, { hostname: "b.example.com" });
    const rs = await Promise.all(["e", "f", "g", "h"].map((x) => add(s.cookie, { hostname: `${x}.example.com` })));
    expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
    expect(rs.filter((x) => x.body.error === "too_many_domains")).toHaveLength(3);
    expect(await db.sellerDomain.count({ where: { sellerId: s.seller.id } })).toBe(3);
  });
});

describe("권한·격리", () => {
  it("쇼핑몰 설정 권한이 없는 직원은 403, 비로그인은 401, 다른 쇼핑몰 도메인은 보이지도 바꿀 수도 없다", async () => {
    const a = await shop();
    const b = await shop();
    const d = (await add(a.cookie, { hostname: "shop.example.com" })).body.domain;
    const bro = await cookieOf((await createSellerUser(a.seller.id, "BROADCASTER")).email);
    for (const r of [await list(bro), await add(bro, { hostname: "x.example.com" }), await verify(bro, d.id), await remove(bro, d.id)]) expect(r.status).toBe(403);
    expect((await list("")).status).toBe(401);
    expect((await add("", { hostname: "x.example.com" })).status).toBe(401);
    expect((await list(b.cookie)).body.domains).toEqual([]);
    expect((await verify(b.cookie, d.id)).status).toBe(404);
    expect((await remove(b.cookie, d.id)).status).toBe(404);
    expect(await db.sellerDomain.count()).toBe(1);
    const staff = await cookieOf((await createSellerUser(a.seller.id, { permissions: ["SHOP_SETTINGS"] })).email);
    expect((await add(staff, { hostname: "staff.example.com" })).status).toBe(201);
  });

  it("해지로 풀린(비활성) 도메인은 SUSPENDED로 보이고 확인할 수 없다", async () => {
    const s = await shop();
    const d = (await add(s.cookie, { hostname: "shop.example.com" })).body.domain;
    await db.sellerDomain.update({ where: { id: d.id }, data: { suspendedAt: new Date() } });
    expect((await list(s.cookie)).body.domains[0].status).toBe("SUSPENDED");
    setTxtResolverForTest(async () => [d.dns.verify.value]);
    expect((await verify(s.cookie, d.id)).status).toBe(404);
    expect((await db.sellerDomain.findUniqueOrThrow({ where: { id: d.id } })).verifiedAt).toBeNull();
  });

  it("verifyDomain 함수도 소유 확인 값이 다른 쇼핑몰 값과 섞이지 않는다(확인 값은 도메인마다 다르다)", async () => {
    const s = await shop();
    const a = (await add(s.cookie, { hostname: "a.example.com" })).body.domain;
    const b = (await add(s.cookie, { hostname: "b.example.com" })).body.domain;
    expect(a.dns.verify.value).not.toBe(b.dns.verify.value);
    setTxtResolverForTest(async () => [a.dns.verify.value]);
    const ctx = { sellerId: s.seller.id, actorType: "SELLER_USER", actorId: "x", isOwner: true, permissions: [], readOnly: false } as const;
    const r = await verifyDomain(db, ctx as never, b.id);
    expect(r).toMatchObject({ ok: true, verified: false });
  });
});
