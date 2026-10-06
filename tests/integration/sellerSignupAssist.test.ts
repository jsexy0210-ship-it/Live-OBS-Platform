import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminLicenseRoute } from "../../app/api/admin/sellers/[sellerId]/business-license/route";
import { GET as adminListRoute } from "../../app/api/admin/sellers/applications/route";
import { POST as applyRoute } from "../../app/api/seller-signup/apply/route";
import { POST as businessCheckRoute } from "../../app/api/seller-signup/business-check/route";
import { DELETE as licenseDelete, GET as licenseGet, PUT as licensePut } from "../../app/api/seller-signup/business-license/route";
import { GET as slugCheckRoute } from "../../app/api/seller-signup/slug-check/route";
import { GET as statusRoute } from "../../app/api/seller-signup/status/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { applyForSeller, type ApplyInput } from "../../lib/server/sellers/application";
import { BUSINESS_CHECK_LIMIT, SLUG_CHECK_PER_MINUTE, resetSlugCheckLimit, slugCheckAllowed } from "../../lib/server/sellers/signupAssist";
import { detectLicenseType, cleanLicenseName } from "../../lib/server/sellers/businessLicense";
import { FakeBusinessStatusProvider, FakeMailOrderProvider } from "../../lib/server/sellers/businessCheck";
import { SELLER_SIGNUP_CONSENT_VERSIONS, parseSellerSignupConsent } from "../../lib/server/sellers/signupConsent";
import { IDV_INPUT, SELLER_SIGNUP_CONSENT, confirmIdv, createAdmin, db, resetDb, startIdv } from "./helpers";

// 파트너스 가입 신청 화면 서버(PF-007-3~5): 동의 확장 · 쇼핑몰 주소 확인 · 사업자 조회 · 방송 화면만 쓰기 · 사업자등록증 · 신청 상태 · 마스터 열람
beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
  process.env.BUSINESS_STATUS_PROVIDER = "fake";
  process.env.MAIL_ORDER_PROVIDER = "fake";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const identity = new FakeIdentityProvider();
const providers = { business: new FakeBusinessStatusProvider(), mailOrder: new FakeMailOrderProvider() };
const H = { host: "localhost:3000", origin: "http://localhost:3000" };

async function verified(ci: string) {
  const { verification, ownerToken } = await startIdv(identity, { purpose: "SELLER_REPRESENTATIVE", sellerId: null, person: { name: "김대표", phone: "01011112222" } });
  identity.complete(verification.requestId, { ci, name: "김대표", phone: "01011112222", birthDate: new Date("1985-01-01") });
  const r = await confirmIdv(identity, verification, ownerToken);
  if (!r.ok) throw new Error(r.reason);
  return { verificationId: verification.id, ownerToken };
}
function businessNumberOf(seq: number): string {
  const head = String(400000000 + seq).padStart(9, "0");
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const d = Array.from(head, Number);
  const sum = w.reduce((a, wi, i) => a + d[i] * wi, 0) + Math.floor((d[8] * 5) / 10);
  return head + String((10 - (sum % 10)) % 10);
}
let n = 0;
function form(v: { verificationId: string; ownerToken: string }, extra: Partial<ApplyInput> = {}): ApplyInput {
  n++;
  return {
    ...v,
    email: `assist${n}@example.com`,
    password: "seller-pass-1",
    shopName: `카드샵 ${n}`,
    slug: `assist-shop-${n}`,
    businessNumber: businessNumberOf(n),
    companyName: "주식회사 카드",
    openedOn: "2020-01-01",
    mailOrderNumber: "제2024-서울강남-01234호",
    ...extra,
  };
}

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2), Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");

const put = (v: { verificationId: string; ownerToken: string }, body: Buffer, name = "등록증.jpg") =>
  licensePut(new Request(`http://localhost:3000/api/seller-signup/business-license?verificationId=${v.verificationId}`, { method: "PUT", headers: { ...H, cookie: `lo_sidv=${v.ownerToken}`, "x-file-name": encodeURIComponent(name) }, body: new Uint8Array(body) }));
const get = (route: typeof licenseGet, v: { verificationId: string; ownerToken: string }) =>
  route(new Request(`http://localhost:3000/x?verificationId=${v.verificationId}`, { headers: { ...H, cookie: `lo_sidv=${v.ownerToken}` } }));

