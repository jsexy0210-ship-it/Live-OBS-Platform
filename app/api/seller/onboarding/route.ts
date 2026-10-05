import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";
import { getOnboarding, updateOnboarding } from "../../../../lib/server/onboarding/service";

// 시작하기(SA-003)·온보딩(SA-004) 체크리스트. 파트너스 계정 누구나 본다(첫 결제 전·잠김·이용 정지 중에도, 그 단계를 이어 가려면 필요).
// → { track: INTEGRATED|OVERLAY_ONLY|null, planCode, trialEndsAt(오버레이 전용만), steps: [{ key, done, href }], doneCount, total, currentStep(첫 미완료 단계 | null), completed, dismissed }
// 단계 key: subscription·shop_info·products·order_policy·overlay·overlay_url(쇼핑몰 통합) / external_shop·overlay·overlay_url(오버레이 전용)
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return noStore(NextResponse.json(await getOnboarding(prisma, ctx)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 본문 { action: "overlay_url_copied"(주소 복사 눌렀음) | "dismiss"(닫기) | "reopen"(다시 열기) }. 대표자·쇼핑몰 설정(SHOP_SETTINGS) 직원만, 마스터 대리 조회는 403.
// 성공 { ok: true }, 잘못된 action 400 invalid_action
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const body = await readJson<{ action: unknown }>(req);
  const r = await updateOnboarding(prisma, ctx, body.action);
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  return NextResponse.json({ ok: true });
});
