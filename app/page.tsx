import { redirect } from "next/navigation";

// 첫 화면은 로그인이다(대표님 지시 2026-10-04). 이미 로그인한 경우는 /seller/login의 기존 동작을 따른다
export default function HomePage() {
  redirect("/seller/login");
}
