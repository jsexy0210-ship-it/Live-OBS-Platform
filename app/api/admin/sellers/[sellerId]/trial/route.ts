import { NextResponse } from "next/server";
import { DIRECT_CREATE_MESSAGES, setTrialEnd } from "../../../../../../lib/server/sellers/directCreate";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 체험 종료일 바꾸기(최고관리자만, 상한 없음). 본문 { trialEndsAt(ISO, 지금보다 뒤), reason(1~200자) }. 200 { trialEndsAt, previous } · 400 invalid_trial·invalid_reason·invalid_target·service_ended.
// 로그 추적 admin.seller.trial_set에 전후 날짜와 사유를 남긴다. 이미 자동 해지된 쇼핑몰은 바꿀 수 없다.
export const PATCH = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const b = await readJson<{ trialEndsAt?: unknown; reason?: unknown }>(req);
  const r = await setTrialEnd(prisma, admin, (await params).sellerId, { trialEndsAt: b.trialEndsAt, reason: b.reason }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: DIRECT_CREATE_MESSAGES[r.reason] }, { status: 400, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ trialEndsAt: r.trialEndsAt, previous: r.previous }, { headers: { "cache-control": "no-store" } });
});
