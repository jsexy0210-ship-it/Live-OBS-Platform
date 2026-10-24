"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ReceiptOperations } from "../../../../../../../components/seller/ReceiptOperations";

function ReceiptDetail() {
  const { requestId } = useParams<{ requestId: string }>();
  const query = useSearchParams();
  return <ReceiptOperations key={requestId} ids={[requestId]} single returnTo={query.get("returnTo")} />;
}

export default function ReceiptDetailPage() { return <Suspense><ReceiptDetail /></Suspense>; }
