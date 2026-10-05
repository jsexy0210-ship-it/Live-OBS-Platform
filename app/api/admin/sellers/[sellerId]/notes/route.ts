import { NextResponse } from "next/server";
import { addSellerNote, listSellerNotes } from "../../../../../../lib/server/admin/sellerNotes";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

const NOTE_ERROR = {
  invalid_note: "메모는 1~1,000자로 적어 주십시오",
  bad_request: "조회 조건을 다시 확인해 주십시오",
} as const;

// 파트너스 관리자 메모 목록(MA-012). 마스터 관리자 전 역할(조회 전용 포함)이 읽고, 파트너스에는 보이지 않는다. 쿼리: cursor, limit(기본 50, 최대 200). 최신순.
// → { notes: [{ id, body, author: { id, name }, createdAt, canDelete }], nextCursor }. 없는 파트너스는 404.
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await listSellerNotes(prisma, admin, (await params).sellerId, { cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return r.reason === "not_found" ? NextResponse.json({ error: "not_found" }, { status: 404 }) : NextResponse.json({ error: r.reason, message: NOTE_ERROR[r.reason] }, { status: 400 });
    return noStore(NextResponse.json({ notes: r.notes, nextCursor: r.nextCursor }));
  } catch (e) {
    return errorResponse(e);
  }
}

// 메모 추가. 본문 { body }(1~1,000자, 줄바꿈 허용). 최고관리자·운영·CS만(조회 전용 403). 201 { note }, 글자가 잘못되면 400 invalid_note, 없는 파트너스 404. 로그 추적 admin.seller.note.create(글자 수만).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
  const b = await readJson<{ body: unknown }>(req);
  const r = await addSellerNote(prisma, admin, (await params).sellerId, b.body, requestMeta(req));
  if (!r.ok) return r.reason === "not_found" ? NextResponse.json({ error: "not_found" }, { status: 404 }) : NextResponse.json({ error: r.reason, message: NOTE_ERROR[r.reason] }, { status: 400 });
  return noStore(NextResponse.json({ note: r.note }, { status: 201 }));
});
