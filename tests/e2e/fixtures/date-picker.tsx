import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DatePicker, DateRangePicker, DateTimePicker, TimePicker } from "../../../components/admin-ui/DatePicker";
import { Modal } from "../../../components/admin-ui/Modal";
function Fixture() {
  const [date, setDate] = useState("2026-10-06");
  const [range, setRange] = useState({from:"2026-10-06",to:"2026-10-07"});
  const [dt, setDt] = useState("2026-10-06T10:00");
  const [time, setTime] = useState("10:15");
  const [modal, setModal] = useState(false);
  return <div className="app c24" data-theme="light" style={{padding:32,minHeight:1800}}>
    <div data-testid="clip" style={{transform:"translateZ(0)",overflow:"hidden",height:90}}>
      <DatePicker aria-label="날짜" value={date} onChange={setDate}/>
    </div>
    <output data-testid="date-value">{date}</output>
    <div><DateRangePicker from={range.from} to={range.to} onChange={setRange}/></div>
    <output data-testid="range-value">{JSON.stringify(range)}</output>
    <div><DateTimePicker aria-label="예약" value={dt} onChange={setDt} min="2026-10-06T10:00" max="2026-10-08T18:15"/></div>
    <output data-testid="datetime-value">{dt}</output>
    <div><TimePicker aria-label="단독 시각" value={time} onChange={setTime} min="10:15" max="11:45"/></div>
    <output data-testid="time-value">{time}</output>
    <div><TimePicker aria-label="읽기 전용 시각" value="12:30" onChange={()=>{throw Error("readonly changed");}} readOnly/></div>
    <div><TimePicker aria-label="비활성 시각" value="12:30" onChange={()=>{throw Error("disabled changed");}} disabled/></div>
    <button type="button" onClick={()=>setModal(true)}>모달 열기</button>
    {modal && <Modal labelId="modal-title" onClose={()=>setModal(false)}><h2 id="modal-title">날짜 모달</h2><DatePicker aria-label="모달 날짜" value={date} onChange={setDate}/></Modal>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
