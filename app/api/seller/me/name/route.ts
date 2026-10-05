import { NextResponse } from "next/server";
import { ACCOUNT_MESSAGES, renameSellerUser } from "../../../../../lib/server/auth/account";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 내 이름 바꾸기(SA-120). 파트너스 계정 누구나 본인 것만. 본문 { name }(정규화 뒤 1~50자). 마스터 대리 조회는 403.
// 성공 { ok: true, name }, 잘못된 이름 400 { error: "invalid_name", message }
export const PATCH = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const body = await readJson<{ name: unknown }>(req);
  const r = await renameSellerUser(prisma, ctx, body.name, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: ACCOUNT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ ok: true, name: r.name });
});
