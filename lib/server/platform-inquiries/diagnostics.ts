import type { PrismaClient } from "@prisma/client";

// 문의에 함께 보내는 진단 정보(SA-114 「함께 보낼 진단 정보 (자동)」 → MA-052 「진단 정보」). 문의를 보낸 시점에 한 번 모아 문의에 붙여 둔다(그 뒤 바뀌어도 그대로).
// 이미 있는 값만 쓰고 새 수집기는 만들지 않는다. 확인할 수 없는 값은 null이고 화면은 「확인 안 됨」으로 보인다.
// - 브라우저·OS: 문의를 보낸 요청의 User-Agent에서 읽는다. OBS 브라우저 소스면 User-Agent의 OBS/버전을 obsVersion으로 뽑는다.
// - 쇼핑몰: sellerId. 최근 방송: 가장 최근에 시작한 방송(id·상태·시작·종료).
// - 오버레이 마지막 접속 시각: 쓰고 있는 오버레이 주소(폐기 안 된 것) 중 가장 최근 lastSeenAt. 그 접속의 User-Agent는 저장하지 않아 overlay.userAgent·overlay.obsVersion은 null.
// - 앱 버전: 배포한 커밋(APP_VERSION). 결제대행사 응답 코드·접속 기록은 모아 둔 곳이 없어 넣지 않는다.

export type InquiryDiagnostics = {
  collectedAt: string;
  sellerId: string;
  browser: { name: string; version: string | null } | null;
  os: { name: string; version: string | null } | null;
  obsVersion: string | null;
  userAgent: string | null;
  latestBroadcast: { id: string; status: string; startedAt: string; endedAt: string | null } | null;
  overlay: { lastSeenAt: string | null; userAgent: string | null; obsVersion: string | null };
  appVersion: string | null;
};

const major = (v: string | undefined) => (v ? v.split(".")[0] : null);

// 가볍게 읽는다(라이브러리 없이). 모르는 건 null.
export function parseUserAgent(ua: string | null | undefined): { browser: InquiryDiagnostics["browser"]; os: InquiryDiagnostics["os"]; obsVersion: string | null } {
  if (!ua) return { browser: null, os: null, obsVersion: null };
  const obs = /\bOBS\/([\d.]+)/i.exec(ua)?.[1] ?? null;
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(ua);
    return m ? { name, version: major(m[1]) } : null;
  };
  const browser =
    pick(/\bEdg(?:e|A|iOS)?\/([\d.]+)/, "Edge") ??
    pick(/\bSamsungBrowser\/([\d.]+)/, "Samsung Internet") ??
    pick(/\b(?:Firefox|FxiOS)\/([\d.]+)/, "Firefox") ??
    pick(/\b(?:Chrome|CriOS)\/([\d.]+)/, obs ? "OBS 브라우저" : "Chrome") ??
    (/\bSafari\//.test(ua) ? { name: "Safari", version: major(/\bVersion\/([\d.]+)/.exec(ua)?.[1]) } : null);
  let os: InquiryDiagnostics["os"] = null;
  if (/\bWindows NT ([\d.]+)/.test(ua)) {
    const nt = /\bWindows NT ([\d.]+)/.exec(ua)![1];
    os = { name: "Windows", version: nt === "10.0" ? "10/11" : nt };
  } else if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) os = { name: "iOS", version: /OS (\d+)[_\d]*/.exec(ua)?.[1] ?? null };
  else if (/\bAndroid ([\d.]+)/.test(ua)) os = { name: "Android", version: major(/\bAndroid ([\d.]+)/.exec(ua)?.[1]) };
  else if (/\bMac OS X ([\d_.]+)/.test(ua)) os = { name: "macOS", version: /\bMac OS X (\d+)/.exec(ua)?.[1] ?? null };
  else if (/\bCrOS\b/.test(ua)) os = { name: "ChromeOS", version: null };
  else if (/\bLinux\b/.test(ua)) os = { name: "Linux", version: null };
  return { browser, os, obsVersion: obs };
}

export async function collectInquiryDiagnostics(db: PrismaClient, sellerId: string, userAgent: string | null | undefined, now = new Date()): Promise<InquiryDiagnostics> {
  const [broadcast, overlay] = await Promise.all([
    db.broadcastSession.findFirst({ where: { sellerId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true, status: true, startedAt: true, endedAt: true } }),
    db.overlayToken.aggregate({ where: { sellerId, revokedAt: null }, _max: { lastSeenAt: true } }),
  ]);
  const ua = userAgent ? userAgent.slice(0, 300) : null;
  const parsed = parseUserAgent(ua);
  return {
    collectedAt: now.toISOString(),
    sellerId,
    ...parsed,
    userAgent: ua,
    latestBroadcast: broadcast ? { id: broadcast.id, status: broadcast.status, startedAt: broadcast.startedAt.toISOString(), endedAt: broadcast.endedAt?.toISOString() ?? null } : null,
    overlay: { lastSeenAt: overlay._max.lastSeenAt?.toISOString() ?? null, userAgent: null, obsVersion: null },
    appVersion: process.env.APP_VERSION || null,
  };
}
