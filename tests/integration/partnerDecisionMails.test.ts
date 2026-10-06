import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as infoGet, PUT as infoPut } from "../../app/api/admin/settings/platform-business/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { FakeMailSender } from "../../lib/server/mail/registry";
import { APPROVE_DELAY_MS, sendDecisionMails } from "../../lib/server/sellers/decisionMails";
import { createAdmin, createSellerUser, db, resetDb } from "./helpers";

// 파트너스 가입 승인·반려 안내 메일(EM-101·102) 정기 발송과 플랫폼 사업자 정보 설정
beforeEach(async () => {
  await resetDb();
  process.env.APP_ORIGIN = "https://onq.example";
});
afterEach(() => {
  delete process.env.APP_ORIGIN;
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const NOW = new Date("2026-10-06T03:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const FULL = { name: "온큐 주식회사", representative: "박플랫폼", businessNumber: "123-45-67890", address: "서울 중구 세종대로 1", phone: "1588-0000" };

async function platform(over: Record<string, string> = {}) {
  await db.platformBusinessInfo.upsert({ where: { id: 1 }, create: { id: 1, ...FULL, ...over }, update: { ...FULL, ...over } });
}
async function plan(over: Record<string, unknown> = {}) {
  return db.subscriptionPlan.create({ data: { code: `p${Math.random().toString(36).slice(2, 8)}`, name: "오버레이", listPrice: 79_000, salePrice: 59_000, trialDays: 7, ...over } });
}
async function applicant(over: Record<string, unknown> = {}, email = `owner${Math.random().toString(36).slice(2, 8)}@example.com`) {
  const s = await db.seller.create({
    data: { slug: `s${Math.random().toString(36).slice(2, 8)}`, shopName: "카드숍 별빛", status: "ACTIVE", businessInfo: { representativeName: "김대표" }, approvedAt: ago(60_000), trialEndsAt: new Date("2026-10-13T00:00:00Z"), ...over },
  });
  const u = await createSellerUser(s.id, "OWNER", email);
  return { s, email: u.email };
}
const run = (sender: FakeMailSender | null) => sendDecisionMails(prisma, NOW, { sender });

describe("승인 메일(EM-101)", () => {
  it("승인한 지 30초가 지나면 대표자 이메일로 한 번만 보낸다(체험 플랜: 체험 안내), 다시 돌려도 중복 없음", async () => {
    await platform();
    const p = await plan();
    const { s, email } = await applicant({ planId: p.id });
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(1);
    expect(sender.sent).toHaveLength(1);
    const m = sender.sent[0];
    expect(m.to).toBe(email);
    expect(m.subject).toBe("[ONQ] 가입이 승인됐어요");
    for (const t of ["김대표님, 카드숍 별빛의 파트너스 가입이 승인됐어요", "https://onq.example/seller/login", email, "오늘부터 7일 동안 체험해 보세요", "2026.10.13까지 체험할 수 있어요", `onq.example/shop/${s.slug}`, "상호 온큐 주식회사", "사업자등록번호 123-45-67890"]) expect(m.text).toContain(t);
    expect(await run(sender)).toBe(0);
    expect(sender.sent).toHaveLength(1);
    const row = await db.mailDelivery.findFirstOrThrow({ where: { kind: "application.approved", refId: s.id } });
    expect(row).toMatchObject({ status: "SENT", sellerId: null, charged: false });
  });

  it("쇼핑몰 통합(체험 없음)은 구독 결제 안내와 런칭 할인가·정가", async () => {
    await platform();
    const p = await plan({ trialDays: 0, listPrice: 249_000, salePrice: 179_000 });
    await applicant({ planId: p.id, trialEndsAt: null });
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(1);
    expect(sender.sent[0].text).toContain("쇼핑몰 통합은 체험 없이 구독 결제로 시작해요");
    expect(sender.sent[0].text).toContain("월 179,000원(부가세 포함) · 정가 249,000원");
    expect(sender.sent[0].text).not.toContain("체험 기간");
  });

  it("승인 되돌리기 시간(30초) 안·승인 대기로 돌아간 신청·7일 지난 승인·대표자 계정 없음은 보내지 않는다", async () => {
    await platform();
    const p = await plan();
    await applicant({ planId: p.id, approvedAt: ago(APPROVE_DELAY_MS - 1000) }); // 아직 되돌릴 수 있음
    await applicant({ planId: p.id, status: "PENDING", approvedAt: null }); // 되돌려 대기
    await applicant({ planId: p.id, approvedAt: ago(8 * 86_400_000) }); // 7일 지남
    await db.seller.create({ data: { slug: "noowner", shopName: "대표자 없음", status: "ACTIVE", approvedAt: ago(60_000), trialEndsAt: new Date("2026-10-13T00:00:00Z"), planId: p.id } });
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(await db.mailDelivery.count()).toBe(0);
  });
});

describe("반려 메일(EM-102)", () => {
  it("반려한 신청자에게 사유 그대로 한 번 보낸다(다시 신청·신청 상태 링크)", async () => {
    await platform();
    const { s, email } = await applicant({ status: "REJECTED", approvedAt: null, trialEndsAt: null, rejectedReason: "사업자등록번호가 휴업 상태입니다", rejectedAt: ago(120_000) });
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(1);
    const m = sender.sent[0];
    expect(m.to).toBe(email);
    expect(m.subject).toBe("[ONQ] 가입 신청을 승인하지 못했어요");
    for (const t of ["승인하지 못한 이유", "사업자등록번호가 휴업 상태입니다", "고쳐서 다시 신청하기: https://onq.example/seller/signup", "신청 상태 보기: https://onq.example/seller/pending"]) expect(m.text).toContain(t);
    expect(await run(sender)).toBe(0);
    expect(await db.mailDelivery.count({ where: { kind: "application.rejected", refId: s.id } })).toBe(1);
  });
});

describe("보내지 않는 경우", () => {
  it("공급자가 없거나 플랫폼 사업자 정보가 비었거나 APP_ORIGIN이 없으면 아무것도 보내지 않고 기록하지 않는다(채워지면 따라 보냄)", async () => {
    const p = await plan();
    await applicant({ planId: p.id });
    const sender = new FakeMailSender();
    expect(await run(null)).toBe(0);
    expect(await run(sender)).toBe(0); // 사업자 정보 없음
    await platform({ phone: "" });
    expect(await run(sender)).toBe(0); // 한 칸이 비어 있음
    await platform();
    delete process.env.APP_ORIGIN;
    expect(await run(sender)).toBe(0);
    expect(await db.mailDelivery.count()).toBe(0);
    process.env.APP_ORIGIN = "https://onq.example";
    expect(await run(sender)).toBe(1);
  });

  it("동시에 두 번 돌려도 한 통만 보낸다", async () => {
    await platform();
    const p = await plan();
    await applicant({ planId: p.id });
    const sender = new FakeMailSender();
    const [a, b] = await Promise.all([run(sender), run(sender)]);
    expect(a + b).toBe(1);
    expect(sender.sent).toHaveLength(1);
  });

  it("플랫폼 한도에 걸려 못 보낸 건은 기록이 남아 다시 보내지 않는다(재시도 폭주 방지)", async () => {
    await platform();
    const p = await plan();
    const { s } = await applicant({ planId: p.id });
    await db.mailDelivery.create({ data: { sellerId: null, kind: "application.approved", refId: s.id, month: "2026-10", status: "SKIPPED_PLATFORM_LIMIT" } });
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });
});

describe("플랫폼 사업자 정보 설정(마스터 관리자)", () => {
  const cookieOf = async (role: "SUPER_ADMIN" | "CS" | "READ_ONLY") => `lo_admin=${(await createAdminSession(db, (await createAdmin(role)).id, {})).token}`;
  const put = async (cookie: string, body: unknown) => {
    const r = await infoPut(new Request(`${BASE}/api/admin/settings/platform-business`, { method: "PUT", headers: { ...H, cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  const get = async (cookie: string) => {
    const r = await infoGet(new Request(`${BASE}/api/admin/settings/platform-business`, { headers: { ...H, cookie } }));
    return { status: r.status, body: await r.json() };
  };

  it("전 역할 조회, 최고관리자만 수정, 사업자등록번호 형식 검사, 모든 칸이 차면 complete, 로그에는 칸 이름만", async () => {
    const root = await cookieOf("SUPER_ADMIN");
    const cs = await cookieOf("CS");
    expect((await get(cs)).body).toMatchObject({ name: "", complete: false, updatedAt: null });
    expect((await put(cs, { name: "x" })).status).toBe(403);
    expect((await put(root, { businessNumber: "1234567890" })).body).toMatchObject({ error: "invalid_field", field: "businessNumber" });
    expect((await put(root, { name: 5 })).body).toMatchObject({ error: "invalid_field", field: "name" });
    expect((await put(root, { name: "가".repeat(61) })).body.field).toBe("name");

    const partial = await put(root, { name: FULL.name, representative: FULL.representative });
    expect(partial).toMatchObject({ status: 200, body: { changed: ["name", "representative"], info: { complete: false } } });
    const full = await put(root, { businessNumber: FULL.businessNumber, address: FULL.address, phone: FULL.phone });
    expect(full.body.info).toMatchObject({ ...FULL, complete: true });
    expect((await get(cs)).body).toMatchObject({ ...FULL, complete: true });
    // 같은 값을 다시 보내면 바뀐 칸 없음·로그 없음, 빈 값으로 비울 수 있다
    const before = await db.auditLog.count({ where: { action: "platform.business_info.update" } });
    expect((await put(root, { name: FULL.name })).body.changed).toEqual([]);
    expect(await db.auditLog.count({ where: { action: "platform.business_info.update" } })).toBe(before);
    expect((await put(root, { phone: "" })).body.info.complete).toBe(false);
    const logs = await db.auditLog.findMany({ where: { action: "platform.business_info.update" } });
    expect(JSON.stringify(logs.map((l) => l.after))).not.toContain(FULL.businessNumber);
  });
});
