import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { deletePlatformNotice, getAdminNotice, PLATFORM_NOTICE_MESSAGES, updatePlatformNotice } from "../../../../../lib/server/platform-notices/service";

type Ctx = { params: Promise<{ noticeId: string }> };
const conflict = (currentVersion: number) =>
  NextResponse.json({ error: "version_conflict", message: PLATFORM_NOTICE_MESSAGES.version_conflict, currentVersion }, { status: 409 });

// 공지 한 건(MA-054 불러오기). 모든 역할. 지운 공지·없는 id는 404.
export async function GET(req: Request, { params }: Ctx) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return NextResponse.json({ notice: await getAdminNotice(prisma, admin, (await params).noticeId) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 고치기(전체 값). 최고관리자·CS. 본문 { title, body, category, audience, isPinned?, publish?, expectedVersion }.
// publish: true면 게시(이미 게시된 공지는 처음 게시일 유지), 빼거나 false면 임시 저장으로. version이 다르면 409 version_conflict + currentVersion.
export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.manage");
  const r = await updatePlatformNotice(prisma, admin, (await params).noticeId, await readJson(req), requestMeta(req));
  if (!r.ok) return "currentVersion" in r ? conflict(r.currentVersion as number) : NextResponse.json({ error: r.reason, message: PLATFORM_NOTICE_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ notice: r.notice });
});

// 지우기. 최고관리자·CS. ?expectedVersion=. 지운 공지는 어디에도 보이지 않는다(로그 추적에 남음).
export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.manage");
  const v = new URL(req.url).searchParams.get("expectedVersion");
  const r = await deletePlatformNotice(prisma, admin, (await params).noticeId, v !== null && /^\d+$/.test(v) ? Number(v) : null, requestMeta(req));
  if (!r.ok) return conflict(r.currentVersion);
  return NextResponse.json({ ok: true });
});
