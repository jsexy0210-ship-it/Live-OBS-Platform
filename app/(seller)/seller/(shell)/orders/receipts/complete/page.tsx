"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ReceiptOperations } from "../../../../../../../components/seller/ReceiptOperations";

function SelectedReceipts() {
  const query = useSearchParams();
  const ids = query.get("ids") ?? "";
  return <ReceiptOperations key={ids} ids={ids ? ids.split(",") : []} returnTo={query.get("returnTo")} />;
}

export default function CompleteReceiptsPage() {
  return <Suspense><SelectedReceipts /></Suspense>;
}
