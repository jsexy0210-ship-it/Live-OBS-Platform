import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginRoute } from "../../app/api/seller/auth/login/route";
import { GET as viewRoute } from "../../app/api/seller/pending-application/route";
import { PUT as licenseRoute } from "../../app/api/seller/pending-application/license/route";
import { requestSupplement } from "../../lib/server/sellers/applications";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { PENDING_ACCESS_COOKIE, issuePendingToken } from "../../lib/server/sellers/pendingAccess";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// AU-005 후속: 승인 대기·반려 대표자의 로그인 시도 → 15분 신청 확인 쿠키 → 상태 보기·사업자등록증 다시 올리기
beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2), Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);

async function pendingOwner(status: "PENDING" | "REJECTED" = "PENDING") {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { status, rejectedReason: status === "REJECTED" ? "통신판매업 신고번호를 확인할 수 없습니다" : null, trialEndsAt: null } });
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, owner };
}
const login = (email: string, password = PASSWORD) =>
  loginRoute(new Request("http://localhost:3000/x", { method: "POST", headers: H, body: JSON.stringify({ email, password }) }));
const cookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith(`${PENDING_ACCESS_COOKIE}=`));
const asCookie = (setCookie: string) => setCookie.split(";")[0];
const view = (cookie?: string) => viewRoute(new Request("http://localhost:3000/x", { headers: cookie ? { cookie } : {} }));
const upload = (cookie: string | undefined, body: Buffer, name = "등록증.png") =>
  licenseRoute(new Request("http://localhost:3000/x", { method: "PUT", headers: { host: H.host, origin: H.origin, ...(cookie ? { cookie } : {}), "x-file-name": encodeURIComponent(name) }, body: new Uint8Array(body) }));

describe("신청 확인 쿠키", () => {
  it("승인 대기·반려 대표자는 로그인은 막히고 15분 쿠키를 받는다. 비밀번호가 틀리거나 승인된 계정·직원은 받지 못한다", async () => {
    const p = await pendingOwner();
    const res = await login(p.owner.email);
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toBe("seller_pending");
    const set = cookieOf(res)!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Path=/api/seller/pending-application");
    expect(set).toMatch(/Expires=/);

    expect(cookieOf(await login(p.owner.email, "wrong-password"))).toBeUndefined();
    const rej = await pendingOwner("REJECTED");
    const rr = await login(rej.owner.email);
    expect(await rr.json()).toMatchObject({ error: "seller_closed", application: "rejected" });
    expect(cookieOf(rr)).toBeDefined();
    // 승인된 계정은 로그인되므로 쿠키가 없다
    const { seller } = await createSeller();
    const ok = await createSellerUser(seller.id, "OWNER");
    expect(cookieOf(await login(ok.email))).toBeUndefined();
  });
});

describe("신청 상태 보기", () => {
  it("쿠키가 있어야 보이고(404), 승인 대기·보완 요청·반려 상태와 지연을 준다. 비밀번호가 바뀌면 쿠키가 무효가 된다", async () => {
    const p = await pendingOwner();
    expect((await view()).status).toBe(404);
    expect((await view("lo_spend=garbage")).status).toBe(404);
    const cookie = asCookie(cookieOf(await login(p.owner.email))!);
    expect(await (await view(cookie)).json()).toMatchObject({ state: "PENDING", delayed: false, supplement: null, rejectedReason: null, license: null });

    // 접수한 지 3일이 지나면 심사 지연
    await db.seller.update({ where: { id: p.seller.id }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
    expect((await (await view(cookie)).json()).delayed).toBe(true);

    // 보완 요청
    const admin = await createAdmin("OPERATIONS");
    const ctx = (await resolveAdminSession(db, (await createAdminSession(db, admin.id, {})).token))!;
    expect((await requestSupplement(db, ctx, p.seller.id, "글자가 흐려서 확인이 어렵습니다")).ok).toBe(true);
    const sup = await (await view(cookie)).json();
    expect(sup).toMatchObject({ state: "SUPPLEMENT", delayed: false, supplement: { reason: "글자가 흐려서 확인이 어렵습니다", daysLeft: 7 } });

    // 비밀번호가 바뀌면(자격 버전) 쿠키는 쓸 수 없다
    await db.sellerUser.update({ where: { id: p.owner.id }, data: { credentialVersion: { increment: 1 } } });
    expect((await view(cookie)).status).toBe(404);

    const rej = await pendingOwner("REJECTED");
    const rc = asCookie(cookieOf(await login(rej.owner.email))!);
    expect(await (await view(rc)).json()).toMatchObject({ state: "REJECTED", rejectedReason: "통신판매업 신고번호를 확인할 수 없습니다" });
  });

  it("만료된 쿠키·다른 사람 값은 쓸 수 없다", async () => {
    const p = await pendingOwner();
    const past = issuePendingToken({ userId: p.owner.id, credentialVersion: 0, application: "pending" }, new Date(Date.now() - 20 * 60_000));
    expect((await view(`${PENDING_ACCESS_COOKIE}=${past.token}`)).status).toBe(404);
    const good = issuePendingToken({ userId: p.owner.id, credentialVersion: 0, application: "pending" });
    const forged = good.token.replace(p.owner.id, (await pendingOwner()).owner.id);
    expect((await view(`${PENDING_ACCESS_COOKIE}=${forged}`)).status).toBe(404);
  });
});

describe("보완 재제출", () => {
  it("사업자등록증을 다시 올리면 바뀌고 열려 있던 보완 요청이 닫히며 로그 추적에 남는다. 형식 오류·반려 신청은 거부", async () => {
    const p = await pendingOwner();
    const cookie = asCookie(cookieOf(await login(p.owner.email))!);
    const admin = await createAdmin("OPERATIONS");
    const ctx = (await resolveAdminSession(db, (await createAdminSession(db, admin.id, {})).token))!;
    await requestSupplement(db, ctx, p.seller.id, "사진이 흐립니다");

    expect((await upload(undefined, PNG)).status).toBe(404);
    const bad = await upload(cookie, Buffer.from("hello"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "file_type_invalid", message: "JPG · PNG · PDF 파일만 올릴 수 있습니다" });
    expect((await upload(cookie, Buffer.alloc(0))).status).toBe(400);

    const ok = await upload(cookie, PNG, "새 등록증.png");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ license: { fileName: "새 등록증.png", mimeType: "image/png" }, supplementClosed: true });
    expect((await db.sellerBusinessLicense.findUniqueOrThrow({ where: { sellerId: p.seller.id } })).fileName).toBe("새 등록증.png");
    expect(await (await view(cookie)).json()).toMatchObject({ state: "PENDING", supplement: null, license: { fileName: "새 등록증.png" } });
    expect(await db.auditLog.count({ where: { action: "seller.signup.license_resubmitted", sellerId: p.seller.id } })).toBe(1);
    // 다시 올리면 파일은 1개로 바뀐다
    await upload(cookie, PNG, "또 바꿈.png");
    expect(await db.sellerBusinessLicense.count({ where: { sellerId: p.seller.id } })).toBe(1);

    const rej = await pendingOwner("REJECTED");
    const rc = asCookie(cookieOf(await login(rej.owner.email))!);
    expect((await upload(rc, PNG)).status).toBe(409);
  });
});
