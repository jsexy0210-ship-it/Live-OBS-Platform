import { NextResponse } from "next/server";
import { cancelSupplement, requestSupplement } from "../../../../../../lib/server/admin/signupApplications";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

const status = (reason: string) => (reason === "not_found" ? 404 : reason === "message_required" ? 400 : 409);

// 보완 요청(MA-013). 본문 { message: 1~200자 }. 승인 대기 신청만, 이미 요청했으면 409 already_requested. 7일 안에 보완하지 않으면 자동 반려. → { ok, requestedAt, dueAt }
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const body = await readJson<{ message: unknown }>(req);
  const r = await requestSupplement(prisma, admin, (await params).sellerId, body?.message, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: status(r.reason) });
  return NextResponse.json(r);
});

// 보완 요청 취소(요청 중인 신청만, 없으면 409 not_requested)
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const r = await cancelSupplement(prisma, admin, (await params).sellerId, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: status(r.reason) });
  return NextResponse.json(r);
});
