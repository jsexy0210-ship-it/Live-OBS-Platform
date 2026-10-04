import type { Metadata } from "next";
import ComingSoon from "../_lib/ComingSoon";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "고객센터" };

// SH-030 고객센터(공지·이용안내·자주 묻는 질문): 쇼핑몰 공지·FAQ 기능이 생기면 바꾼다.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <ComingSoon slug={(await params).slug} title="고객센터는 준비 중이에요" body="곧 여기에서 공지와 자주 묻는 질문을 볼 수 있어요." />;
}
