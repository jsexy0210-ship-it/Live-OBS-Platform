import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../../lib/server/http/route";
import { parseKind, publicLegal } from "../../../../../../lib/server/shop-legal/service";

// 구매자 쇼핑몰 이용약관·개인정보처리방침(kind = terms | privacy). 로그인 없이, 준비 중·일시 정지에도 열람. 비활성 쇼핑몰·다른 종류는 404.
// 게시 전 { published: false, kind }, 게시 후 { published: true, kind, body(텍스트), effectiveOn(YYYY-MM-DD), version }.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; kind: string }> }) {
  try {
    const { slug, kind } = await params;
    const k = parseKind(kind);
    const r = k ? await publicLegal(prisma, slug, k) : null;
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return noStore(NextResponse.json(r));
  } catch (e) {
    return errorResponse(e);
  }
}
