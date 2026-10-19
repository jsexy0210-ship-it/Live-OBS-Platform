"use client";

import { useParams } from "next/navigation";
import { ShippingOperations } from "../../../../../../components/seller/ShippingOperations";

export default function ShipmentPage() {
  const { orderId } = useParams<{ orderId: string }>();
  return <ShippingOperations key={orderId} ids={[orderId]} single />;
}
