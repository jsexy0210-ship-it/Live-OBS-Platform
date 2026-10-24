"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { InvoiceOperations } from "../../../../../../../components/seller/InvoiceOperations";

function PrintInvoices() {
  const query = useSearchParams();
  const ids = query.get("ids") ?? "";
  const unprinted = query.get("scope") === "unprinted" && !ids;
  return <InvoiceOperations key={`${unprinted}:${ids}`} ids={ids ? ids.split(",") : []} unprinted={unprinted} initialFormat={query.get("format")} returnTo={query.get("returnTo")} />;
}

export default function PrintInvoicesPage() {
  return <Suspense><PrintInvoices /></Suspense>;
}
