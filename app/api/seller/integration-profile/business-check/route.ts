import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { businessStatusProvider } from "../../../../../lib/server/sellers/businessCheck";
import { INTEGRATION_MESSAGES, INTEGRATION_STATUS, checkBusiness } from "../../../../../lib/server/sellers/integrationProfile";

// 로그인한 파트너스의 사업자 상태 조회(SA-005 「조회」, 구독 관리 권한). 본문 { businessNumber, representativeName, openedOn? }.
// 국세청 진위확인은 개업일자가 필요하다: 없으면 신청 때 받은 개업일자를 쓰고, 그것도 없으면 400 opened_on_required(화면이 개업일자 칸을 보여 준다).
// 성공 → { status: "ACTIVE"|"SUSPENDED"|"CLOSED"|"NOT_FOUND", valid }(valid=false는 사업자번호·대표자명·개업일자가 국세청 등록과 다름).
// 결과는 24시간 동안 상위 변경 게이트가 인정한다. 쇼핑몰당 하루 10번(429 daily_limit_exceeded, 조회 비용은 마스터 관리자 부담), 조회 실패 502 lookup_failed.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
  const r = await checkBusiness(prisma, businessStatusProvider(), ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: INTEGRATION_MESSAGES[r.reason] }, { status: INTEGRATION_STATUS[r.reason] }));
  return noStore(NextResponse.json({ status: r.status, valid: r.valid }));
});
