import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { INTEGRATION_MESSAGES, INTEGRATION_STATUS, readIntegrationProfile, saveIntegrationProfile } from "../../../../lib/server/sellers/integrationProfile";

// 쇼핑몰 통합 전환용 사업자·정산 정보(SA-005, 구독 관리 권한). 체험·첫 결제 전·이용 정지 중에도 열린다(플랜 변경과 같음).
// GET → { business: { companyName, representativeName, businessNumber, mailOrderNumber|null, businessAddress }, settlement: { bankName, accountNumberMasked, accountHolder } | null,
//        complete, businessCheck: { status: "ok"|"unchecked"|"not_active", checkedAt } }. 저장한 적 없으면 신청 때 받은 사업자 정보로 미리 채우고 나머지는 빈 문자열.
// PUT { companyName, representativeName, businessNumber, mailOrderNumber?, businessAddress, bankName, accountNumber, accountHolder } → { ok: true }(필수 6개:
// 상호·대표자명·사업자번호·사업장 주소·은행·계좌번호·예금주). 예금주는 상호 또는 대표자명과 같아야 한다(400 holder_mismatch). 계좌번호는 암호화해 저장하고 응답엔 마스킹만 나간다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return noStore(NextResponse.json(await readIntegrationProfile(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
  const r = await saveIntegrationProfile(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: INTEGRATION_MESSAGES[r.reason] }, { status: INTEGRATION_STATUS[r.reason] }));
  return noStore(NextResponse.json({ ok: true }));
});