describe("동의 확장(운영 정책·마케팅)", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  const V = SELLER_SIGNUP_CONSENT_VERSIONS;
  it("운영 정책·마케팅 동의는 문서 버전·시각과 함께 저장되고, 보낸 운영 정책이 false이거나 버전이 다르면 거절한다", () => {
    const ok = parseSellerSignupConsent({ ...SELLER_SIGNUP_CONSENT, agreedPolicy: true, policyVersion: V.policy, agreedMarketing: true, marketingVersion: V.marketing }, now);
    expect(ok).toEqual({ ok: true, consent: expect.objectContaining({ policyVersion: V.policy, marketingVersion: V.marketing, marketingAt: now.toISOString() }) });
    expect(parseSellerSignupConsent({ ...SELLER_SIGNUP_CONSENT, agreedPolicy: false, policyVersion: V.policy }, now)).toEqual({ ok: false, reason: "terms_required" });
    expect(parseSellerSignupConsent({ ...SELLER_SIGNUP_CONSENT, agreedPolicy: true, policyVersion: "old" }, now)).toEqual({ ok: false, reason: "consent_outdated" });
    expect(parseSellerSignupConsent({ ...SELLER_SIGNUP_CONSENT, agreedPolicy: true, policyVersion: V.policy, agreedMarketing: true, marketingVersion: "old" }, now)).toEqual({ ok: false, reason: "consent_outdated" });
    // 운영 정책 동의는 필수다(보내지 않아도 terms_required)
    expect(parseSellerSignupConsent({ ...SELLER_SIGNUP_CONSENT, agreedPolicy: undefined, policyVersion: undefined }, now)).toEqual({ ok: false, reason: "terms_required" });
    // 마케팅을 동의하지 않으면 기록에 남지 않는다
    const none = parseSellerSignupConsent({ ...SELLER_SIGNUP_CONSENT, agreedPolicy: true, policyVersion: V.policy }, now);
    expect(none.ok && none.consent.marketingAt).toBeUndefined();
  });
});

describe("쇼핑몰 주소 확인", () => {
  it("형식·예약어는 invalid, 쓰는 주소는 taken, 나머지는 사용 가능", async () => {
    await db.seller.create({ data: { slug: "taken-shop", shopName: "기존", status: "ACTIVE" } });
    const ask = async (slug: string) => (await slugCheckRoute(new Request(`http://localhost:3000/x?slug=${encodeURIComponent(slug)}`))).json();
    expect(await ask("taken-shop")).toEqual({ available: false, reason: "taken" });
    expect(await ask("Taken-Shop")).toEqual({ available: false, reason: "taken" });
    expect(await ask("admin")).toEqual({ available: false, reason: "invalid" });
    expect(await ask("a")).toEqual({ available: false, reason: "invalid" });
    expect(await ask("free-name")).toEqual({ available: true, reason: null });
  });
});

describe("쇼핑몰 주소 확인 횟수 제한", () => {
  it("같은 IP는 1분에 30번까지, 1분이 지나면 다시 가능하고, IP를 모르면 세지 않는다", () => {
    resetSlugCheckLimit();
    const t = 1_000_000;
    for (let i = 0; i < SLUG_CHECK_PER_MINUTE; i++) expect(slugCheckAllowed("1.2.3.4", t + i)).toBe(true);
    expect(slugCheckAllowed("1.2.3.4", t + 1000)).toBe(false);
    expect(slugCheckAllowed("5.6.7.8", t + 1000)).toBe(true);
    expect(slugCheckAllowed("1.2.3.4", t + 61_000)).toBe(true);
    for (let i = 0; i < 100; i++) expect(slugCheckAllowed(null, t)).toBe(true);
    resetSlugCheckLimit();
  });
});

describe("사업자 조회 버튼", () => {
  const post = (v: { verificationId: string; ownerToken: string } | null, body: Record<string, unknown>) =>
    businessCheckRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, "content-type": "application/json", ...(v ? { cookie: `lo_sidv=${v.ownerToken}` } : {}) }, body: JSON.stringify(body) }));

  it("본인확인한 브라우저만 쓰고, 결과·중복을 돌려주며, 한도(10번)를 넘으면 429", async () => {
    const v = await verified("CI-CHECK");
    const bn = businessNumberOf(900);
    expect((await post(null, { verificationId: v.verificationId, businessNumber: bn, openedOn: "20200101" })).status).toBe(409);
    expect((await post({ ...v, ownerToken: "wrong" }, { verificationId: v.verificationId, businessNumber: bn, openedOn: "20200101" })).status).toBe(409);
    const ok = await post(v, { verificationId: v.verificationId, businessNumber: bn, openedOn: "20200101", mailOrderNumber: "제2024-서울강남-01234호" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ business: { lookup: true, valid: true, status: "ACTIVE" }, duplicate: false, mailOrder: { state: expect.stringMatching(/NORMAL|NOT_REGISTERED/) } });
    expect((await post(v, { verificationId: v.verificationId, businessNumber: "123", openedOn: "20200101" })).status).toBe(400);
    expect((await post(v, { verificationId: v.verificationId, businessNumber: bn, openedOn: "nope" })).status).toBe(400);
    // 위 400 두 번은 횟수에 세지 않는다(조회하지 않음). 지금까지 1번 → 9번 더 되고 그 뒤는 429
    for (let i = 1; i < BUSINESS_CHECK_LIMIT; i++) expect((await post(v, { verificationId: v.verificationId, businessNumber: bn, openedOn: "20200101" })).status).toBe(200);
    expect((await post(v, { verificationId: v.verificationId, businessNumber: bn, openedOn: "20200101" })).status).toBe(429);
  });

  it("같은 사업자번호로 운영·신청 중인 쇼핑몰이 있으면 duplicate", async () => {
    const first = await verified("CI-DUP-1");
    const f = form(first);
    expect((await applyForSeller(db, providers, f)).ok).toBe(true);
    const second = await verified("CI-DUP-2");
    const r = await post(second, { verificationId: second.verificationId, businessNumber: f.businessNumber, openedOn: "20200101" });
    expect((await r.json()).duplicate).toBe(true);
  });
});

