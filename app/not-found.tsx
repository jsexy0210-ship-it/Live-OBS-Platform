import { NotFoundView } from "../components/public/NotFoundView";

// AU-009 공통 404: 어느 영역에도 속하지 않는 없는 주소
export default function NotFound() {
  return <NotFoundView tone="public" href="/" standalone />;
}
