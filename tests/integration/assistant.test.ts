import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as docsGet, POST as docsPost } from "../../app/api/admin/assistant/docs/route";
import { GET as questionsGet } from "../../app/api/admin/assistant/questions/route";
import { GET as settingsGet, PUT as settingsPut } from "../../app/api/admin/assistant/settings/route";
import { GET as sellerGet, POST as sellerPost } from "../../app/api/seller/assistant/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { askAssistant, ASSISTANT_MESSAGES, scrubQuestion } from "../../lib/server/assistant/service";
import type { GeminiGenerate } from "../../lib/server/assistant/gemini";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 도우미(SA-140 · MA-055 · MA-084): 키 없을 때 꺼짐, 설정 미완성·꺼짐, 월 한도 도달 차단, 동시 호출 한도 초과 방지(월·하루),
// 호출 실패 시 예상 비용 반환, 원장 기록, 개인정보 가림, 답하지 못한 질문 기록, 권한(설정 변경은 최고관리자만), 로그 추적.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function adminCookie(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

async function shop() {
  const { seller } = await createSeller();
  const u = await createSellerUser(seller.id, "OWNER");
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  const ctx = { sellerId: seller.id, actorType: "SELLER_USER", actorId: u.id, isOwner: true, permissions: [] } as unknown as TenantContext;
  return { seller, ctx, cookie: `lo_seller=${r.token}` };
}

const READY = { enabled: true, model: "test-model", inputWonPerMTok: 1000, outputWonPerMTok: 1000, monthlyBudgetWon: 10_000, sellerDailyLimit: 20 };
async function configure(over: Partial<typeof READY> = {}) {
  const { enabled, ...rest } = { ...READY, ...over };
  await db.assistantSetting.upsert({ where: { id: 1 }, create: { id: 1, enabled, ...rest }, update: { enabled, ...rest } });
}
async function addDoc(published = true) {
  const a = await createAdmin("CS");
  return db.assistantDoc.create({ data: { title: "주문 취소 방법", body: "주문 관리에서 주문을 고른 뒤 취소 버튼을 누릅니다.", published, createdByAdminId: a.id, updatedByAdminId: a.id } });
}
const KEY = () => "test-key";
const ok = (text = "주문 관리에서 취소합니다", inputTokens = 100, outputTokens = 20): GeminiGenerate => async () => ({ text, inputTokens, outputTokens });
const Q = { question: "주문 취소 어떻게 해요?" };
const used = async () => (await db.assistantMonthUsage.findMany())[0]?.usedMilliWon ?? 0;

