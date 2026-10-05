import type { Metadata } from "next";
import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/public.css";
import { RetryButton } from "../../components/public/RetryButton";
import { headers } from "next/headers";

// AU-010 점검 중. 점검 중이면 proxy.ts가 /seller·/shop 주소를 그대로 두고 이 화면을 보여 준다.
export const metadata: Metadata = { title: "점검 중 · ONQ", robots: { index: false } };
export const dynamic = "force-dynamic";

const KST = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false });

type Status = { active: boolean; message: string; endsAt: string | null };

// 공개 GET /api/maintenance. 못 읽어도 화면은 열리고 점검 중으로 보여 준다.
async function load(): Promise<Status | null> {
  try {
    const h = await headers();
    const host = h.get("host");
    if (!host) return null;
    const res = await fetch(`${h.get("x-forwarded-proto") ?? "http"}://${host}/api/maintenance`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Status) : null;
  } catch {
    return null;
  }
}

export default async function MaintenancePage() {
  const m = await load();
  const active = m ? m.active : true;
  return (
    <div className="app pf pf-mt" data-theme="light">
      <main className="pf-mt-box" data-testid="maintenance">
        <span className="logo pf-logo">
          <span className="logo-sym" />
          <span className="logo-word" />
        </span>
        {active ? (
          <>
            <h1 className="t-h2">지금은 점검 중이에요</h1>
            <p className="t-b1" data-testid="maintenance-message">
              {m?.message || "더 안정적으로 이용하실 수 있게 서비스를 점검하고 있어요. 잠시 뒤에 다시 이용해 주세요."}
            </p>
            {m?.endsAt && <p className="t-c1 c-alt">{KST.format(new Date(m.endsAt))}에 끝날 예정이에요</p>}
            <p className="t-c1 c-alt">결제가 끝난 주문은 점검이 끝난 뒤 주문 내역에서 확인할 수 있어요</p>
            <RetryButton />
          </>
        ) : (
          <>
            <h1 className="t-h2">점검이 끝났어요</h1>
            <p className="t-b1">이제 다시 이용할 수 있어요.</p>
            <a className="btn" href="/about">
              처음으로
            </a>
          </>
        )}
      </main>
    </div>
  );
}
