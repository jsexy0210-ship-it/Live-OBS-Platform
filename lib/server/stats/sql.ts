import { Prisma, type PrismaClient } from "@prisma/client";
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

export type StatsDb = Prisma.TransactionClient;

// 한 응답의 집계 쿼리를 같은 스냅숏으로 읽는다(REPEATABLE READ·읽기 전용 트랜잭션 하나).
// 따로 읽으면 쿼리 사이에 결제·환불이 커밋될 때 합계와 시계열·결제 수단별이 서로 어긋난다.
export function statsSnapshot<T>(db: PrismaClient, run: (tx: StatsDb) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return run(tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 },
  );
}
