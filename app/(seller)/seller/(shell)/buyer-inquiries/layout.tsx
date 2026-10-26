import { InquiryPageProvider } from "./Workspace";
export default function Layout({ children }: { children: React.ReactNode }) { return <InquiryPageProvider>{children}</InquiryPageProvider>; }
