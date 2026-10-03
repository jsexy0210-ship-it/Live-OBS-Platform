import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { identityProvider } from "../../../../../lib/server/identity/registry";
import { staffLinkStatus } from "../../../../../lib/server/sellers/staffIdentity";

// 로그인한 직원의 본인확인 연결 상태(첫 로그인 안내용, 건너뛸 수 있음). 대표자·마스터 대리 조회는 403.
// { available(본인확인을 쓸 수 있음), phoneRegistered, registeredPhoneLast4(끝 4자리만), linked, relinkRequired(번호 변경으로 연결이 풀림) }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    return NextResponse.json(await staffLinkStatus(prisma, ctx, identityProvider() !== null), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
