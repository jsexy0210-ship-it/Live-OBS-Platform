import type { Metadata } from "next";
import { Features } from "../../../components/public/Features";

export const metadata: Metadata = { title: "기능 안내 · 스트림샵", description: "쇼핑몰, 방송 주문대기, 방송 화면, 적립금, 알림, 도우미를 한 계정으로 써요" };

export default function FeaturesPage() {
  return <Features />;
}