describe("방송 화면만 쓰기·연락처·주소·채널", () => {
  it("OVERLAY_ONLY는 사업자 정보 없이 신청해 바로 승인된다(사업자번호 없음). 연락처·주소·채널·주로 파는 것은 심사 참고로 담긴다", async () => {
    const v = await verified("CI-OVERLAY");
    const r = await applyForSeller(db, providers, {
      ...form(v, { planCode: "OVERLAY_ONLY", industry: "트레이딩카드", channelUrl: "https://youtube.com/@byulbit", contactPhone: "010-1234-5678", businessAddress: "서울 강남구 테헤란로 1" }),
      businessNumber: "",
      companyName: "",
      openedOn: "",
      mailOrderNumber: null,
    });
    expect(r).toMatchObject({ ok: true, approved: true, reviewReasons: [], license: null });
    if (!r.ok) return;
    const s = await db.seller.findUniqueOrThrow({ where: { id: r.sellerId }, include: { plan: true } });
    expect(s.plan?.code).toBe("OVERLAY_ONLY");
    expect(s.businessInfo).toMatchObject({ industry: "트레이딩카드", channelUrl: "https://youtube.com/@byulbit", contactPhone: "01012345678", businessAddress: "서울 강남구 테헤란로 1" });
    expect(s.businessInfo).not.toHaveProperty("businessNumber");
  });

  it("쇼핑몰 통합은 사업자 정보를 그대로 요구하고, 형식이 틀린 연락처·채널 주소는 invalid_input", async () => {
    const v = await verified("CI-EXTRA");
    expect(await applyForSeller(db, providers, form(v, { contactPhone: "12" }))).toEqual({ ok: false, reason: "invalid_input" });
    expect(await applyForSeller(db, providers, form(v, { channelUrl: "javascript:alert(1)" }))).toEqual({ ok: false, reason: "invalid_input" });
    expect(await applyForSeller(db, providers, { ...form(v), businessNumber: "" })).toEqual({ ok: false, reason: "invalid_business_number" });
    const ok = await applyForSeller(db, providers, form(v, { contactPhone: "02-123-4567", businessAddress: "부산 해운대구 1" }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((await db.seller.findUniqueOrThrow({ where: { id: ok.sellerId } })).businessInfo).toMatchObject({ contactPhone: "021234567", businessAddress: "부산 해운대구 1" });
  });
});

describe("사업자등록증", () => {
  it("형식은 파일 앞뒤 바이트로 판단하고(JPG·PNG·PDF), 이름은 경로·위험 문자를 지우고 확장자를 맞춘다", () => {
    expect(detectLicenseType(JPG)).toBe("image/jpeg");
    expect(detectLicenseType(PNG)).toBe("image/png");
    expect(detectLicenseType(PDF)).toBe("application/pdf");
    expect(detectLicenseType(JPG.subarray(0, 20))).toBeNull(); // 끝 표시가 없는 잘린 파일
    expect(detectLicenseType(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(cleanLicenseName("..\\C:/x/사업자<등록증>.exe", "image/png")).toBe("사업자등록증.png");
    expect(cleanLicenseName("", "application/pdf")).toBe("사업자등록증.pdf");
  });

  it("올리기: 본인확인한 브라우저만, 형식·크기를 서버가 확인하고 다시 올리면 바뀌며 지울 수 있다", async () => {
    const v = await verified("CI-LIC");
    expect((await put({ ...v, ownerToken: "wrong" }, JPG)).status).toBe(409);
    const bad = await put(v, Buffer.from("hello"), "a.jpg");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("file_type_invalid");
    expect((await (await put(v, Buffer.alloc(0))).json()).error).toBe("file_empty");
    const big = Buffer.concat([JPG.subarray(0, 4), Buffer.alloc(10 * 1024 * 1024), Buffer.from([0xff, 0xd9])]);
    const tooBig = await put(v, big);
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toBe("file_too_large");

    const up = await put(v, JPG, "내 사업자등록증.png");
    expect(up.status).toBe(200);
    expect((await up.json()).license).toMatchObject({ fileName: "내 사업자등록증.jpg", mimeType: "image/jpeg", byteSize: JPG.length });
    await put(v, PDF, "scan.pdf");
    expect((await (await get(licenseGet, v)).json()).license).toMatchObject({ fileName: "scan.pdf", mimeType: "application/pdf" });
    expect(await db.sellerBusinessLicense.count()).toBe(1);
    expect((await get(licenseDelete as never, v)).status).toBe(200);
    expect((await (await get(licenseGet, v)).json()).license).toBeNull();
  });

  it("신청하면 쇼핑몰로 옮겨지고 응답·신청 상태·마스터 목록에 파일 정보가 보인다. 마스터 열람은 최고관리자·운영만이고 로그 추적에 남는다", async () => {
    const v = await verified("CI-LIC-2");
    await put(v, PNG, "등록증.png");
    const f = form(v);
    const res = await applyRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, "content-type": "application/json", cookie: `lo_sidv=${v.ownerToken}` }, body: JSON.stringify({ ...f, ownerToken: undefined, mailOrderNumber: f.mailOrderNumber }) }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.license).toMatchObject({ fileName: "등록증.png", mimeType: "image/png" });
    const seller = await db.seller.findFirstOrThrow({ where: { slug: f.slug } });
    const row = await db.sellerBusinessLicense.findUniqueOrThrow({ where: { sellerId: seller.id } });
    expect(row.verificationId).toBeNull();
    // 신청한 뒤에는 임시 파일로 다시 올릴 수 없다(본인확인을 이미 씀)
    expect((await put(v, JPG)).status).toBe(409);

    const st = await statusRoute(new Request(`http://localhost:3000/x?verificationId=${v.verificationId}`, { headers: { cookie: `lo_sidv=${v.ownerToken}` } }));
    expect(await st.json()).toMatchObject({ state: expect.stringMatching(/APPROVED|PENDING/), license: { fileName: "등록증.png" } });
    expect((await statusRoute(new Request(`http://localhost:3000/x?verificationId=${v.verificationId}`, { headers: { cookie: "lo_sidv=other" } }))).status).toBe(404);

    const cookieOf = async (role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") => `lo_admin=${(await createAdminSession(db, (await createAdmin(role)).id, {})).token}`;
    const view = (cookie: string, qs = "") => adminLicenseRoute(new Request(`http://localhost:3000/x${qs}`, { headers: { ...H, cookie } }), { params: Promise.resolve({ sellerId: seller.id }) });
    for (const role of ["CS", "READ_ONLY"] as const) expect((await view(await cookieOf(role))).status).toBe(403);
    const ok = await view(await cookieOf("OPERATIONS"), "?download=1");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("content-disposition")).toContain("attachment");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);
    const log = await db.auditLog.findMany({ where: { action: "seller.business_license.view" } });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actorType: "PLATFORM_ADMIN", sellerId: seller.id });
  });

  it("마스터 신청 목록: 승인 대기 건에 연락처·주소와 등록증 정보가 보이고, viewUrl은 최고관리자·운영에게만 준다", async () => {
    const v = await verified("CI-LIC-3");
    await put(v, JPG);
    // 통신판매업 신고번호가 없으면 확인 필요로 승인 대기가 된다
    const r = await applyForSeller(db, providers, form(v, { mailOrderNumber: null, contactPhone: "01099998888", businessAddress: "서울 중구 1" }));
    expect(r.ok && r.approved).toBe(false);
    if (!r.ok) return;
    const list = async (role: "OPERATIONS" | "CS") => {
      const cookie = `lo_admin=${(await createAdminSession(db, (await createAdmin(role)).id, {})).token}`;
      const res = await adminListRoute(new Request("http://localhost:3000/x", { headers: { ...H, cookie } }));
      return (await res.json()).applications[0];
    };
    expect(await list("OPERATIONS")).toMatchObject({ contactPhone: "01099998888", businessAddress: "서울 중구 1", license: { fileName: "등록증.jpg", viewUrl: `/api/admin/sellers/${r.sellerId}/business-license` } });
    expect((await list("CS")).license).toMatchObject({ fileName: "등록증.jpg", viewUrl: null });
  });
});
