import { NextResponse } from "next/server";
import { GRANT_COOKIE, IDV_COOKIE, RESET_PATH, issueSellerPasswordResetGrant } from "../../../../../lib/server/auth/passwordReset";
import { prisma } from "../../../../../lib/server/db";
import { isString, mutation, readCookie, readJson, requestMeta, setFlowCookie } from "../../../../../lib/server/http/route";
import { identityProvider, identityUnavailable } from "../../../../../lib/server/identity/registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 휴대폰 본인확인(confirm) 뒤 호출. 시작한 브라우저(lo_idv 쿠키)만 쓸 수 있고, 대표자 CI가 맞으면 10분짜리 재설정 권한을 쿠키로 준다.
// 같은 본인확인으로 다시 부르면(응답 유실) 그 권한이 안 쓰였고 만료 전이면 같은 권한을 다시 준다. 쓴 권한·만료는 400 reset_not_allowed.
export const POST = mutation(async (req: Request) => {
  const provider = identityProvider();
  if (!provider) return identityUnavailable("formal");
  const body = await readJson<{ verificationId: string }>(req);
  // 형식이 틀린 id도 다른 거부와 같은 응답(존재 여부 비노출)
  if (!isString(body.verificationId) || !UUID.test(body.verificationId)) {
    return NextResponse.json({ error: "reset_not_allowed" }, { status: 400 });
  }
  const r = await issueSellerPasswordResetGrant(
    prisma,
    provider,
    { verificationId: body.verificationId, ownerToken: readCookie(req, IDV_COOKIE) },
    requestMeta(req),
  );
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "pending" ? 409 : 400 });
  // 시작 쿠키는 성공해도 지우지 않는다. 응답이 잘려 권한 쿠키를 못 받았을 때 같은 본인확인으로 다시 부르면 이 쿠키로 같은 권한을 다시 받는다
  // (발급 뒤 10분, 그 권한을 쓰기 전까지). 쿠키는 시작 때 정한 유효 시간이 지나면 사라진다.
  const res = NextResponse.json({ ok: true });
  setFlowCookie(res, GRANT_COOKIE, r.grantToken, RESET_PATH, 10 * 60);
  return res;
});
