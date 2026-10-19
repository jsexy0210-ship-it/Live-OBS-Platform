"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { InvoiceOperations } from "../../../../../../../components/seller/InvoiceOperations";

function Invoice() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const query = useSearchParams();
  return <InvoiceOperations key={invoiceId} ids={[invoiceId]} single returnTo={query.get("returnTo")} />;
}

export default function InvoicePage() {
  return <Suspense><Invoice /></Suspense>;
}
