/** obs-test 전용 호스트 정책. 프록시가 정리한 Host만 사용한다. */
export function allowedRequestHost(
  rawHost: string | null,
  pathname: string,
  method: string,
  allowedHosts: string | undefined,
): boolean {
  const configured = (allowedHosts ?? "").split(",").map((h) => h.trim().toLowerCase());
  // 설정 누락/와일드카드/포트/빈 항목은 fail closed.
  if (configured.some((h) => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(h))) return false;
  if (!rawHost || rawHost !== rawHost.trim()) return false;
  const host = rawHost.toLowerCase();
  // 앱 포트는 외부 비공개다. 루프백의 GET/HEAD 상태 점검만 별도 허용한다.
  if ((method === "GET" || method === "HEAD") &&
      (pathname === "/api/live" || pathname === "/api/health") &&
      (host === "127.0.0.1:3000" || host === "localhost:3000")) return true;
  const parsed = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(80|443))?$/.exec(host);
  return parsed !== null && configured.includes(parsed[1]);
}
