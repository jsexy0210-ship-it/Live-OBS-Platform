import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { getSellerMail, updateSellerMailPolicy } from "../../../../../lib/server/mail/settings";

// 메일 제공량·이번 달 사용 현황과 초과 발송 설정(대표자 전용). 체험하기가 끝나도·이용 정지 중에도 볼 수 있다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return NextResponse.json(await getSellerMail(prisma, ctx), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 본문 { overageAllowed?: boolean, overageMonthlyCap?: 0~100000 }. 빼고 보내면 지금 값 유지.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
  const body = await readJson<{ overageAllowed?: unknown; overageMonthlyCap?: unknown }>(req);
  const r = await updateSellerMailPolicy(prisma, ctx, { overageAllowed: body.overageAllowed, overageMonthlyCap: body.overageMonthlyCap });
  if (!r.ok) return NextResponse.json({ error: "invalid_mail_policy", message: "초과 발송 허용 여부와 월 초과 상한(0~100,000통)을 확인해 주십시오" }, { status: 400 });
  return NextResponse.json(r.mail);
});
