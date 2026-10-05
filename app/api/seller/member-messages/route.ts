import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";
import { messageError } from "../../../../lib/server/shop-member-messages/http";
import { createMessage, listMessages } from "../../../../lib/server/shop-member-messages/service";

// 회원 알림 발송(SA-049, MEMBER_POINTS). 실제 발송 채널이 정해지기 전이라 발송 「기록」만 남긴다.
// 목록 + 요약(동의 회원·이번 달 기록·24시간 주문·최근 30일 수신 철회). ?cursor
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listMessages(prisma, ctx, { cursor: new URL(req.url).searchParams.get("cursor") ?? undefined })));
  } catch (e) {
    return errorResponse(e);
  }
}

// 새 발송. body { title, kind: "AD"|"INFO", channel: "ALIMTALK_SMS"|"ALIMTALK"|"MAIL", body, target: { type, gradeIds?|productId?|memberIds? }, sendMode: "NOW"|"SCHEDULE", scheduledAt? }
// 광고성이 시간(08~21시) 밖이면 「지금」은 다음 08:00 예약(rescheduled), 직접 정한 예약은 400 ad_time_window(suggestedAt).
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await createMessage(prisma, ctx, await readJson<Record<string, unknown>>(req));
  if (!r.ok) return messageError(r.reason, "suggestedAt" in r ? { suggestedAt: r.suggestedAt } : {});
  return noStore(NextResponse.json({ message: r.message, rescheduled: r.rescheduled }, { status: 201 }));
});
