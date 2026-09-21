type Props = {
  active: boolean;
  text?: string;
};

export function InputNotice({ active, text = "입력값 자동 보정" }: Props) {
  if (!active) return null;
  return <p className="inputNotice">{text}</p>;
}
