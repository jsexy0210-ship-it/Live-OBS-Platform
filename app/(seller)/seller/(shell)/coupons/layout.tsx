import { CouponsSelectionProvider } from "./Workspace";
export default function Layout({ children }: { children: React.ReactNode }) { return <CouponsSelectionProvider>{children}</CouponsSelectionProvider>; }
