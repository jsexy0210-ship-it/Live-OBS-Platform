// 구매자 화면 상태 안내(가입할 수 없을 때 등). 입력 칸 없이 이유와 다음 행동만 보여 준다.
export default function ShopState({ title, body, done = false }: { title: string; body: string; done?: boolean }) {
  return (
    <section className="card shop-card shop-state" role="status">
      <span className={`shop-state-ico${done ? " is-done" : ""}`} aria-hidden />
      <h1 id="shop-state-title" className="t-h1" tabIndex={-1}>
        {title}
      </h1>
      <p className="t-l1 c-alt">{body}</p>
    </section>
  );
}
