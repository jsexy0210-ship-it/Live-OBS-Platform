"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CategoryOperations } from "../../../../../../../components/seller/CategoryOperations";

function CategoryDetail() {
  const query = useSearchParams();
  return <CategoryOperations order returnTo={query.get("returnTo")} />;
}

export default function CategoryDetailPage() { return <Suspense><CategoryDetail /></Suspense>; }
