import { NextResponse } from "next/server";
import { noStore } from "../http/route";
import { parseStatsRange, type StatsRange } from "./range";

// 통계 API 공통 응답: 기간 해석(잘못되면 400 bad_range) → 집계. 판매자 가드(requireSeller)는 라우트에서 부른다(경로 목록 시험이 확인).
// 쿼리: from·to(KST 날짜 YYYY-MM-DD, 끝 포함, 최대 366일), unit(day·week·month, 기본 day).
export async function statsResponse<T>(req: Request, run: (range: StatsRange) => Promise<T>): Promise<NextResponse> {
  const p = new URL(req.url).searchParams;
  const range = parseStatsRange({ from: p.get("from"), to: p.get("to"), unit: p.get("unit") });
  if (!range) return NextResponse.json({ error: "bad_range" }, { status: 400 });
  return noStore(NextResponse.json(await run(range)));
}
