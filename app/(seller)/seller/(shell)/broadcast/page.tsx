import { redirect } from "next/navigation";

// 단일 홈으로 이동하는 기존 주소 호환. 권한은 /seller와 기존 API에서 판단한다.
export default function BroadcastCompatibilityPage() { redirect("/seller"); }
