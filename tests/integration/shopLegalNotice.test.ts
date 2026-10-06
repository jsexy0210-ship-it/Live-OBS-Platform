import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as get, PUT as put } from "../../app/api/seller/shop-legal-notice/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { footerNotice, NOTICE_MESSAGES } from "../../lib/server/shop-legal/notice";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 쇼핑몰 바닥글 법정 표시 입력(SA-062 사업자 정보·고지): 권한, 검사(전화·이메일·https 주소·구매안전서비스 규칙·글자 수), version 충돌·동시 저장,
// 판매자 격리, 입점 신청 검증 값은 읽기 전용, 로그 추적에 입력 값이 남지 않음.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const PATH = "/api/seller/shop-legal-notice";
const req = (method: string, cookie?: string, body?: unknown) =>
  new Request(BASE + PATH, { method, headers: { ...H, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const read = async (cookie?: string) => json(await get(req("GET", cookie)));
const save = async (cookie: string, body: unknown) => json(await put(req("PUT", cookie, body)));

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { businessInfo: { companyName: "별빛상사", representativeName: "홍길동", businessNumber: "1234567890", mailOrderNumber: "2026-서울-0001", checkedAt: "x" } } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const staff = await createSellerUser(seller.id, { permissions: ["SHOP_SETTINGS"] });
  const other = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  return { seller, owner: await cookieOf(owner.email), staff: await cookieOf(staff.email), noPerm: await cookieOf(other.email) };
}
const OK = { address: "서울시 중구 세종대로 1", csPhone: "1588-1234", csEmail: "cs@example.com", csHours: "평일 10:00~17:00", escrowKind: "escrow", escrowProvider: "시험결제", escrowUrl: "https://pay.example.com/escrow", minorNotice: "미성년자 구매 안내 글", expectedVersion: 0 };

describe("입력", () => {
  it("대표자·쇼핑몰 설정 직원만 쓰고, 다른 직원은 보기만 하며, 로그인 없으면 401. 검증 값은 읽기 전용으로 함께 보인다", async () => {
    const s = await shop();
    expect(await read(s.owner)).toMatchObject({
      status: 200,
      body: { notice: { address: "", escrowKind: "none", version: 0 }, business: { companyName: "별빛상사", representativeName: "홍길동", businessNumber: "1234567890", mailOrderNumber: "2026-서울-0001" } },
    });
    expect((await save(s.owner, OK)).status).toBe(200);
    expect((await save(s.staff, { ...OK, address: "직원이 고침", expectedVersion: 1 })).status).toBe(200);
    expect((await save(s.noPerm, { ...OK, expectedVersion: 2 })).status).toBe(403);
    expect((await read(s.noPerm)).body.notice).toMatchObject({ address: "직원이 고침", version: 2 });
    expect((await read()).status).toBe(401);
    expect((await save("", { ...OK, expectedVersion: 2 })).status).toBe(401);
    // 본문에 검증 값을 보내도 바뀌지 않는다
    await save(s.owner, { ...OK, expectedVersion: 2, companyName: "바꾼 상호", businessNumber: "9999999999" });
    expect((await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).businessInfo).toMatchObject({ companyName: "별빛상사", businessNumber: "1234567890" });
  });

  it("잘못된 값을 막는다(전화·이메일·글자 수·구매안전서비스·https 주소·미성년자 안내)", async () => {
    const s = await shop();
    const bad = async (patch: object, error: string) => {
      const r = await save(s.owner, { ...OK, ...patch });
      expect([r.status, r.body.error], JSON.stringify(patch)).toEqual([400, error]);
      expect(r.body.message).toBe(NOTICE_MESSAGES[error as keyof typeof NOTICE_MESSAGES]);
    };
    await bad({ address: "가".repeat(201) }, "invalid_address");
    await bad({ address: "a\u0000b" }, "invalid_address");
    await bad({ csPhone: "전화번호" }, "invalid_phone");
    await bad({ csPhone: "12" }, "invalid_phone");
    await bad({ csPhone: "<script>1</script>" }, "invalid_phone");
    await bad({ csEmail: "not-an-email" }, "invalid_email");
    await bad({ csEmail: "a@b" }, "invalid_email");
    await bad({ csEmail: `${"a".repeat(100)}@example.com` }, "invalid_email");
    await bad({ csHours: "가".repeat(101) }, "invalid_hours");
    await bad({ escrowKind: "other" }, "invalid_escrow_kind");
    await bad({ escrowProvider: "" }, "invalid_escrow_provider"); // 가입했으면 업체 필수
    await bad({ escrowProvider: "가".repeat(61) }, "invalid_escrow_provider");
    for (const url of ["http://pay.example.com", "javascript:alert(1)", "https://user:pw@pay.example.com", "https://localhost", "//pay.example.com", `https://pay.example.com/${"a".repeat(300)}`]) {
      await bad({ escrowUrl: url }, "invalid_escrow_url");
    }
    await bad({ minorNotice: "가".repeat(1001) }, "invalid_minor_notice");
    await bad({ kakaoChannelUrl: "http://pf.kakao.com/_abc" }, "invalid_kakao_url");
    await bad({ kakaoChannelUrl: "javascript:alert(1)" }, "invalid_kakao_url");
    await bad({ youtubeChannelUrl: "youtube.com/@byulbit" }, "invalid_youtube_url");
    // 가입하지 않음이면 업체·주소 없이 저장되고, 빈 값은 모두 허용된다
    expect((await save(s.owner, { escrowKind: "none", expectedVersion: 0 })).body.notice).toMatchObject({ escrowKind: "none", address: "", version: 1 });
    // 상한 정확히는 저장된다
    expect((await save(s.owner, { address: "가".repeat(200), minorNotice: "나".repeat(1000), expectedVersion: 1 })).status).toBe(200);
  });

  it("카카오톡·유튜브 채널 주소(https)를 저장하고 읽으며, 비우면 지운다", async () => {
    const s = await shop();
    const r = await save(s.owner, { ...OK, kakaoChannelUrl: "https://pf.kakao.com/_abcdef", youtubeChannelUrl: "https://www.youtube.com/@byulbit" });
    expect(r.status).toBe(200);
    expect(r.body.notice).toMatchObject({ kakaoChannelUrl: "https://pf.kakao.com/_abcdef", youtubeChannelUrl: "https://www.youtube.com/@byulbit", version: 1 });
    expect((await read(s.owner)).body.notice).toMatchObject({ kakaoChannelUrl: "https://pf.kakao.com/_abcdef" });
    const cleared = await save(s.owner, { ...OK, kakaoChannelUrl: "", youtubeChannelUrl: null, expectedVersion: 1 });
    expect(cleared.body.notice).toMatchObject({ kakaoChannelUrl: "", youtubeChannelUrl: "" });
  });

  it("옛 version은 409, 같은 version 동시 저장은 하나만 성공한다", async () => {
    const s = await shop();
    expect((await save(s.owner, OK)).body.notice.version).toBe(1);
    expect(await save(s.owner, OK)).toMatchObject({ status: 409, body: { error: "version_conflict", currentVersion: 1 } });
    expect((await save(s.owner, { ...OK, expectedVersion: undefined })).status).toBe(409);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => save(s.owner, { ...OK, address: `동시 ${i}`, expectedVersion: 1 })));
    expect(rs.map((x) => x.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect((await read(s.owner)).body.notice.version).toBe(2);
  });

  it("로그 추적에는 입력 값이 남지 않고 바뀐 칸 이름만 남는다", async () => {
    const s = await shop();
    await save(s.owner, OK);
    await save(s.owner, { ...OK, csPhone: "02-123-4567", expectedVersion: 1 });
    const logs = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: "shop.legal_notice.update" }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(2);
    expect(logs[1].after).toMatchObject({ version: 2, changed: ["csPhone"], escrowKind: "ESCROW" });
    const all = JSON.stringify(logs);
    for (const v of ["세종대로", "02-123-4567", "cs@example.com", "시험결제", "pay.example.com", "미성년자 구매 안내 글"]) expect(all).not.toContain(v);
  });

  it("판매자 격리: 다른 쇼핑몰 값이 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await save(a.owner, { ...OK, address: "A 쇼핑몰 주소" });
    expect((await read(b.owner)).body.notice).toMatchObject({ address: "", version: 0 });
    await save(b.owner, { ...OK, address: "B 쇼핑몰 주소" });
    expect((await read(a.owner)).body.notice.address).toBe("A 쇼핑몰 주소");
    expect(await footerNotice(db as never, a.seller.id)).toMatchObject({ address: "A 쇼핑몰 주소", escrowKind: "escrow", version: 1 });
    expect(await footerNotice(db as never, b.seller.id)).toMatchObject({ address: "B 쇼핑몰 주소" });
  });
});
