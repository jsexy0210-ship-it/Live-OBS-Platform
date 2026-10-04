import { NextResponse } from "next/server";
import { listRecoveryAccounts } from "../../../../../lib/server/auth/accountRecovery";
import { RECOVERY_IDV_COOKIE, parseAccountType } from "../../../../../lib/server/auth/recoveryFlow";
import { prisma } from "../../../../../lib/server/db";
import { isString, mutation, readCookie, readJson, requestMeta } from "../../../../../lib/server/http/route";
import { identityProvider, identityUnavailable } from "../../../../../lib/server/identity/registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };

// 아이디 찾기 결과(AU-011): 본문 { verificationId, accountType: owner|staff }. 시작한 브라우저(쿠키)만.
// 200 { accounts: [{ accountId, shopName, shopSlug, email }] } — 대표자는 쇼핑몰 대표자 CI, 직원은 연결한 CI가 본인확인 결과와 같은 계정.
// 맞는 계정이 없으면 빈 목록(직원 미연결 포함, 화면은 「대표자에게 물어봐 주세요」). 본인확인 전이면 409 pending, 쓸 수 없는 본인확인이면 400 recovery_not_allowed.
export const POST = mutation(async (req: Request) => {
  const provider = identityProvider();
  if (!provider) return identityUnavailable("formal");
  const body = await readJson<{ verificationId: unknown; accountType: unknown }>(req);
  const accountType = parseAccountType(body.accountType);
  if (!accountType) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  if (!isString(body.verificationId) || !UUID.test(body.verificationId)) return NextResponse.json({ error: "recovery_not_allowed" }, { status: 400, headers: NO_STORE });
  const r = await listRecoveryAccounts(prisma, provider, { verificationId: body.verificationId, ownerToken: readCookie(req, RECOVERY_IDV_COOKIE), accountType }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "pending" ? 409 : 400, headers: NO_STORE });
  return NextResponse.json({ accounts: r.accounts }, { headers: NO_STORE });
});
