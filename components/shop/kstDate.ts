import { formatDate } from "../../lib/client/format";

// 구매자 화면 날짜는 공용 KST 연월일 형식을 쓴다.
export const kstDate = (iso: string | Date) => {
  return formatDate(iso);
};
