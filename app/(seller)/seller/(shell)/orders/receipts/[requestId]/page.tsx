"use client";

import { useParams } from "next/navigation";
import { ReceiptOperations } from "../../../../../../../components/seller/ReceiptOperations";

export default function ReceiptDetailPage() {
  const { requestId } = useParams<{ requestId: string }>();
  return <ReceiptOperations key={requestId} ids={[requestId]} single />;
}
