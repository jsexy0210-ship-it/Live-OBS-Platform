import type { Metadata } from "next";
import { Faq } from "../../../components/public/Faq";

export const metadata: Metadata = { title: "자주 묻는 질문 · ONQ", description: "가입, 방송, 방송 화면, 요금, 적립금에 대한 자주 묻는 질문이에요." };

export default function FaqPage() {
  return <Faq />;
}
