"use client";
import { useParams } from "next/navigation";
import { AccountDetail } from "../../../_components/AccountDetail";
export default function AccountPage() { const { adminId } = useParams<{ adminId: string }>(); return <AccountDetail accountId={adminId} />; }
