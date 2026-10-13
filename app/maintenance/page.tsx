import type { Metadata } from "next";
import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/public.css";
import { MAINTENANCE_COPY, maintenanceTone } from "../../components/public/maintenanceCopy";
import { RetryButton } from "../../components/public/RetryButton";
import styles from "./Maintenance.module.css";
import { prisma } from "../../lib/server/db";
import { getPublicMaintenance } from "../../lib/server/maintenance/service";

// AU-010 점검 중. 점검 중이면 proxy.ts가 /seller·/shop 주소를 그대로 두고 이 화면을 보여 준다.
// 말투: /seller(파트너스 관리자)에서 오면 proxy가 ?area=partners를 붙여 합니다체, 그 밖(구매자 쇼핑몰·공개)은 해요체(components/public/maintenanceCopy.ts).
export const metadata: Metadata = { title: "점검 중 · ONQ", robots: { index: false } };
export const dynamic = "force-dynamic";

const KST = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false });

export default async function MaintenancePage({ searchParams }: { searchParams: Promise<{ area?: string | string[] }> }) {
  const c = MAINTENANCE_COPY[maintenanceTone((await searchParams).area)];
  // DB를 못 읽어도 화면은 열리고 점검 중으로 보여 준다
  const m = await getPublicMaintenance(prisma).catch(() => null);
  const active = m ? m.active : true;
  return (
    <div className={`app pf ${styles.page}`} data-theme="light">
      <main className={styles.main} data-testid="maintenance">
        <div className={styles.auth}>
          <div className={`logo-sym ${styles.logoMark}`} />
          {active ? (
            <>
              <div className={styles.heading}>
                <h1 className="t-h2">{c.title}</h1>
                {m?.reason && <p className="t-b1">{m.reason}</p>}
                <p className="t-b1" data-testid="maintenance-message">
                  {m?.message || c.fallback}
                </p>
              </div>
              {m?.endsAt && <p className="t-c1 c-alt">{c.ends(KST.format(new Date(m.endsAt)))}</p>}
              <p className="t-c1 c-alt">{c.note}</p>
              <RetryButton />
            </>
          ) : (
            <>
              <div className={styles.heading}>
                <h1 className="t-h2">{c.doneTitle}</h1>
                <p className="t-b1">{c.doneBody}</p>
              </div>
              <a className="btn" href={c.doneHref}>
                {c.doneCta}
              </a>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
