"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../../components/admin-ui";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { adminApi } from "../../../../_components/api";
import { NoticeForm } from "../../../../_components/NoticeForm";
import type { NoticeTarget } from "../../../../_components/notices";
import { selectedIds } from "../../../../_components/selection";
import { LoadingRows } from "../../../../../../../components/seller/States";

// MA-054 공지 작성(POST /api/admin/platform-notices, 최고관리자·CS). 저장하면 목록으로 돌아간다.
function NoticeNew() {
  const router = useRouter();
  const search = useSearchParams();
  // 파트너스 목록에서 「선택 공지 대상 지정」으로 오면 ids로 대상이 미리 정해진다(보는 곳은 파트너스 기본값).
  const ids = useMemo(() => selectedIds(search.get("ids")), [search]);
  const [targets, setTargets] = useState<NoticeTarget[] | null>(ids ? null : []);
  useEffect(() => {
    if (!ids) return;
    let live = true;
    void Promise.all(ids.map(async (id) => { const r = await adminApi<{ seller: { id: string; shopName: string; slug: string } }>(`/api/admin/sellers/${id}`); return r.ok ? { id, shopName: r.data.seller.shopName, slug: r.data.seller.slug } : null; })).then((rows) => { if (live) setTargets(rows.filter((x): x is NoticeTarget => x !== null)); });
    return () => { live = false; };
  }, [ids]);
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "support.manage");
  return (
    <>
      <AdminTopbar crumb="고객지원 › 공지사항 › 작성" />
      <main className="main">
        <PageHead title="공지 작성" />
        {canEdit && !targets ? (
          <LoadingRows rows={3} />
        ) : canEdit ? (
          <NoticeForm initialTargets={targets?.length ? targets : undefined} onSaved={(_, published) => router.push(`/admin/support/notices?saved=${published ? "published" : "draft"}`)} onStale={() => router.push("/admin/support/notices")} />
        ) : (
          <div className="card">
            <div className="st">
              <span className="t">공지는 최고관리자와 CS 담당만 작성할 수 있습니다.</span>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

export default function NoticeNewPage() {
  return (
    <Suspense fallback={null}>
      <NoticeNew />
    </Suspense>
  );
}
