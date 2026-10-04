// 자동연결 API 경로의 작업 id 검사(모든 경로가 이 함수 하나를 쓴다). 형식이 틀리면 조회하지 않고 404로 돌려준다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isJobId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
