import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { deleteNotice, NOTICE_MESSAGES, updateNotice } from "../../../../../lib/server/shop-notice/service";

// 공지·질문 수정(PUT, 전체 값: title, body, category?, isPinned?, isPublished?; kind 변경 불가)·삭제. 다른 쇼핑몰의 id는 404. 권한은 목록과 같다.
type Ctx = { params: Promise<{ noticeId: string }> };

export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateNotice(prisma, ctx, (await params).noticeId, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: NOTICE_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ notice: r.notice });
});

export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  await deleteNotice(prisma, ctx, (await params).noticeId, requestMeta(req));
  return NextResponse.json({ ok: true });
});
