"use client";

import { useParams } from "next/navigation";
import { ProductOperations } from "../../../../../../../components/seller/ProductOperations";

export default function ProductOperationsPage() {
  const { productId } = useParams<{ productId: string }>();
  return <ProductOperations key={productId} ids={[productId]} single />;
}
