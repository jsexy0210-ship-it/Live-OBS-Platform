import { NextResponse } from "next/server";
import { listAdminSubscriptions } from "../../../../lib/server/admin/billing";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

// 마스터 관리자 구독 현황(MA-023). access(trial·paid·charging·grace·expired)·plan·q(쇼핑몰 이름·주소)·cursor·limit. 잘못된 값 400.
// { counts: { trial, paid, charging, grace, expired }, subscriptions: [{ seller, access, plan, trialEndsAt, subscription }], nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await listAdminSubscriptions(prisma, admin, { access: p.get("access"), plan: p.get("plan"), q: p.get("q"), cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ counts: r.counts, subscriptions: r.subscriptions, nextCursor: r.nextCursor });
  } catch (e) {
    return errorResponse(e);
  }
}
