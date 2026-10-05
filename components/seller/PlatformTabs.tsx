import Link from "next/link";

// SA-111 공지사항 / SA-113 내 문의 상단 탭. 플랫폼 공지·문의 화면이 함께 쓴다.
export function PlatformTabs({ active }: { active: "notices" | "inquiries" }) {
  return (
    <div className="tabs" role="tablist" style={{ padding: "0 12px" }}>
      <Link className={`tab${active === "notices" ? " on" : ""}`} role="tab" aria-selected={active === "notices"} href="/seller/notices">
        공지사항
      </Link>
      <Link className={`tab${active === "inquiries" ? " on" : ""}`} role="tab" aria-selected={active === "inquiries"} href="/seller/inquiries">
        내 문의
      </Link>
    </div>
  );
}
