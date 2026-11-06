import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createRoute } from "../../app/api/admin/sellers/direct-create/route";
import { POST as reissueRoute } from "../../app/api/admin/sellers/[sellerId]/invite/route";
import { PATCH as trialRoute } from "../../app/api/admin/sellers/[sellerId]/trial/route";
import { POST as acceptRoute } from "../../app/api/seller/invite/accept/route";
import { getAdminSeller } from "../../lib/server/admin/sellers";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { requireSeller } from "../../lib/server/authz/guards";
import { prisma } from "../../lib/server/db";
import { chargeMessageBalance } from "../../lib/server/messaging/charge";
import { updateLivePayout } from "../../lib/server/seller-settings/rewardLivePayout";
import { inviteLink, INVITE_TTL_MS } from "../../lib/server/sellers/directCreate";
import { isIdentityPending } from "../../lib/server/sellers/identityGate";
import { createStaff } from "../../lib/server/sellers/staff";
import { createAdmin, db, resetDb } from "./helpers";

// 파트너스 직접 추가(최고관리자 전용): 생성·초대 링크·비밀번호 정하기·재발급·체험 종료일, 본인확인 대기 제한, 비밀값이 DB·로그·응답에 평문으로 남지 않는지.
beforeEach(resetDb);
afterEach(() => {
  delete process.env.OBS_SITE_ADDRESS;
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE, "content-type": "application/json" };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  const s = await createAdminSession(db, a.id, {});
  return { id: a.id, cookie: `lo_admin=${s.token}`, ctx: (await resolveAdminSession(db, s.token))! };
}
const sid = (sellerId: string) => ({ params: Promise.resolve({ sellerId }) });
const post = (path: string, cookie: string | null, body: unknown, method = "POST") =>
  new Request(BASE + path, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const input = (over: Record<string, unknown> = {}) => ({ shopName: "별빛 카드숍", slug: "starlight", ownerName: "홍길동", ownerEmail: "Owner@Example.com", reason: "첫 파트너스 직접 추가", ...over });
async function create(cookie: string, over: Record<string, unknown> = {}) {
  const res = await createRoute(post("/api/admin/sellers/direct-create", cookie, input(over)));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const tokenOf = (inviteBody: { path: string }) => inviteBody.path.split("#")[1];
const accept = async (token: string, newPassword: string) => {
  const res = await acceptRoute(post("/api/seller/invite/accept", null, { token, newPassword }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const login = (password: string) => loginSeller(db, { email: "owner@example.com", password, shopSlug: "starlight" }, {});

describe("직접 추가", () => {
  it("최고관리자만: 쇼핑몰은 바로 운영 중·본인확인 대기, 체험 종료 기본 7일, 초대 링크는 응답에서만 보이고 DB·로그에는 평문이 없다", async () => {
    await db.subscriptionPlan.upsert({ where: { code: "INTEGRATED" }, create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 }, update: {} });
    const su = await admin("SUPER_ADMIN");
    const r = await create(su.cookie);
    expect(r.status).toBe(201);
    const token = tokenOf(r.body.invite);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(r.body.invite.path).toBe(`/seller/invite#${token}`); // 토큰은 # 조각: 서버 로그·Referer에 남지 않는다
    const seller = await db.seller.findUniqueOrThrow({ where: { id: r.body.sellerId } });
    expect(seller).toMatchObject({ slug: "starlight", status: "ACTIVE", directCreatedByAdminId: su.id, representativeVerifiedAt: null, representativeCiHash: null });
    const days = (seller.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7.001);
    expect(await isIdentityPending(db, seller.id)).toBe(true);
    // 초대: 해시만 저장, 72시간
    const inv = await db.sellerInvite.findFirstOrThrow({ where: { sellerId: seller.id } });
    expect(inv.tokenHash).not.toContain(token);
    expect(inv.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inv.expiresAt.getTime() - inv.createdAt.getTime()).toBeLessThanOrEqual(INVITE_TTL_MS + 1000);
    // 평문 비밀값은 DB 어디에도 없다: 초대 토큰·이메일 외 로그
    const dump = JSON.stringify([await db.auditLog.findMany(), await db.sellerInvite.findMany(), await db.sellerUser.findMany()]);
    expect(dump).not.toContain(token);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "admin.seller.direct_create" } });
    expect(JSON.stringify(audit)).not.toContain("owner@example.com");
    expect(audit.after).toMatchObject({ slug: "starlight", identityPending: true, trialCustom: false, reason: "첫 파트너스 직접 추가" });
    // 초대를 받기 전에는 아무 비밀번호로도 로그인할 수 없다
    expect((await login("anything-12345")).ok).toBe(false);
    // 마스터 상세에 표시
    const detail = await getAdminSeller(db, su.ctx, seller.id);
    expect(detail).toMatchObject({ directCreated: true, identityPending: true });
  });

  it("최고관리자 외 역할은 403, 로그인 없음은 401, 입력 검사(주소·예약어·중복·사유·과거 체험일)", async () => {
    await db.subscriptionPlan.upsert({ where: { code: "INTEGRATED" }, create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 }, update: {} });
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) expect((await create((await admin(role)).cookie)).status).toBe(403);
    expect((await createRoute(post("/api/admin/sellers/direct-create", null, input()))).status).toBe(401);
    expect(await db.seller.count()).toBe(0);
    const su = await admin("SUPER_ADMIN");
    const code = async (over: Record<string, unknown>) => (await create(su.cookie, over)).body.error ?? "ok";
    expect(await code({ slug: "Bad Slug" })).toBe("invalid_slug");
    expect(await code({ slug: "admin" })).toBe("invalid_slug");
    expect(await code({ reason: "" })).toBe("invalid_reason");
    expect(await code({ ownerEmail: "not-an-email" })).toBe("invalid_input");
    expect(await code({ shopName: "" })).toBe("invalid_input");
    expect(await code({ trialEndsAt: "2020-01-01T00:00:00Z" })).toBe("invalid_trial");
    expect(await code({ trialEndsAt: "garbage" })).toBe("invalid_trial");
    expect(await code({ planCode: "NOPE" })).toBe("invalid_input");
    expect(await db.seller.count()).toBe(0);
    expect(await code({})).toBe("ok");
    expect((await create(su.cookie)).status).toBe(409); // 같은 주소
    // 체험 종료일은 상한 없이 지정할 수 있고, 지정했다는 사실이 로그에 남는다
    const far = await create(su.cookie, { slug: "farshop", ownerEmail: "far@example.com", trialEndsAt: "2100-01-01T00:00:00Z" });
    expect(far.status).toBe(201);
    const logged = await db.auditLog.findFirstOrThrow({ where: { action: "admin.seller.direct_create", sellerId: far.body.sellerId } });
    expect(logged.after).toMatchObject({ trialCustom: true });
  });
});

