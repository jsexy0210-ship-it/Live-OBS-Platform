// 배송조회: 택배사 조회 페이지 링크(비용 0, 대표님 결정 2026-10-05). 택배사 코드(COURIERS)와 송장번호로 주소를 만든다.
// 주소 형식은 각 택배사 공개 조회 페이지 기준이며 택배사가 바꾸면 여기만 고친다. 모르는 택배사는 링크를 주지 않는다.
const TRACK: Record<string, (no: string) => string> = {
  CJ: (no) => `https://trace.cjlogistics.com/next/tracking.html?wblNo=${no}`,
  HANJIN: (no) => `https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2=${no}`,
  LOTTE: (no) => `https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=${no}`,
  LOGEN: (no) => `https://www.ilogen.com/web/personal/trace/${no}`,
  EPOST: (no) => `https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=${no}`,
};

export function trackingUrl(courier: string, trackingNumber: string): string | null {
  const no = trackingNumber.replace(/[\s-]/g, "");
  return TRACK[courier] && /^\d{6,20}$/.test(no) ? TRACK[courier](no) : null;
}
