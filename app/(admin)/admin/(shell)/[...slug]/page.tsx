import { notFound } from "next/navigation";
import { ComingSoon } from "../../_components/AdminShell";
import { ADMIN_MENU } from "../../_components/menu";

// 메뉴에는 있지만 화면이 아직 없는 주소만 「준비 중」 안내로 받는다(메뉴에 없는 주소는 404)
export default async function AdminPlaceholder({ params }: { params: Promise<{ slug: string[] }> }) {
  const href = `/admin/${(await params).slug.join("/")}`;
  if (!ADMIN_MENU.some((g) => g.items.some((n) => n.href === href && !n.ready))) notFound();
  return <ComingSoon />;
}
