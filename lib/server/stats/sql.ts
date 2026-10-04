import { Prisma } from "@prisma/client";
import type { StatsUnit } from "./range";

// 통계 공통 SQL 조각. 모든 집계는 DB에서 하고(행을 앱으로 읽어 세지 않음), where에는 항상 판매자 id가 들어간다.
// 날짜 경계·묶음 단위는 KST(Asia/Seoul)로 자른다. 주 단위는 월요일 시작(date_trunc week).

export const KST = Prisma.sql`'Asia/Seoul'`;

// 기간 [start, end)을 단위별 KST 묶음 시작 시각으로 펼친다. 결과 열 b(timestamp without time zone, KST 기준).
export function bucketSeries(unit: StatsUnit, start: Date, end: Date) {
  return Prisma.sql`SELECT generate_series(
      date_trunc(${unit}, ${start}::timestamptz AT TIME ZONE ${KST}),
      (${end}::timestamptz - interval '1 millisecond') AT TIME ZONE ${KST},
      ('1 ' || ${unit})::interval
    ) AS b`;
}

// 시각 열을 KST 묶음 시작으로
export const bucketOf = (unit: StatsUnit, col: Prisma.Sql) => Prisma.sql`date_trunc(${unit}, ${col} AT TIME ZONE ${KST})`;

// bigint·numeric 결과를 숫자로(금액 합계는 int 범위를 넘을 수 있어 bigint로 더한다)
export const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
