import { NotFoundView } from "../../components/public/NotFoundView";

// AU-009 마스터 관리자 404(합니다체)
export default function AdminNotFound() {
  return <NotFoundView tone="admin" href="/admin" />;
}
