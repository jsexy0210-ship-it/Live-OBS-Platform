"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../../components/seller/States";
import { adminApi } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { listReturnTo } from "../../../../_components/selection";
import { NoticeDeleteDialog } from "../../../../_components/NoticeDeleteDialog";
import { NoticeForm } from "../../../../_components/NoticeForm";
import type { Notice } from "../../../../_components/notices";

// MA-054 공지 수정(GET·PUT /api/admin/platform-notices/{id}). 다른 곳에서 먼저 고쳤으면(409) 목록으로 보낸다.
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; notice: Notice };

export default function NoticeEditPage() {
  const { noticeId } = useParams<{ noticeId: string }>();
  const router = useRouter();
  const [returnTo, setReturnTo] = useState("/admin/support/notices");
  useEffect(() => setReturnTo(listReturnTo(new URLSearchParams(window.location.search).get("returnTo"), "/admin/support/notices")), []);
  const resultPath = (key: string, value: string) => { const u = new URL(returnTo, "https://admin.invalid"); u.searchParams.set(key, value); return `${u.pathname}${u.search}`; };
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "support.manage");
  const [deleting, setDeleting] = useState(false);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ notice: Notice }>(`/api/admin/platform-notices/${encodeURIComponent(noticeId)}`);
    setState(r.ok ? { kind: "ok", notice: r.data.notice } : { kind: "error", status: r.status });
  }, [noticeId]);
  useEffect(() => void load(), [load]);

  return (
    <>
      <AdminTopbar crumb="고객지원 › 공지사항 › 수정" />
      <main className="main">
        <PageHead title="공지 수정" />
        {!canEdit ? (
          <div className="card">
            <div className="st">
              <span className="t">공지는 최고관리자와 CS 담당만 수정할 수 있습니다.</span>
            </div>
          </div>
        ) : state.kind === "loading" ? (
          <div className="card">
            <LoadingRows rows={4} />
          </div>
        ) : state.kind === "error" ? (
          <div className="card">
            {state.status === 404 ? (
              <div className="st">
                <span className="t">공지를 찾을 수 없습니다.</span>
              </div>
            ) : (
              <ErrorState title="공지를 불러오지 못했습니다." onRetry={() => void load()} />
            )}
          </div>
        ) : (
          <>
          <NoticeForm
            notice={state.notice}
            onSaved={(_, published) => router.push(resultPath("saved", published ? "published" : "draft"))}
            onStale={() => router.push(resultPath("stale", "1"))}
          />
          <button className="btn btn-out" style={{ alignSelf: "flex-start" }} onClick={() => setDeleting(true)}>삭제</button>
          </>
        )}
      </main>
      {deleting && canEdit && state.kind === "ok" && <NoticeDeleteDialog notice={state.notice} onClose={() => setDeleting(false)} onDone={() => router.push(resultPath("saved", "deleted"))} onStale={() => router.push(resultPath("stale", "1"))} />}
    </>
  );
}
