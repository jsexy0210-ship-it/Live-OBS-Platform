import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ inquiryId: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  return <Workspace key={(await params).inquiryId} inquiryId={(await params).inquiryId} returnTo={(await searchParams).returnTo} />;
}
