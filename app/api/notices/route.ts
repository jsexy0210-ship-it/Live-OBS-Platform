import { NextResponse } from "next/server";
import { prisma } from "../../../lib/server/db";
import { errorResponse } from "../../../lib/server/http/route";
import { listNotices, listPublicNoticesPage, parsePublicNoticePagination } from "../../../lib/server/platform-notices/service";

export const dynamic = "force-dynamic";

// 공개 플랫폼 공지 목록(PF-005, 로그인 없음). 번호 페이지와 기존 커서 계약을 함께 지원한다.
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const cursor = params.get("cursor");
    const pageMode = params.has("page") || params.has("pageSize") || (cursor === null && params.has("category"));
    if (pageMode) {
      if (cursor !== null) return NextResponse.json({ error: "invalid_pagination" }, { status: 400 });
      const pagination = parsePublicNoticePagination(params.get("page"), params.get("pageSize"));
      if (!pagination.ok) return NextResponse.json({ error: pagination.reason }, { status: 400 });
      return NextResponse.json(await listPublicNoticesPage(prisma, pagination.page, pagination.pageSize, params.get("category")));
    }
    const r = await listNotices(prisma, "public", { cursor, category: params.get("category") });
    if (!r.ok) return NextResponse.json({ error: r.reason, message: "목록을 다시 불러와 주세요" }, { status: 400 });
    return NextResponse.json({ pinned: r.pinned, items: r.items, nextCursor: r.nextCursor });
  } catch (e) {
    return errorResponse(e);
  }
}