describe("초대로 비밀번호 정하기", () => {
  it("정하면 로그인되고(이전 세션은 끊김), 토큰은 한 번만 쓰이며, 같은 비밀번호 재전송은 성공, 다른 비밀번호·틀린 토큰은 같은 invalid_invite", async () => {
    await db.subscriptionPlan.upsert({ where: { code: "INTEGRATED" }, create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 }, update: {} });
    const su = await admin("SUPER_ADMIN");
    const r = await create(su.cookie);
    const token = tokenOf(r.body.invite);
    expect((await accept(token, "short")).body.error).toBe("weak_password");
    expect((await accept("x".repeat(43), "long-enough-password-1")).body.error).toBe("invalid_invite");
    expect((await accept("short", "long-enough-password-1")).body.error).toBe("invalid_invite");
    const ok = await accept(token, "long-enough-password-1");
    expect(ok).toMatchObject({ status: 200, body: { ok: true, shopSlug: "starlight" } });
    const l = await login("long-enough-password-1");
    expect(l.ok).toBe(true);
    const owner = await db.sellerUser.findFirstOrThrow({ where: { sellerId: r.body.sellerId, isOwner: true } });
    expect(owner.credentialVersion).toBe(1);
    // 한 번만: 다른 비밀번호로 다시 쓰려 하면 실패, 같은 비밀번호 재전송은 성공(응답 유실 대비)
    expect((await accept(token, "another-password-22")).body.error).toBe("invalid_invite");
    expect((await accept(token, "long-enough-password-1")).status).toBe(200);
    expect((await login("another-password-22")).ok).toBe(false);
    const audit = JSON.stringify(await db.auditLog.findMany({ where: { action: "auth.seller.invite_accept" } }));
    expect(audit).not.toContain("long-enough-password-1");
    expect(audit).not.toContain(token);
  });

  it("만료된 초대는 쓸 수 없고, 다시 만들면 이전 미사용 초대는 모두 무효가 되며 새 링크로 정할 수 있다. 직접 추가가 아닌 쇼핑몰은 대상이 아니다", async () => {
    await db.subscriptionPlan.upsert({ where: { code: "INTEGRATED" }, create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 }, update: {} });
    const su = await admin("SUPER_ADMIN");
    const r = await create(su.cookie);
    const first = tokenOf(r.body.invite);
    await db.sellerInvite.updateMany({ where: { sellerId: r.body.sellerId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await accept(first, "long-enough-password-1")).body.error).toBe("invalid_invite");
    const re = await reissueRoute(post(`/api/admin/sellers/${r.body.sellerId}/invite`, su.cookie, {}), sid(r.body.sellerId));
    expect(re.status).toBe(200);
    const body = (await re.json()) as Record<string, any>;
    const second = tokenOf(body.invite);
    expect(second).not.toBe(first);
    const again = await reissueRoute(post(`/api/admin/sellers/${r.body.sellerId}/invite`, su.cookie, {}), sid(r.body.sellerId));
    const third = tokenOf(((await again.json()) as Record<string, any>).invite);
    expect((await accept(second, "long-enough-password-1")).body.error).toBe("invalid_invite"); // 두 번째는 세 번째 재발급으로 무효
    expect((await accept(third, "long-enough-password-1")).status).toBe(200);
    const log = JSON.stringify(await db.auditLog.findMany({ where: { action: "admin.seller.invite_reissue" } }));
    for (const t of [first, second, third]) expect(log).not.toContain(t);
    // 권한·대상
    expect((await reissueRoute(post(`/api/admin/sellers/${r.body.sellerId}/invite`, (await admin("OPERATIONS")).cookie, {}), sid(r.body.sellerId))).status).toBe(403);
    const normal = await db.seller.create({ data: { slug: "normalshop", shopName: "일반", status: "ACTIVE" } });
    const bad = await reissueRoute(post(`/api/admin/sellers/${normal.id}/invite`, su.cookie, {}), sid(normal.id));
    expect(bad.status).toBe(400);
  });
});

