import { NextResponse } from "next/server";
import { addSellerNotesBulk } from "../../../../../../lib/server/admin/sellerNotes";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

const MESSAGE = {
  invalid_sellers: "메모를 남길 파트너스를 1~50곳 골라 주십시오",
  invalid_note: "메모는 1~1,000자로 적어 주십시오",
} as const;

// 선택 메모 일괄(MA-012). 본문 { sellerIds: uuid[](1~50, 중복은 한 번만), body(1~1,000자, 줄바꿈 허용) }. 권한은 seller.moderate(최고관리자·운영, CS·조회 전용 403).
// 200 { created, results: [{ sellerId, ok, error?: "not_found" }] }(파트너스마다 따로 처리, 로그 추적 admin.seller.note.create 한 건씩) · 400 invalid_sellers·invalid_note
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
  const b = await readJson<{ sellerIds?: unknown; body?: unknown }>(req);
  const r = await addSellerNotesBulk(prisma, admin, b.sellerIds, b.body, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: MESSAGE[r.reason] }, { status: 400 });
  return NextResponse.json({ created: r.created, results: r.results });
});
