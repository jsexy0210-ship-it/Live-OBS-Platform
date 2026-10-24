"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CategoryOperations } from "../../../../../../../components/seller/CategoryOperations";

function CategoryDetail() {
  const query = useSearchParams();
  return <CategoryOperations parentId={query.get("parentId")} returnTo={query.get("returnTo")} />;
}

export default function CategoryDetailPage() { return <Suspense><CategoryDetail /></Suspense>; }
