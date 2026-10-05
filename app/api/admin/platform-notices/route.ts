import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { createPlatformNotice, listAdminNotices, PLATFORM_NOTICE_MESSAGES } from "../../../../lib/server/platform-notices/service";

// 플랫폼 공지 목록(MA-053). 보기는 모든 역할(platform.read). ?status=draft|published(없으면 둘 다)&cursor=
// → { items: [{ id, title, body, category, audience, isPinned, status, publishedAt, channels, version, createdAt, updatedAt }], nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const url = new URL(req.url);
    const r = await listAdminNotices(prisma, admin, { status: url.searchParams.get("status"), cursor: url.searchParams.get("cursor") });
    if (!r.ok) return NextResponse.json({ error: r.reason, message: PLATFORM_NOTICE_MESSAGES[r.reason] }, { status: 400 });
    return NextResponse.json({ items: r.items, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 공지 작성(MA-054). 최고관리자·CS(support.manage). 본문 { title, body, category, audience, isPinned?, publish? }. 201 { notice }
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.manage");
  const r = await createPlatformNotice(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: PLATFORM_NOTICE_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ notice: r.notice }, { status: 201 });
});
