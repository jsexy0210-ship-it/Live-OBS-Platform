"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { ROLE_LABEL } from "../../../_components/accounts";
import { ACTOR_LABEL, actionLabel, asRecord, keyLabel, targetLabel, valueText, type AuditDetail } from "../../../_components/auditLogs";
import { dayTime } from "../../../_components/partners";

// MA-071 로그 추적 상세(GET /api/admin/audit-logs/{id}, 최고관리자·운영·조회 전용, 조회만): 기록 정보와 바뀐 값(바꾸기 전·후).
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; log: AuditDetail };

function Changes({ before, after }: { before: unknown; after: unknown }) {
  const b = asRecord(before);
  const a = asRecord(after);
  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])];
  if (keys.length === 0) return <span className="c-alt">기록된 바뀐 값이 없습니다.</span>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tbl" data-testid="audit-changes" style={{ whiteSpace: "normal" }}>
        <thead>
          <tr>
            <th>항목</th>
            <th>바꾸기 전</th>
            <th>바꾼 뒤</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <td className="fw6">{keyLabel(k)}</td>
              <td>{valueText(k, b?.[k])}</td>
              <td>{valueText(k, a?.[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AuditDetailPage() {
  const { logId } = useParams<{ logId: string }>();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ log: AuditDetail }>(`/api/admin/audit-logs/${encodeURIComponent(logId)}`);
    setState(r.ok ? { kind: "ok", log: r.data.log } : { kind: "error", status: r.status });
  }, [logId]);
  useEffect(() => void load(), [load]);

  const l = state.kind === "ok" ? state.log : null;
  const actor = l ? (l.actorAdmin ? `${l.actorAdmin.name} (${l.actorAdmin.email}) · ${ROLE_LABEL[l.actorAdmin.role]}` : ACTOR_LABEL[l.actorType]) : "";
  const rows: [string, React.ReactNode][] = l
    ? [
        ["종류", actionLabel(l.action)],
        ["기록 시각", dayTime(l.createdAt)],
        ["행위자", actor],
        ["대상", targetLabel(l.targetType)],
        ["쇼핑몰", l.seller ? <Link key="s" href={`/admin/partners/${l.seller.id}`}>{l.seller.shopName}</Link> : "-"],
        ["사유", l.reason ?? "-"],
        ["접속 주소", l.ip ?? "-"],
        ["브라우저", l.userAgent ?? "-"],
      ]
    : [];

  return (
    <>
      <AdminTopbar crumb="관리자 › 로그 추적 › 로그 상세" />
      <main className="main">
        <PageHead
          title={l ? actionLabel(l.action) : "로그 상세"}
          actions={
            <Link className="btn btn-out" href="/admin/logs">
              로그 추적
            </Link>
          }
        />
        {!l ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 404 ? (
                <div className="st">
                  <span className="t">기록을 찾을 수 없습니다.</span>
                </div>
              ) : (
                <ErrorState title="기록을 불러오지 못했습니다." onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="log-basic">
              <h2 className="t-hl1" id="log-basic">
                기록 정보
              </h2>
              <dl className="kv">
                {rows.map(([k, v]) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="log-changes">
              <h2 className="t-hl1" id="log-changes">
                바뀐 값
              </h2>
              <Changes before={l.before} after={l.after} />
            </section>
          </div>
        )}
      </main>
    </>
  );
}
