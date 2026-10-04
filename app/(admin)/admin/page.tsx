import { redirect } from "next/navigation";

// 마스터 관리자 홈을 만들기 전까지는 사이트 설정으로 보낸다
export default function AdminIndex() {
  redirect("/admin/settings/branding");
}