describe("본인확인이 끝난 쇼핑몰", () => {
  it("초대 재발급은 거절(identity_verified)하고 아무것도 바꾸지 않으며, 본인확인 전에 받은 남은 초대로도 비밀번호를 바꿀 수 없다", async () => {
    await db.subscriptionPlan.upsert({ where: { code: "INTEGRATED" }, create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 }, update: {} });
    const su = await admin("SUPER_ADMIN");
    const r = await create(su.cookie);
    const pending = tokenOf(r.body.invite); // 아직 안 쓴 초대
    // 본인확인이 끝났다고 표시(DB 제약: 확인 시각과 CI 해시는 함께)
    await db.seller.update({ where: { id: r.body.sellerId }, data: { representativeVerifiedAt: new Date(), representativeCiHash: "ci-hash-verified" } });
    const owner = await db.sellerUser.findFirstOrThrow({ where: { sellerId: r.body.sellerId, isOwner: true } });
    const before = { hash: owner.passwordHash, cv: owner.credentialVersion, invites: await db.sellerInvite.count({ where: { sellerId: r.body.sellerId } }) };
    const re = await reissueRoute(post(`/api/admin/sellers/${r.body.sellerId}/invite`, su.cookie, {}), sid(r.body.sellerId));
    expect(re.status).toBe(400);
    expect(((await re.json()) as Record<string, any>).error).toBe("identity_verified");
    expect(await db.sellerInvite.count({ where: { sellerId: r.body.sellerId } })).toBe(before.invites); // 새 초대 없음
    expect(await db.sellerInvite.count({ where: { sellerId: r.body.sellerId, revokedAt: { not: null } } })).toBe(0);
    // 남은 초대로도 수락할 수 없고, 비밀번호·세션 버전이 그대로다
    expect((await accept(pending, "long-enough-password-1")).body.error).toBe("invalid_invite");
    const after = await db.sellerUser.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.passwordHash).toBe(before.hash);
    expect(after.credentialVersion).toBe(before.cv);
    expect(await db.auditLog.count({ where: { action: { in: ["admin.seller.invite_reissue", "auth.seller.invite_accept"] } } })).toBe(0);
  });
});

