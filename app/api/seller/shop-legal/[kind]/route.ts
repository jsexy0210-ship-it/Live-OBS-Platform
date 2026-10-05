import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { parseKind, readSellerLegal, saveSellerLegal, SHOP_LEGAL_MESSAGES } from "../../../../../lib/server/shop-legal/service";

type Ctx = { params: Promise<{ kind: string }> };
const badKind = () => NextResponse.json({ error: "not_found" }, { status: 404 });

// 쇼핑몰 이용약관·개인정보처리방침 입력(kind = terms | privacy). GET → { doc: { kind, body, effectiveOn(YYYY-MM-DD|null), isPublished, version, updatedAt } }.
// 조회는 같은 쇼핑몰 파트너스 계정 누구나, 쓰기는 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 직원만(그 밖 403). 플랜 기능 STORE_OPERATIONS. 저장한 적 없으면 빈 값·version 0.
export async function GET(req: Request, { params }: Ctx) {
  try {
    const kind = parseKind((await params).kind);
    if (!kind) return badKind();
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json({ doc: await readSellerLegal(prisma, ctx, kind) }));
  } catch (e) {
    return errorResponse(e);
  }
}

// 저장. 본문: { body(6만 자, 텍스트), effectiveOn?(YYYY-MM-DD), isPublished?(게시하려면 본문·시행일 필요), expectedVersion }
// version은 본문·시행일이 실제로 바뀐 때만 오른다(같은 내용 재저장·재게시·게시 여부만 바꾼 저장은 그대로). expectedVersion 비교는 그대로.
// 200 { doc } · 400 invalid_body·invalid_date·publish_incomplete · 409 version_conflict(+currentVersion)
export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const kind = parseKind((await params).kind);
  if (!kind) return badKind();
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await saveSellerLegal(prisma, ctx, kind, await readJson(req), requestMeta(req));
  if (r.ok) return noStore(NextResponse.json({ doc: r.doc }));
  const extra = r.reason === "version_conflict" ? { currentVersion: r.currentVersion } : {};
  return noStore(NextResponse.json({ error: r.reason, message: SHOP_LEGAL_MESSAGES[r.reason], ...extra }, { status: r.reason === "version_conflict" ? 409 : 400 }));
});
