"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ProductOperations } from "../../../../../../components/seller/ProductOperations";

function SelectedProducts() {
  const query = useSearchParams();
  const ids = query.get("ids") ?? "";
  return <ProductOperations key={ids} ids={ids ? ids.split(",") : []} returnTo={query.get("returnTo")} />;
}

export default function SelectedProductOperationsPage() {
  return <Suspense><SelectedProducts /></Suspense>;
}
