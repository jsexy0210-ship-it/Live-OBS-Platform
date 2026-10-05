import { NextResponse } from "next/server";
import { deleteSellerNote } from "../../../../../../../lib/server/admin/sellerNotes";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";

// 메모 삭제. 쓴 사람 본인과 최고관리자만(그 밖 역할·조회 전용은 403). 없는 메모·다른 파트너스의 메모는 404. 성공 { ok: true }. 로그 추적 admin.seller.note.delete.
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string; noteId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
  const { sellerId, noteId } = await params;
  const r = await deleteSellerNote(prisma, admin, sellerId, noteId, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return noStore(NextResponse.json({ ok: true }));
});
