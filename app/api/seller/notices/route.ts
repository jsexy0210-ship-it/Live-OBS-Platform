import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { createNotice, listSellerNotices, NOTICE_MESSAGES, parseKind } from "../../../../lib/server/shop-notice/service";

// 쇼핑몰 공지·자주 묻는 질문(SA-066). GET ?kind=notice|faq → { items: [{ id, kind, title, body, category, isPinned, isPublished, sortOrder, createdAt, updatedAt }] }.
// 조회는 같은 쇼핑몰 파트너스 계정 누구나, 쓰기는 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 직원만(그 밖 403). 플랜 기능 STORE_OPERATIONS.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const kind = parseKind(new URL(req.url).searchParams.get("kind"));
    if (!kind) return NextResponse.json({ error: "invalid_kind", message: NOTICE_MESSAGES.invalid_kind }, { status: 400 });
    return noStore(NextResponse.json({ items: await listSellerNotices(prisma, ctx, kind) }));
  } catch (e) {
    return errorResponse(e);
  }
}

// 추가. 본문: { kind: "notice"|"faq", title(60자), body(5000자), category?(선택, 20자), isPinned?(공지만, 홈 띠 고정 1개), isPublished?(기본 true) }
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await createNotice(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: NOTICE_MESSAGES[r.reason] }, { status: r.reason === "too_many" ? 409 : 400 });
  return NextResponse.json({ notice: r.notice }, { status: 201 });
});
