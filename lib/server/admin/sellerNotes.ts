import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { decodeCursor, encodeCursor } from "../orders/read";
import { cleanText } from "../text/clean";

// 마스터 관리자 파트너스 메모(MA-012 탭). 마스터 관리자만 읽고 쓰며(파트너스 세션은 이 경로에 못 들어온다), 파트너스에는 보이지 않는다.
// 읽기: 모든 마스터 역할(platform.read, 조회 전용 포함). 추가: 조회 전용을 뺀 역할(최고관리자·운영·CS, 기존 권한 표를 바꾸지 않고
// seller.moderate 또는 support.manage 가진 역할). 삭제: 쓴 사람 본인과 최고관리자만.
// 로그 추적(admin.seller.note.create·delete)에는 본문 없이 글자 수만 남긴다(내부 메모에 개인정보가 섞일 수 있음).
export const SELLER_NOTE_MAX = 1000;
export const SELLER_NOTE_PAGE_DEFAULT = 50;
export const SELLER_NOTE_PAGE_MAX = 200;
type Meta = { ip?: string | null; userAgent?: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canRead = (a: AdminSessionContext) => adminCan(a.admin.role, "platform.read");
const canWrite = (a: AdminSessionContext) => adminCan(a.admin.role, "seller.moderate") || adminCan(a.admin.role, "support.manage");
const canDelete = (a: AdminSessionContext, authorId: string) => canWrite(a) && (a.admin.role === "SUPER_ADMIN" || a.admin.id === authorId);

const view = (n: { id: string; body: string; authorId: string; authorName: string; createdAt: Date }, admin: AdminSessionContext) => ({
  id: n.id,
  body: n.body,
  author: { id: n.authorId, name: n.authorName },
  createdAt: n.createdAt,
  canDelete: canDelete(admin, n.authorId),
});

// 최신순 (createdAt, id) 커서 페이지. 없는 파트너스면 { ok: false, reason: "not_found" }, 잘못된 값이면 "bad_request".
export async function listSellerNotes(db: PrismaClient, admin: AdminSessionContext, sellerId: string, q: { cursor?: string | null; limit?: string | null }) {
  if (!canRead(admin)) throw forbidden();
  const limit = q.limit == null || q.limit === "" ? SELLER_NOTE_PAGE_DEFAULT : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const, reason: "bad_request" as const };
  const take = Math.min(limit, SELLER_NOTE_PAGE_MAX);
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cursor) return { ok: false as const, reason: "bad_request" as const };
  if (!UUID_RE.test(sellerId) || !(await db.seller.findUnique({ where: { id: sellerId }, select: { id: true } }))) return { ok: false as const, reason: "not_found" as const };
  const rows = await db.sellerAdminNote.findMany({
    where: { sellerId, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
  });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return { ok: true as const, notes: page.map((n) => view(n, admin)), nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null };
}

export async function addSellerNote(db: PrismaClient, admin: AdminSessionContext, sellerId: string, raw: unknown, meta: Meta = {}) {
  if (!canWrite(admin)) throw forbidden();
  const body = cleanText(raw, SELLER_NOTE_MAX, "multiline");
  if (body === null) return { ok: false as const, reason: "invalid_note" as const };
  if (!UUID_RE.test(sellerId)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    if (!(await tx.seller.findUnique({ where: { id: sellerId }, select: { id: true } }))) return { ok: false as const, reason: "not_found" as const };
    const n = await tx.sellerAdminNote.create({ data: { sellerId, body, authorId: admin.admin.id, authorName: admin.admin.name } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      sellerId,
      action: "admin.seller.note.create",
      targetType: "Seller",
      targetId: sellerId,
      after: { noteId: n.id, length: [...body].length },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, note: view(n, admin) };
  });
}

// 다른 파트너스의 메모 id는 없는 메모(404)로 다룬다. 쓴 사람이 아니고 최고관리자도 아니면 403.
export async function deleteSellerNote(db: PrismaClient, admin: AdminSessionContext, sellerId: string, noteId: string, meta: Meta = {}) {
  if (!canWrite(admin)) throw forbidden();
  if (!UUID_RE.test(sellerId) || !UUID_RE.test(noteId)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const n = await tx.sellerAdminNote.findFirst({ where: { id: noteId, sellerId } });
    if (!n) return { ok: false as const, reason: "not_found" as const };
    if (!canDelete(admin, n.authorId)) throw forbidden();
    await tx.sellerAdminNote.delete({ where: { id: n.id } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      sellerId,
      action: "admin.seller.note.delete",
      targetType: "Seller",
      targetId: sellerId,
      before: { noteId: n.id, authorId: n.authorId, length: [...n.body].length },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const };
  });
}
