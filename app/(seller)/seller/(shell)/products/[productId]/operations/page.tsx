"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ProductOperations } from "../../../../../../../components/seller/ProductOperations";

function ProductOperation() {
  const { productId } = useParams<{ productId: string }>();
  const query = useSearchParams();
  return <ProductOperations key={productId} ids={[productId]} single returnTo={query.get("returnTo")} />;
}

export default function ProductOperationsPage() {
  return <Suspense><ProductOperation /></Suspense>;
}