describe("꺼짐·준비 중", () => {
  it("키가 없으면 모델을 부르지 않고 준비 중이다", async () => {
    const s = await shop();
    await configure();
    await addDoc();
    let calls = 0;
    const r = await askAssistant(db, s.ctx, Q, { apiKey: () => null, generate: async () => (calls++, { text: "x", inputTokens: 1, outputTokens: 1 }) });
    expect(r).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toBe(0);
    expect(await db.assistantLedger.count()).toBe(0);
    // 라우트(환경변수 키 없음): 503 + 준비 중 문구, 상태 조회는 available:false
    delete process.env.GEMINI_API_KEY;
    expect(await json(await sellerPost(req("/api/seller/assistant", s.cookie, "POST", Q)))).toMatchObject({ status: 503, body: { error: "unavailable", message: "도우미는 준비 중입니다" } });
    expect((await json(await sellerGet(req("/api/seller/assistant", s.cookie)))).body.available).toBe(false);
  });

  it("설정이 꺼져 있거나 모델·단가가 비면 준비 중이다", async () => {
    const s = await shop();
    await addDoc();
    for (const over of [{ enabled: false }, { model: "" }, { inputWonPerMTok: 0 }] as const) {
      await configure(over);
      expect(await askAssistant(db, s.ctx, Q, { apiKey: KEY, generate: ok() })).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("로그인하지 않으면 401", async () => {
    expect((await sellerPost(req("/api/seller/assistant", "", "POST", Q))).status).toBe(401);
  });
});

describe("호출·원장·가림", () => {
  it("답하고 토큰·비용을 원장과 월 사용액에 남긴다. 모델에는 가린 질문과 게시 자료만 간다", async () => {
    const s = await shop();
    await configure();
    await addDoc();
    await addDoc(false); // 미게시 자료는 근거가 아니다
    const seen: { system: string; question: string }[] = [];
    const r = await askAssistant(db, s.ctx, { question: "주문 취소 어떻게 해요? hong@example.com 010-1234-5678" }, {
      apiKey: KEY,
      generate: async (x) => (seen.push({ system: x.system, question: x.question }), { text: "취소 버튼을 누릅니다", inputTokens: 1000, outputTokens: 200 }),
    });
    expect(r).toMatchObject({ ok: true, answered: true, answer: "취소 버튼을 누릅니다", remainingToday: 19 });
    expect(seen[0].question).not.toMatch(/hong@|010-1234/);
    expect(seen[0].question).toContain("[가림]");
    expect(seen[0].system).not.toContain(s.seller.id);
    expect(seen[0].system.match(/## 주문 취소 방법/g)).toHaveLength(1);
    const row = await db.assistantLedger.findFirstOrThrow();
    // (1000×1000 + 200×1000) ÷ 1000 = 1200 (1/1000원)
    expect(row).toMatchObject({ status: "OK", inputTokens: 1000, outputTokens: 200, costMilliWon: 1200, model: "test-model", sellerId: s.seller.id });
    expect(row.question).not.toMatch(/hong@|010-1234/);
    expect(await used()).toBe(1200);
  });

  it("scrubQuestion은 이메일·전화번호·긴 숫자를 가린다", () => {
    expect(scrubQuestion("a@b.co 번호 01012345678 카드 1234-5678-9012 주문 3건")).toBe("[가림] 번호 [가림] 카드 [가림] 주문 3건");
  });

  it("자료에 답이 없다는 답은 답하지 못한 질문으로 남고, 문의하기 안내를 준다", async () => {
    const s = await shop();
    await configure();
    await addDoc();
    const r = await askAssistant(db, s.ctx, Q, { apiKey: KEY, generate: ok("[NO_ANSWER]") });
    expect(r).toMatchObject({ ok: true, answered: false, answer: ASSISTANT_MESSAGES.no_answer });
    const admin = await adminCookie("READ_ONLY");
    const list = await json(await questionsGet(req("/api/admin/assistant/questions?unanswered=1", admin.cookie)));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ question: Q.question, answered: false });
  });

  it("관련 자료가 없으면 모델을 부르지 않고 비용도 없다", async () => {
    const s = await shop();
    await configure();
    let calls = 0;
    const r = await askAssistant(db, s.ctx, Q, { apiKey: KEY, generate: async () => (calls++, { text: "x", inputTokens: 1, outputTokens: 1 }) });
    expect(r).toMatchObject({ ok: true, answered: false });
    expect(calls).toBe(0);
    expect(await used()).toBe(0);
    expect(await db.assistantLedger.findFirstOrThrow()).toMatchObject({ status: "NO_ANSWER", costMilliWon: 0 });
  });

  it("질문이 비었거나 너무 길면 400", async () => {
    const s = await shop();
    await configure();
    await addDoc();
    for (const q of ["", "  ", "가".repeat(301), 5]) expect(await askAssistant(db, s.ctx, { question: q }, { apiKey: KEY, generate: ok() })).toEqual({ ok: false, reason: "invalid_question" });
  });

  it("호출이 실패하면 먼저 잡은 예상 비용을 돌려주고 ERROR로 남긴다", async () => {
    const s = await shop();
    await configure();
    await addDoc();
    const r = await askAssistant(db, s.ctx, Q, { apiKey: KEY, generate: async () => Promise.reject(new Error("boom")) });
    expect(r).toEqual({ ok: false, reason: "upstream_error" });
    expect(await used()).toBe(0);
    expect(await db.assistantLedger.findFirstOrThrow()).toMatchObject({ status: "ERROR", costMilliWon: 0 });
  });
});

describe("한도", () => {
  it("월 한도에 닿으면 모델을 부르지 않고 막는다", async () => {
    const s = await shop();
    await configure({ monthlyBudgetWon: 1, inputWonPerMTok: 10_000, outputWonPerMTok: 10_000 }); // 한도 1,000(1/1000원) < 예상 비용(자료 길이 + 출력 512 토큰 × 단가)
    await addDoc();
    let calls = 0;
    const r = await askAssistant(db, s.ctx, Q, { apiKey: KEY, generate: async () => (calls++, { text: "x", inputTokens: 1, outputTokens: 1 }) });
    expect(r).toEqual({ ok: false, reason: "budget_exhausted" });
    expect(calls).toBe(0);
    expect(ASSISTANT_MESSAGES.budget_exhausted).toBe("이번 달 도우미 사용량이 다 찼습니다");
    expect(await used()).toBe(0);
    // 막힌 호출은 하루 횟수도 쓰지 않는다
    expect((await db.assistantSellerDay.findMany()).reduce((n, d) => n + d.count, 0)).toBe(0);
  });

  it("쌓인 사용액이 한도에 가까우면 다음 호출을 막고, 월이 바뀌면 다시 열린다", async () => {
    const s = await shop();
    await configure({ monthlyBudgetWon: 2 });
    await addDoc();
    const [{ month }] = await db.$queryRaw<{ month: string }[]>`SELECT to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') AS month`;
    await db.assistantMonthUsage.create({ data: { month, usedMilliWon: 1990 } });
    expect(await askAssistant(db, s.ctx, Q, { apiKey: KEY, generate: ok() })).toEqual({ ok: false, reason: "budget_exhausted" });
    await db.assistantMonthUsage.update({ where: { month }, data: { month: "2000-01" } }); // 지난달 사용액은 이번 달에 안 센다
    expect(await askAssistant(db, s.ctx, Q, { apiKey: KEY, generate: ok() })).toMatchObject({ ok: true });
  });

  it("동시에 불러도 월 한도를 넘지 않는다", async () => {
    const s = await shop();
    await configure({ monthlyBudgetWon: 3, sellerDailyLimit: 100, inputWonPerMTok: 2000, outputWonPerMTok: 2000 }); // 한도 3,000. 호출 하나의 예상 비용은 1,200~1,500
    await addDoc();
    let inflight = 0;
    let peak = 0;
    let calls = 0;
    const slow: GeminiGenerate = async () => {
      calls++;
      peak = Math.max(peak, ++inflight);
      await new Promise((r) => setTimeout(r, 150));
      inflight--;
      return { text: "답", inputTokens: 10, outputTokens: 10 };
    };
    const rs = await Promise.all(Array.from({ length: 10 }, () => askAssistant(db, s.ctx, Q, { apiKey: KEY, generate: slow })));
    const okCount = rs.filter((r) => r.ok).length;
    expect(calls).toBe(okCount);
    expect(okCount).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "budget_exhausted")).toBe(true);
    expect(await used()).toBeLessThanOrEqual(3000);
  });

  it("파트너스별 하루 호출 수를 동시에 불러도 넘지 못하고, 다른 파트너스는 따로 센다", async () => {
    const a = await shop();
    const b = await shop();
    await configure({ sellerDailyLimit: 2 });
    await addDoc();
    const rs = await Promise.all(Array.from({ length: 8 }, () => askAssistant(db, a.ctx, Q, { apiKey: KEY, generate: ok() })));
    expect(rs.filter((r) => r.ok)).toHaveLength(2);
    expect(rs.filter((r) => !r.ok && r.reason === "daily_limit")).toHaveLength(6);
    expect(await askAssistant(db, b.ctx, Q, { apiKey: KEY, generate: ok() })).toMatchObject({ ok: true, remainingToday: 1 });
  });
});

describe("마스터 관리자 권한·로그 추적", () => {
  it("설정 변경은 최고관리자만, 보기는 모든 역할", async () => {
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) {
      const a = await adminCookie(role);
      expect((await settingsPut(req("/api/admin/assistant/settings", a.cookie, "PUT", { monthlyBudgetWon: 99999 }))).status).toBe(403);
      expect((await settingsGet(req("/api/admin/assistant/settings", a.cookie))).status).toBe(200);
    }
    expect((await db.assistantSetting.findMany()).length).toBe(0);
    expect((await settingsGet(req("/api/admin/assistant/settings", ""))).status).toBe(401);
  });

  it("최고관리자는 바꾸고 로그 추적에 전후가 남는다. 켜려면 모델·단가가 필요하다", async () => {
    const sa = await adminCookie("SUPER_ADMIN");
    const put = async (b: unknown) => json(await settingsPut(req("/api/admin/assistant/settings", sa.cookie, "PUT", b)));
    expect(await put({ enabled: true })).toMatchObject({ status: 400, body: { error: "incomplete_settings" } });
    expect(await put({ monthlyBudgetWon: -1 })).toMatchObject({ status: 400, body: { error: "invalid_settings" } });
    expect(await put({ model: "bad model/../x" })).toMatchObject({ status: 400, body: { error: "invalid_settings" } });
    const r = await put({ model: "test-model", inputWonPerMTok: 100, outputWonPerMTok: 400, enabled: true, monthlyBudgetWon: 10000 });
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({ enabled: true, model: "test-model", monthlyBudgetWon: 10000 });
    expect(r.body.keyConfigured).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/apiKey|GEMINI_API_KEY/);
    const logs = await db.auditLog.findMany({ where: { action: "assistant.settings.update" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorId: sa.id, before: { enabled: false, model: "" }, after: { enabled: true, model: "test-model", monthlyBudgetWon: 10000 } });
    // 오래된 version으로 보내면 409
    expect(await put({ sellerDailyLimit: 5, expectedVersion: 0 })).toMatchObject({ status: 409, body: { error: "version_conflict", currentVersion: 1 } });
  });

  it("자료는 최고관리자·CS만 쓰고, 게시한 자료만 근거가 된다", async () => {
    const cs = await adminCookie("CS");
    const ro = await adminCookie("READ_ONLY");
    const body = { title: "주문 취소 방법", body: "취소 버튼을 누릅니다.", published: true };
    expect((await docsPost(req("/api/admin/assistant/docs", ro.cookie, "POST", body))).status).toBe(403);
    expect((await json(await docsPost(req("/api/admin/assistant/docs", cs.cookie, "POST", body)))).status).toBe(201);
    expect((await json(await docsPost(req("/api/admin/assistant/docs", cs.cookie, "POST", { title: "", body: "x" })))).body.error).toBe("invalid_title");
    expect((await json(await docsGet(req("/api/admin/assistant/docs", ro.cookie)))).body.items).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "assistant.doc.create" } })).toBe(1);
  });
});
