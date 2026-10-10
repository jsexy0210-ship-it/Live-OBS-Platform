import { brandingMetadata } from "../../lib/server/branding/metadata";

// 소개와 같은 공개 화면·가입 단계에 플랫폼 소개의 파비콘·공유 카드를 사용한다.
// 각 페이지가 정한 제목·설명은 Next 메타데이터 병합으로 유지한다.
export const generateMetadata = () => brandingMetadata("landing");

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return children;
}
