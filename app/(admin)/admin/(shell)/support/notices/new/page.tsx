"use client";

import { useRouter } from "next/navigation";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../../components/admin-ui";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { NoticeForm } from "../../../../_components/NoticeForm";

// MA-054 공지 작성(POST /api/admin/platform-notices, 최고관리자·CS). 저장하면 목록으로 돌아간다.
export default function NoticeNewPage() {
  const router = useRouter();
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "support.manage");
  return (
    <>
      <AdminTopbar crumb="고객지원 › 공지사항 › 작성" />
      <main className="main">
        <PageHead title="공지 작성" />
        {canEdit ? (
          <NoticeForm onSaved={(_, published) => router.push(`/admin/support/notices?saved=${published ? "published" : "draft"}`)} onStale={() => router.push("/admin/support/notices")} />
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
