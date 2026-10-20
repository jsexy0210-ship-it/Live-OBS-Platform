import { StaffProvider } from "./Workspace";
export default function Layout({ children }: { children: React.ReactNode }) { return <StaffProvider>{children}</StaffProvider>; }
