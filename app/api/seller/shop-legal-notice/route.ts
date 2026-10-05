import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { NOTICE_MESSAGES, readSellerNotice, saveSellerNotice } from "../../../../lib/server/shop-legal/notice";

// 쇼핑몰 바닥글 법정 표시 입력(SA-062 사업자 정보·고지). GET → { notice: { address, csPhone, csEmail, csHours, escrowKind(none|escrow|insurance), escrowProvider, escrowUrl, minorNotice, version },
// business: { companyName, representativeName, businessNumber, mailOrderNumber }(입점 신청 때 받은 검증 값, 읽기 전용) }.
// 조회는 같은 쇼핑몰 파트너스 계정 누구나, 쓰기는 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 직원만(그 밖 403). 플랜 기능 STORE_OPERATIONS. 저장한 적 없으면 빈 값·version 0.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await readSellerNotice(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

// 저장. 본문: { address?(200자), csPhone?(숫자·하이픈·괄호), csEmail?, csHours?(100자), escrowKind?(none|escrow|insurance, 가입했으면 escrowProvider 필수), escrowProvider?(60자),
// escrowUrl?(https), minorNotice?(1000자), expectedVersion }. 200 { notice, business } · 400 invalid_* · 409 version_conflict(+currentVersion)
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await saveSellerNotice(prisma, ctx, await readJson(req), requestMeta(req));
  if (r.ok) return noStore(NextResponse.json({ notice: r.notice, business: r.business }));
  const extra = r.reason === "version_conflict" ? { currentVersion: r.currentVersion } : {};
  return noStore(NextResponse.json({ error: r.reason, message: NOTICE_MESSAGES[r.reason], ...extra }, { status: r.reason === "version_conflict" ? 409 : 400 }));
});
