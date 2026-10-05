import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { messageError } from "../../../../../lib/server/shop-member-messages/http";
import { previewMessage } from "../../../../../lib/server/shop-member-messages/service";

// 보내기 전 미리보기(MEMBER_POINTS 조회, 아무것도 저장하지 않는다). 새 발송과 같은 본문. 대상 수(전체·동의·하루 2건 한도로 뺀 수·최종), 보내는 시각, 최종 문구.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await previewMessage(prisma, ctx, await readJson<Record<string, unknown>>(req));
  if (!r.ok) return messageError(r.reason, "suggestedAt" in r ? { suggestedAt: r.suggestedAt } : {});
  const { ok: _ok, ...rest } = r;
  return noStore(NextResponse.json(rest));
});
