"use client";
import { useParams } from "next/navigation";
import { VendorsWorkspace } from "../../../../_components/VendorsWorkspace";
export default function VendorPage() { const { vendorId } = useParams<{ vendorId: string }>(); return <VendorsWorkspace vendorId={vendorId} />; }
