import type { AssistantDoc, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden, notFound } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { decodeCursor, encodeCursor } from "../orders/read";
import { cleanText } from "../text/clean";
import { assistantApiKey, MODEL_NAME } from "./gemini";
import { isAvailable, kstPeriod, loadSettings, settingsComplete } from "./service";

// 마스터 관리자 도우미: 답변 자료(MA-055)·설정(MA-084). 규칙:
// - 보기는 모든 역할(platform.read). 자료 쓰기·지우기는 최고관리자·CS(support.manage). 설정(켜기·모델·단가·월 한도·하루 한도) 변경은
//   최고관리자만(system.manage, 한도 값 포함). 바꿀 때마다 로그 추적에 전후를 남긴다.
// - 켜려면 모델 이름과 입·출력 단가가 들어 있어야 한다(공식 문서로 확인한 값을 넣는다. 코드에 고정한 값은 없음).
// - 자료는 공개 자료만 넣는다(파트너스 개인정보·주문 데이터 금지). 게시한 자료만 답변 근거로 쓴다.
type Meta = { ip?: string | null; userAgent?: string | null };

export const DOC_TITLE_MAX = 100;
export const DOC_BODY_MAX = 4000;
export const DOC_MAX = 200;
export const PAGE_SIZE = 50;
export const PRICE_MAX = 10_000_000;
export const BUDGET_MAX = 1_000_000;
export const DAILY_MAX = 1000;

export type AdminRejection = "invalid_title" | "invalid_body" | "too_many_docs" | "version_conflict" | "invalid_settings" | "incomplete_settings" | "invalid_cursor";
export const ADMIN_ASSISTANT_MESSAGES: Record<AdminRejection, string> = {
  invalid_title: `제목을 ${DOC_TITLE_MAX}자 안에서 입력해 주십시오`,
  invalid_body: `내용을 ${DOC_BODY_MAX}자 안에서 입력해 주십시오`,
  too_many_docs: `자료는 ${DOC_MAX}건까지 등록할 수 있습니다`,
  version_conflict: "다른 곳에서 먼저 고쳤습니다. 새로고침한 뒤 다시 시도해 주십시오",
  invalid_settings: "입력한 값을 확인해 주십시오",
  incomplete_settings: "모델 이름과 입력·출력 단가를 입력한 뒤 켜 주십시오",
  invalid_cursor: "목록을 다시 불러와 주십시오",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const writeDoc = (a: AdminSessionContext) => {
  if (!adminCan(a.admin.role, "support.manage")) throw forbidden();
};
const audit = (db: Prisma.TransactionClient, a: AdminSessionContext, m: Meta, action: string, target: string, targetId: string, before: unknown, after: unknown) =>
  writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId: a.admin.id, action, targetType: target, targetId, before, after, ip: m.ip, userAgent: m.userAgent });

// ───────── 답변 자료 ─────────

const docView = (r: AssistantDoc) => ({ id: r.id, title: r.title, body: r.body, published: r.published, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt });
const docAudit = (r: AssistantDoc) => ({ title: r.title, published: r.published, deleted: !!r.deletedAt, bodyLength: r.body.length });

export async function listAssistantDocs(db: PrismaClient) {
  const rows = await db.assistantDoc.findMany({ where: { deletedAt: null }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: DOC_MAX });
  return { items: rows.map(docView) };
}

function parseDoc(raw: unknown) {
  const b = obj(raw);
  const title = cleanText(b.title, DOC_TITLE_MAX, "memo");
  if (!title) return { ok: false as const, reason: "invalid_title" as const };
  const body = cleanText(b.body, DOC_BODY_MAX, "multiline");
  if (!body) return { ok: false as const, reason: "invalid_body" as const };
  return { ok: true as const, v: { title, body, published: b.published === true } };
}

export async function createAssistantDoc(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: Meta = {}) {
  writeDoc(admin);
  const p = parseDoc(raw);
  if (!p.ok) return p;
  return db.$transaction(async (tx) => {
    if ((await tx.assistantDoc.count({ where: { deletedAt: null } })) >= DOC_MAX) return { ok: false as const, reason: "too_many_docs" as const };
    const row = await tx.assistantDoc.create({ data: { ...p.v, createdByAdminId: admin.admin.id, updatedByAdminId: admin.admin.id } });
    await audit(tx, admin, meta, "assistant.doc.create", "AssistantDoc", row.id, undefined, docAudit(row));
    return { ok: true as const, doc: docView(row) };
  });
}

