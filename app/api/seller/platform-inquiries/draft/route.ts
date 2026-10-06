import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { deleteMyDraft, getMyDraft, inquiryStatus, PLATFORM_INQUIRY_MESSAGES, saveMyDraft } from "../../../../../lib/server/platform-inquiries/service";

// 문의 작성 임시 저장(SA-114 「임시 저장」). 계정(직원 포함)당 하나. 잠김·정지 중에도 쓴다.
// GET → { draft: { category, title, body, urgent, relatedOrderId, relatedBroadcastId, includeDiagnostics, updatedAt } | null }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return noStore(NextResponse.json({ draft: await getMyDraft(prisma, ctx) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// PUT 전체 교체. 본문 { category?, title?, body?, urgent?, relatedOrderId?, relatedBroadcastId?, includeDiagnostics? }(비어 있어도 됨, 모두 비면 임시 저장을 지움 → { draft: null }).
// 400 invalid_category|title|body|urgent|related|diagnostics. 문의를 보낸 뒤에는 화면이 DELETE로 지운다.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const r = await saveMyDraft(prisma, ctx, await readJson(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  return noStore(NextResponse.json({ draft: r.draft }));
});

// DELETE 임시 저장 지우기(없어도 성공). → { draft: null }
export const DELETE = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  await deleteMyDraft(prisma, ctx);
  return noStore(NextResponse.json({ draft: null }));
});
