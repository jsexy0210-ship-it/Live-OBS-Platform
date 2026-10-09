import { redirect } from "next/navigation";

// 오버레이 전용 역할도 단일 홈에서 표시한다. 기존 주소는 보존한다.
export default function OverlayHomeCompatibilityPage() { redirect("/seller"); }
