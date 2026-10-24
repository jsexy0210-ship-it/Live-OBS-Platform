"use client";

import { Suspense } from "react";
import { useSearchParams, useParams } from "next/navigation";
import { CategoryOperations } from "../../../../../../../components/seller/CategoryOperations";

function CategoryDetail() {
  const { categoryId } = useParams<{ categoryId: string }>();
  const query = useSearchParams();
  return <CategoryOperations key={categoryId} categoryId={categoryId} returnTo={query.get("returnTo")} />;
}

export default function CategoryDetailPage() { return <Suspense><CategoryDetail /></Suspense>; }
