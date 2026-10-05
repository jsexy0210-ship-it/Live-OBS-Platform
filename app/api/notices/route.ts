import { NextResponse } from "next/server";
import { prisma } from "../../../lib/server/db";
import { errorResponse } from "../../../lib/server/http/route";
import { listNotices } from "../../../lib/server/platform-notices/service";

export const dynamic = "force-dynamic";

// 공개 플랫폼 공지 목록(PF-005, 로그인 없음). 대상이 공개·전체인 게시 공지만. ?cursor= → { pinned(첫 쪽만), items, nextCursor }
export async function GET(req: Request) {
  try {
    const r = await listNotices(prisma, "public", { cursor: new URL(req.url).searchParams.get("cursor") });
    if (!r.ok) return NextResponse.json({ error: r.reason, message: "목록을 다시 불러와 주세요" }, { status: 400 });
    return NextResponse.json({ pinned: r.pinned, items: r.items, nextCursor: r.nextCursor });
  } catch (e) {
    return errorResponse(e);
  }
}
