import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { NOTICE_MESSAGES, reorderFaqs } from "../../../../../lib/server/shop-notice/service";

// 자주 묻는 질문 순서 바꾸기. 본문 { ids }에 지금 있는 질문을 빠짐없이 새 순서로 담는다(다르면 409 order_conflict). 응답 { faqs }.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await reorderFaqs(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: NOTICE_MESSAGES[r.reason] }, { status: 409 });
  return NextResponse.json({ faqs: r.faqs });
});