describe("본인확인 대기 제한", () => {
  it("직원 추가·적립금 실지급 켜기·충전금 결제는 막히고(identity_pending), 끄기와 로그인·읽기는 된다. 본인확인이 끝나면 풀린다", async () => {
    await db.subscriptionPlan.upsert({ where: { code: "INTEGRATED" }, create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 }, update: {} });
    const su = await admin("SUPER_ADMIN");
    const r = await create(su.cookie);
    await accept(tokenOf(r.body.invite), "long-enough-password-1");
    const l = await login("long-enough-password-1");
    if (!l.ok) throw new Error("login");
    const ctx = await requireSeller(db, l.token, undefined, { allowUnpaid: true, feature: "BILLING" });
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return "ok";
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
    };
    expect(await code(createStaff(db, ctx, { email: "staff@example.com", name: "직원", password: "staff-password-123", permissions: [] }))).toBe("identity_pending");
    expect(await code(updateLivePayout(db, ctx, { enabled: true, confirm: true }))).toBe("identity_pending");
    expect(await code(chargeMessageBalance(db, { charge: async () => ({ ok: false, reason: "declined" }) } as never, ctx, { amount: 10000, idempotencyKey: "k1" }))).toBe("identity_pending");
    expect(await code(updateLivePayout(db, ctx, { enabled: false }))).toBe("ok"); // 끄기는 항상 가능
    // 본인확인이 끝났다고 표시되면 같은 요청이 제한에 걸리지 않는다
    await db.seller.update({ where: { id: r.body.sellerId }, data: { representativeVerifiedAt: new Date(), representativeCiHash: "ci-hash-for-test" } }); // DB 제약: 확인 시각과 CI 해시는 함께
    expect(await isIdentityPending(db, r.body.sellerId)).toBe(false);
    expect(await code(createStaff(db, ctx, { email: "staff@example.com", name: "직원", password: "staff-password-123", permissions: [] }))).toBe("ok");
    // 직접 추가가 아닌 쇼핑몰은 처음부터 대상이 아니다
    const normal = await db.seller.create({ data: { slug: "normalshop", shopName: "일반", status: "ACTIVE" } });
    expect(await isIdentityPending(db, normal.id)).toBe(false);
  });
});

describe("체험 종료일 바꾸기", () => {
  it("최고관리자만, 상한 없이 늘릴 수 있고 전후·사유가 로그에 남는다. 과거 날짜·사유 없음·자동 해지된 쇼핑몰·없는 대상은 거부", async () => {
    await db.subscriptionPlan.upsert({ where: { code: "INTEGRATED" }, create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 }, update: {} });
    const su = await admin("SUPER_ADMIN");
    const r = await create(su.cookie);
    const patch = async (cookie: string, id: string, body: unknown) => {
      const res = await trialRoute(post(`/api/admin/sellers/${id}/trial`, cookie, body, "PATCH"), sid(id));
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const far = "2099-12-31T00:00:00.000Z";
    const before = (await db.seller.findUniqueOrThrow({ where: { id: r.body.sellerId } })).trialEndsAt;
    expect((await patch((await admin("OPERATIONS")).cookie, r.body.sellerId, { trialEndsAt: far, reason: "연장" })).status).toBe(403);
    expect((await patch(su.cookie, r.body.sellerId, { trialEndsAt: far, reason: "" })).body.error).toBe("invalid_reason");
    expect((await patch(su.cookie, r.body.sellerId, { trialEndsAt: "2020-01-01T00:00:00Z", reason: "연장" })).body.error).toBe("invalid_trial");
    const ok = await patch(su.cookie, r.body.sellerId, { trialEndsAt: far, reason: "구독 결제 공급자 준비 전" });
    expect(ok.status).toBe(200);
    expect((await db.seller.findUniqueOrThrow({ where: { id: r.body.sellerId } })).trialEndsAt?.toISOString()).toBe(far);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "admin.seller.trial_set", sellerId: r.body.sellerId } });
    expect(log.before).toMatchObject({ trialEndsAt: before?.toISOString() });
    expect(log.after).toMatchObject({ trialEndsAt: far, reason: "구독 결제 공급자 준비 전" });
    await db.seller.update({ where: { id: r.body.sellerId }, data: { serviceEndedAt: new Date() } });
    expect((await patch(su.cookie, r.body.sellerId, { trialEndsAt: far, reason: "다시" })).body.error).toBe("service_ended");
    expect((await patch(su.cookie, "123e4567-e89b-42d3-a456-426614174000", { trialEndsAt: far, reason: "x" })).body.error).toBe("invalid_target");
  });
});

