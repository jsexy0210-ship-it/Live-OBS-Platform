import { NextResponse } from "next/server";
import { exportSellerActivity } from "../../../../../../lib/server/admin/ops";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 주문·방송 화면 접속 현황 내려받기(MA-042, 모든 마스터 역할). 목록과 같은 조건(period·liveOnly·offOnly·sort), 최대 5,000곳. UTF-8(BOM) CSV.
// 열: 쇼핑몰 이름·주소·상태·주문·결제·결제 금액·주문대기 등록·개봉 완료·취소·취소율·평균 오픈·방송 중·방송 화면 접속·끊김·복구·평균 끊김·마지막 접속(KST). 구매자·직원 정보 없음.
// 응답 헤더 x-truncated: 1이면 5,000곳을 넘어 잘렸다. 내려받은 사실은 로그 추적(admin.ops.activity.export)에 남는다.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await exportSellerActivity(prisma, admin, { period: p.get("period"), liveOnly: p.get("liveOnly") === "1", offOnly: p.get("offOnly") === "1", sort: p.get("sort") }, requestMeta(req));
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason }, { status: 400 }));
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="seller-activity-${day}.csv"`, "x-truncated": r.truncated ? "1" : "0" } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
