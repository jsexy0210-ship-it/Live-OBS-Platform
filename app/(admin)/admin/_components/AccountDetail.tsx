"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSmartBack } from "../../../../lib/client/navigation";
import { useRouter } from "next/navigation";
import { PageHead } from "../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../components/seller/States";
import { AccountDialog } from "./AccountDialog";
import { AdminTopbar } from "./AdminShell";
import { adminApi } from "./api";
import { listReturnTo } from "./selection";
import type { AdminAccount } from "./accounts";

export function AccountDetail({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [returnTo, setReturnTo] = useState("/admin/accounts");
  const leaveRef = useRef<((next?: () => void) => Promise<void>) | null>(null);
  const smartBack = useSmartBack(returnTo);
  useEffect(() => setReturnTo(listReturnTo(new URLSearchParams(window.location.search).get("returnTo"), "/admin/accounts")), []);
  const [state, setState] = useState<{ account: AdminAccount | null } | "loading" | "error" | "missing">("loading");
  const load = useCallback(async () => {
    if (accountId === "new") return setState({ account: null });
    setState("loading");
    const r = await adminApi<{ admins: AdminAccount[] }>("/api/admin/admins");
    if (!r.ok) return setState("error");
    const account = r.data.admins.find(a => a.id === accountId);
    setState(account ? { account } : "missing");
  }, [accountId]);
  useEffect(() => { void load(); }, [load]);
  const back = () => router.push(returnTo);
  return <><AdminTopbar crumb="관리자 › 관리자 계정 › 상세" /><main className="main">
    <PageHead onBack={() => leaveRef.current ? leaveRef.current(smartBack) : smartBack()} title={accountId === "new" ? "관리자 계정 추가" : "관리자 계정 상세"} actions={<Link className="btn btn-out" href={returnTo}>목록</Link>} />
    {state === "loading" ? <LoadingRows rows={3} /> : state === "error" || state === "missing" ? <ErrorState title={state === "missing" ? "계정을 찾을 수 없습니다." : "계정을 불러오지 못했습니다."} onRetry={() => void load()} /> : <AccountDialog key={state.account?.id ?? "new"} account={state.account} fullPage leaveRef={leaveRef} onClose={back} onDone={back} />}
  </main></>;
}
