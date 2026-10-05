import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";
import { gradeError } from "../../../../lib/server/shop-member-grades/http";
import { addMemberGrade, getMemberGrades, saveMemberGrades } from "../../../../lib/server/shop-member-grades/service";

// 회원 등급(SA-044). 조회는 MEMBER_POINTS(대표자·회원 · 적립금 권한 직원): 등급별 이름 · 승급 기준액 · 회원 수 · 적립률, 자동 재산정 설정, 지난 재산정, 최근 변경, 고정한 회원.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await getMemberGrades(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

// 저장. body { autoEnabled?: boolean, windowMonths?: 0|3|6|12(0=누적), cadence?: MONTHLY|WEEKLY|DAILY, demotion?: STEP|IMMEDIATE|NONE, grades?: [{ id, displayName, minAmount }] }.
// 자동 재산정을 켜면 기준액이 등급 순서대로 커야 한다(400 invalid_thresholds). 새로 켜거나 주기를 바꾸면 그 주기는 이미 돈 것으로 기록한다(저장하자마자 도는 일 방지).
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await saveMemberGrades(prisma, ctx, await readJson<{ autoEnabled: unknown; windowMonths: unknown; cadence: unknown; demotion: unknown; grades: unknown }>(req));
  return r.ok ? noStore(NextResponse.json({ ok: true })) : gradeError(r.reason);
});

// 등급 추가(가장 높은 등급 위, 10개까지). body { displayName, minAmount }
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await addMemberGrade(prisma, ctx, await readJson<{ displayName: unknown; minAmount: unknown }>(req));
  return r.ok ? noStore(NextResponse.json({ id: r.id }, { status: 201 })) : gradeError(r.reason);
});
