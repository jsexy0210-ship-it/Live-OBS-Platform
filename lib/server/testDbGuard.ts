// 통합 테스트가 운영·개발 DB를 건드리지 않게 막는다. DB 이름이 _test로 끝나야만 통과한다.
export function assertTestDatabaseUrl(url: string | undefined): string {
  if (!url) throw new Error("DATABASE_URL이 없어요. 폐기 가능한 테스트 DB 주소를 넣어 주세요.");
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL 형식이 올바르지 않아요.");
  }
  if (!dbName.endsWith("_test")) {
    throw new Error(`테스트 DB가 아니에요(DB 이름: ${dbName}). 이름이 _test로 끝나는 DB에서만 통합 테스트를 실행해요.`);
  }
  return url;
}
