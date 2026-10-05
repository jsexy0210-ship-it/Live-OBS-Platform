"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { day, reasonLabel, text, type ReviewRow } from "../../../_components/partners";

// MA-013 가입 신청 목록(GET /api/admin/sellers/review, 모든 마스터 역할): 승인 대기 쇼핑몰을 오래된 순으로 보여 준다.
// 승인·반려는 상세(MA-014)에서 한다. 주소가 파트너스 상세 [sellerId]로 잡히지 않게 이 폴더에 따로 둔다.
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: ReviewRow[] };

export default function PartnerApplications() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ sellers: ReviewRow[] }>("/api/admin/sellers/review");
    setState(r.ok ? { kind: "ok", items: r.data.sellers } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <>
      <AdminTopbar crumb="파트너스 › 가입 신청" />
      <main className="main">
        <PageHead title="가입 신청" />
        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="가입 신청을 불러오지 못했습니다." onRetry={() => void load()} />}
          {state.kind === "ok" &&
            (state.items.length === 0 ? (
              <div className="st">
                <span className="t">확인할 가입 신청이 없습니다.</span>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                  <thead>
                    <tr>
                      <th>쇼핑몰</th>
                      <th>상호</th>
                      <th>사업자등록번호</th>
                      <th>확인 필요 항목</th>
                      <th>신청일</th>
                      <th>작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.items.map((s) => (
                      <tr key={s.id} data-testid="application-row">
                        <td>
                          <Link className="fw6" href={`/admin/partners/applications/${s.id}`}>
                            {s.shopName}
                          </Link>
                          <span className="c-alt"> · {s.slug}</span>
                        </td>
                        <td>{text(s.businessInfo?.companyName)}</td>
                        <td className="num">{text(s.businessInfo?.businessNumber)}</td>
                        <td>
                          {s.reviewReasons.length === 0 ? (
                            "-"
                          ) : (
                            <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                              {s.reviewReasons.map((c) => (
                                <span key={c} className="bdg b-warn">
                                  {reasonLabel(c)}
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                        <td className="num">{day(s.createdAt)}</td>
                        <td>
                          <Link className="btn btn-sm btn-out" href={`/admin/partners/applications/${s.id}`}>
                            검토
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </div>
      </main>
    </>
  );
}