describe("체험 종료일과 첫 결제 일정", () => {
  it("체험 중 카드를 등록해 첫 결제가 옛 체험 종료일로 잡혀 있으면 같이 옮기고, 결제한 기간의 갱신 일정이나 해지 예약·다른 시각은 건드리지 않는다", async () => {
    await db.subscriptionPlan.upsert({ where: { code: "INTEGRATED" }, create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 }, update: {} });
    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
    const su = await admin("SUPER_ADMIN");
    const a = await create(su.cookie);
    const trial = (await db.seller.findUniqueOrThrow({ where: { id: a.body.sellerId } })).trialEndsAt!;
    const sub = await db.sellerSubscription.create({ data: { sellerId: a.body.sellerId, planId: plan.id, status: "ACTIVE", nextChargeAt: trial, subscribedAt: new Date() } });
    const patch = (id: string, trialEndsAt: string) => trialRoute(post(`/api/admin/sellers/${id}/trial`, su.cookie, { trialEndsAt, reason: "연장" }, "PATCH"), sid(id));
    const far = "2099-12-31T00:00:00.000Z";
    expect((await patch(a.body.sellerId, far)).status).toBe(200);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).nextChargeAt?.toISOString()).toBe(far); // 첫 결제 일정이 함께 옮겨짐
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "admin.seller.trial_set", sellerId: a.body.sellerId } });
    expect(log.after).toMatchObject({ firstChargeMoved: true });
    // 단축도 같이 옮긴다(지금보다 뒤 날짜)
    const sooner = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect((await patch(a.body.sellerId, sooner)).status).toBe(200);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub.id } })).nextChargeAt?.toISOString()).toBe(sooner);

    // 결제한 기간의 갱신 일정(nextChargeAt이 체험 종료일과 다름)은 그대로
    const b = await create(su.cookie, { slug: "secondshop", ownerEmail: "second@example.com" });
    const renew = new Date(Date.now() + 20 * 86_400_000);
    const sub2 = await db.sellerSubscription.create({ data: { sellerId: b.body.sellerId, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 25 * 86_400_000), nextChargeAt: renew, subscribedAt: new Date() } });
    expect((await patch(b.body.sellerId, far)).status).toBe(200);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub2.id } })).nextChargeAt?.getTime()).toBe(renew.getTime());
    const log2 = await db.auditLog.findFirstOrThrow({ where: { action: "admin.seller.trial_set", sellerId: b.body.sellerId } });
    expect(log2.after).toMatchObject({ firstChargeMoved: false });

    // 해지 예약된 구독은 건드리지 않는다
    const c = await create(su.cookie, { slug: "thirdshop", ownerEmail: "third@example.com" });
    const trialC = (await db.seller.findUniqueOrThrow({ where: { id: c.body.sellerId } })).trialEndsAt!;
    const sub3 = await db.sellerSubscription.create({ data: { sellerId: c.body.sellerId, planId: plan.id, status: "ACTIVE", cancelAtPeriodEnd: true, nextChargeAt: trialC, subscribedAt: new Date() } });
    expect((await patch(c.body.sellerId, far)).status).toBe(200);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: sub3.id } })).nextChargeAt?.getTime()).toBe(trialC.getTime());
  });
});

describe("초대 링크 주소", () => {
  it("설정(OBS_SITE_ADDRESS)이 호스트 이름이면 그것으로, 아니면 요청 주소로, 둘 다 없으면 경로만 준다(하드코딩 없음)", () => {
    const h = (host: string | null) => ({ get: (n: string) => (n.toLowerCase() === "host" ? host : null) });
    process.env.OBS_SITE_ADDRESS = "Shop.Example.com";
    expect(inviteLink("T", h("other.test")).url).toBe("https://shop.example.com/seller/invite#T");
    process.env.OBS_SITE_ADDRESS = ":80"; // Caddy 기본값은 주소가 아니다
    expect(inviteLink("T", h("admin.example.com")).url).toMatch(/^https?:\/\/admin\.example\.com\/seller\/invite#T$/); // 요청 주소(운영은 https)
    expect(inviteLink("T", h("localhost:3000")).url).toBe("http://localhost:3000/seller/invite#T");
    delete process.env.OBS_SITE_ADDRESS;
    expect(inviteLink("T", null)).toEqual({ path: "/seller/invite#T", url: null });
    process.env.OBS_SITE_ADDRESS = "bad host!";
    expect(inviteLink("T", null).url).toBeNull();
  });

  it("운영에서 설정이 없거나 호스트 이름이 아니면 요청 헤더(Host)를 믿지 않고 경로만 준다", () => {
    const h = (host: string) => ({ get: (n: string) => (n.toLowerCase() === "host" ? host : n.toLowerCase() === "x-forwarded-host" ? host : null) });
    vi.stubEnv("NODE_ENV", "production");
    try {
      delete process.env.OBS_SITE_ADDRESS;
      expect(inviteLink("T", h("evil.example"))).toEqual({ path: "/seller/invite#T", url: null });
      process.env.OBS_SITE_ADDRESS = ":80";
      expect(inviteLink("T", h("evil.example")).url).toBeNull();
      process.env.OBS_SITE_ADDRESS = "shop.example.com";
      expect(inviteLink("T", h("evil.example")).url).toBe("https://shop.example.com/seller/invite#T");
    } finally { vi.unstubAllEnvs(); }
  });
});
