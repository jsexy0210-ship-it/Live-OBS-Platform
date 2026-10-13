import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { EXPORT_MESSAGES, exportFailureStatus, exportMembersCsv } from "../../../../../../lib/server/shop-bulk-io/exports";

// 회원 내보내기(SA-018, CSV, 대표자만): 본문 { reason: 내보내는 사유(1~100자, 필수), includePii?: boolean(이름·연락처 포함) }. 5,000명까지, 탈퇴 회원 제외.
// 사유는 처리 이력·로그 추적(bulk_io.member_export)에 남고, 개인정보를 넣었으면 customer.pii.view도 남는다. 직원은 403.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await exportMembersCsv(prisma, ctx, await readJson<{ reason: unknown; includePii: unknown }>(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: EXPORT_MESSAGES[r.reason] }, { status: exportFailureStatus(r.reason) }));
  return noStore(new Response(r.value.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename*=UTF-8''%ED%9A%8C%EC%9B%90-%EB%AA%A9%EB%A1%9D.csv", "X-Row-Count": String(r.value.count) } }));
});