export async function updateAssistantDoc(db: PrismaClient, admin: AdminSessionContext, id: string, raw: unknown, meta: Meta = {}) {
  writeDoc(admin);
  if (!isUuid(id)) throw notFound();
  const p = parseDoc(raw);
  if (!p.ok) return p;
  const expected = obj(raw).expectedVersion;
  return db.$transaction(async (tx) => {
    const [before] = await tx.$queryRaw<AssistantDoc[]>`SELECT * FROM "AssistantDoc" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!before) throw notFound();
    if (expected !== before.version) return { ok: false as const, reason: "version_conflict" as const, currentVersion: before.version };
    const row = await tx.assistantDoc.update({ where: { id }, data: { ...p.v, version: { increment: 1 }, updatedByAdminId: admin.admin.id } });
    await audit(tx, admin, meta, "assistant.doc.update", "AssistantDoc", id, docAudit(before), docAudit(row));
    return { ok: true as const, doc: docView(row) };
  });
}

export async function deleteAssistantDoc(db: PrismaClient, admin: AdminSessionContext, id: string, expectedVersion: unknown, meta: Meta = {}) {
  writeDoc(admin);
  if (!isUuid(id)) throw notFound();
  return db.$transaction(async (tx) => {
    const [before] = await tx.$queryRaw<AssistantDoc[]>`SELECT * FROM "AssistantDoc" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!before) throw notFound();
    if (expectedVersion !== before.version) return { ok: false as const, reason: "version_conflict" as const, currentVersion: before.version };
    const row = await tx.assistantDoc.update({ where: { id }, data: { deletedAt: new Date(), published: false, version: { increment: 1 }, updatedByAdminId: admin.admin.id } });
    await audit(tx, admin, meta, "assistant.doc.delete", "AssistantDoc", id, docAudit(before), docAudit(row));
    return { ok: true as const };
  });
}

// ───────── 질문 기록 ─────────

// 최근 순 커서. unanswered=1이면 답하지 못한 질문(NO_ANSWER)만. 오류(ERROR)는 과금 없는 실패라 목록에서 뺀다.
export async function listAssistantQuestions(db: PrismaClient, q: { cursor?: string | null; unanswered?: boolean }) {
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cursor) return { ok: false as const, reason: "invalid_cursor" as const };
  const where: Prisma.AssistantLedgerWhereInput = {
    status: q.unanswered ? "NO_ANSWER" : { in: ["OK", "NO_ANSWER"] },
    ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
  };
  const rows = await db.assistantLedger.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PAGE_SIZE + 1 });
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    ok: true as const,
    items: page.map((r) => ({ id: r.id, question: r.question, answer: r.answer, answered: r.status === "OK", createdAt: r.createdAt })),
    nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

// ───────── 설정 ─────────

export async function getAssistantSettings(db: PrismaClient) {
  const s = await loadSettings(db);
  const period = await kstPeriod(db);
  const [usage, calls] = await Promise.all([
    db.assistantMonthUsage.findUnique({ where: { month: period.month } }),
    db.assistantLedger.groupBy({ by: ["status"], where: { month: period.month }, _count: { _all: true } }),
  ]);
  const key = !!assistantApiKey();
  const row = await db.assistantSetting.findUnique({ where: { id: 1 }, select: { version: true } });
  return {
    settings: s,
    version: row?.version ?? 0,
    keyConfigured: key,
    available: isAvailable(s, key ? "set" : null),
    month: period.month,
    usedMilliWon: usage?.usedMilliWon ?? 0,
    calls: Object.fromEntries(calls.map((c) => [c.status, c._count._all])),
  };
}

// 변경은 최고관리자만. 빼고 보낸 값은 유지. 켜기(enabled: true)는 모델·단가가 있어야 한다. expectedVersion이 다르면 409.
export async function updateAssistantSettings(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
  const b = obj(raw);
  const bad = () => ({ ok: false as const, reason: "invalid_settings" as const });
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return bad();
  if (b.model !== undefined && (typeof b.model !== "string" || !MODEL_NAME.test(b.model))) return bad();
  if (b.inputWonPerMTok !== undefined && !isInt(b.inputWonPerMTok, 1, PRICE_MAX)) return bad();
  if (b.outputWonPerMTok !== undefined && !isInt(b.outputWonPerMTok, 1, PRICE_MAX)) return bad();
  if (b.monthlyBudgetWon !== undefined && !isInt(b.monthlyBudgetWon, 0, BUDGET_MAX)) return bad();
  if (b.sellerDailyLimit !== undefined && !isInt(b.sellerDailyLimit, 0, DAILY_MAX)) return bad();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "AssistantSetting" ("id") VALUES (1) ON CONFLICT DO NOTHING`;
    const [cur] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "AssistantSetting" WHERE "id" = 1 FOR UPDATE`;
    if (b.expectedVersion !== undefined && b.expectedVersion !== cur.version) return { ok: false as const, reason: "version_conflict" as const, currentVersion: cur.version };
    const before = await loadSettings(tx);
    const next = {
      enabled: (b.enabled as boolean | undefined) ?? before.enabled,
      model: (b.model as string | undefined) ?? before.model,
      inputWonPerMTok: (b.inputWonPerMTok as number | undefined) ?? before.inputWonPerMTok,
      outputWonPerMTok: (b.outputWonPerMTok as number | undefined) ?? before.outputWonPerMTok,
      monthlyBudgetWon: (b.monthlyBudgetWon as number | undefined) ?? before.monthlyBudgetWon,
      sellerDailyLimit: (b.sellerDailyLimit as number | undefined) ?? before.sellerDailyLimit,
    };
    if (next.enabled && !settingsComplete(next)) return { ok: false as const, reason: "incomplete_settings" as const };
    await tx.assistantSetting.update({ where: { id: 1 }, data: { ...next, version: { increment: 1 }, updatedByAdminId: admin.admin.id } });
    await audit(tx, admin, meta, "assistant.settings.update", "AssistantSetting", "1", before, next);
    return { ok: true as const };
  });
}
