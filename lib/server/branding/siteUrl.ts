// 공유 메타(og:image 등)의 절대 주소를 만들 기준 주소. 사이트 기본 주소 환경변수는 대표님 결정 대기라 요청 주소로 만든다.
// X-Forwarded-Host·Proto는 신뢰 프록시(TRUSTED_PROXY_HOPS > 0, http/route.ts와 같은 기준)일 때만 믿는다.
// 호스트 모양이 이상하면(주입 시도 등) null을 돌려주고, 부르는 쪽은 절대 주소가 필요한 값(og:image)을 빼고 내보낸다.
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/i;

function trustedProxy(): boolean {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? "0");
  return Number.isInteger(n) && n > 0;
}

type HeaderReader = { get(name: string): string | null };

export function requestOrigin(h: HeaderReader): URL | null {
  const proxy = trustedProxy();
  // 여러 프록시를 거치면 쉼표로 이어진다: 맨 앞(처음 받은 프록시가 적은 값)을 쓴다
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  const host = (proxy ? first(h.get("x-forwarded-host")) : null) ?? h.get("host");
  if (!host || host.length > 255 || !HOST.test(host)) return null;
  const fwdProto = proxy ? first(h.get("x-forwarded-proto")) : null;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const proto = fwdProto === "http" || fwdProto === "https" ? fwdProto : local ? "http" : process.env.NODE_ENV === "production" ? "https" : "http";
  // 포트가 범위 밖(예: :99999)이면 URL을 만들 수 없다: 이상한 호스트와 같이 null
  try {
    return new URL(`${proto}://${host.toLowerCase()}`);
  } catch {
    return null;
  }
}

// 카드 안에는 공인 플랫폼 주소만 쓴다. 프록시 헤더가 없거나 잘못되어 내부 서비스 주소로 떨어지면 비워 둔다.
export function requestCardSite(h: HeaderReader): string {
  if (trustedProxy() && !h.get("x-forwarded-host")) return "";
  const origin = requestOrigin(h);
  if (!origin) return "";
  const host = origin.hostname.toLowerCase();
  if (
    !host.includes(".") ||
    host === "0.0.0.0" ||
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) return "";
  return origin.host;
}
