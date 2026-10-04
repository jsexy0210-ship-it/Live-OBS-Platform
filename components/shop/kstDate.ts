// KST 월/일(서버가 주는 UTC ISO 시각을 한국 날짜로). 서버·클라이언트 화면이 함께 쓴다.
export const kstDate = (iso: string | Date) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
