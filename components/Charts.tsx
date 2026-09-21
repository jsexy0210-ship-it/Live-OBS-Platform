"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

const tooltipStyle = {
  background: "#111",
  border: "1px solid #383838",
  borderRadius: 0,
  color: "#fff"
};

export function DepletionDonut({ used, remaining }: { used: number; remaining: number }) {
  const data = [
    { name: "소모", value: used },
    { name: "잔량", value: remaining }
  ];

  return (
    <div className="chartFrame">
      <div className="chartHeader">
        <span>소모 비율</span>
        <strong>{Math.round(used)}%</strong>
      </div>
      <div className="chartBox chartBoxSmall">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="92%" strokeWidth={0}>
              <Cell fill="#ff3b30" />
              <Cell fill="#2b2b2b" />
            </Pie>
            <Tooltip contentStyle={tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function BurnLine() {
  const data = [
    { year: "현재", value: 100 },
    { year: "1년", value: 82 },
    { year: "2년", value: 64 },
    { year: "3년", value: 45 },
    { year: "4년", value: 27 },
    { year: "5년", value: 9 }
  ];

  return (
    <div className="chartFrame">
      <div className="chartHeader">
        <span>잔량 추이</span>
        <strong>예시 데이터</strong>
      </div>
      <div className="chartBox">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <CartesianGrid stroke="#222" vertical={false} />
            <XAxis dataKey="year" stroke="#777" tickLine={false} axisLine={false} />
            <YAxis hide domain={[0, 100]} />
            <Tooltip contentStyle={tooltipStyle} />
            <Area type="monotone" dataKey="value" stroke="#ff3b30" fill="#ff3b30" fillOpacity={0.16} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function SpendBars() {
  const data = [
    { name: "OTT", value: 49000 },
    { name: "AI", value: 45000 },
    { name: "음악", value: 11900 },
    { name: "저장공간", value: 5900 }
  ];

  return (
    <div className="chartFrame">
      <div className="chartHeader">
        <span>월 정기지출</span>
        <strong>예시 데이터</strong>
      </div>
      <div className="chartBox">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical">
            <CartesianGrid stroke="#222" horizontal={false} />
            <XAxis type="number" hide />
            <YAxis dataKey="name" type="category" stroke="#aaa" tickLine={false} axisLine={false} width={64} />
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${Number(value).toLocaleString()}원`, "월 비용"]} />
            <Bar dataKey="value" fill="#f3f3f3" radius={0} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function LifeGrid({ used = 37, title = "Life Grid" }: { used?: number; title?: string }) {
  const count = 100;
  const usedCount = Math.round(Math.max(0, Math.min(100, used)));

  return (
    <div className="chartFrame">
      <div className="chartHeader">
        <span>{title}</span>
        <strong>소모 {usedCount}%</strong>
      </div>
      <div className="lifeGrid" aria-label={`소모 ${usedCount}%`}>
        {Array.from({ length: count }, (_, index) => (
          <span key={index} className={index < usedCount ? "lifeCell lifeCellUsed" : "lifeCell"} />
        ))}
      </div>
    </div>
  );
}

export function CashRunwayChart({
  cash,
  monthlyBurn,
  months
}: {
  cash: number;
  monthlyBurn: number;
  months: number;
}) {
  const length = Number.isFinite(months) ? Math.min(24, Math.max(1, Math.ceil(months))) : 12;
  const data = Array.from({ length: length + 1 }, (_, month) => ({
    month: `${month}개월`,
    value: Math.max(0, cash - monthlyBurn * month)
  }));

  return (
    <div className="chartFrame">
      <div className="chartHeader">
        <span>현금 잔량 추이</span>
        <strong>{Number.isFinite(months) ? `${months.toFixed(1)}개월` : "유지"}</strong>
      </div>
      <div className="chartBox">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <CartesianGrid stroke="#222" vertical={false} />
            <XAxis dataKey="month" stroke="#777" tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis hide />
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${Number(value).toLocaleString()}원`, "현금"]} />
            <Area type="monotone" dataKey="value" stroke="#ff3b30" fill="#ff3b30" fillOpacity={0.16} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function CommuteTimelineChart({
  currentAge,
  retirementAge,
  remainingCommutes
}: {
  currentAge: number;
  retirementAge: number;
  remainingCommutes: number;
}) {
  const span = Math.max(1, retirementAge - currentAge);
  const pointCount = Math.min(6, Math.max(2, Math.ceil(span / 3) + 1));
  const data = Array.from({ length: pointCount }, (_, index) => {
    const ratio = index / (pointCount - 1);
    const age = Math.round(currentAge + span * ratio);
    return { age: `${age}세`, value: Math.max(0, Math.round(remainingCommutes * (1 - ratio))) };
  });

  return (
    <div className="chartFrame">
      <div className="chartHeader">
        <span>출근 잔량 추이</span>
        <strong>{retirementAge}세 종료 기준</strong>
      </div>
      <div className="chartBox">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <CartesianGrid stroke="#222" vertical={false} />
            <XAxis dataKey="age" stroke="#777" tickLine={false} axisLine={false} />
            <YAxis hide />
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${Number(value).toLocaleString()}회`, "남은 출근"]} />
            <Area type="monotone" dataKey="value" stroke="#ff3b30" fill="#ff3b30" fillOpacity={0.14} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function SalaryCumulativeChart({
  currentAge,
  retirementAge,
  monthlySalary
}: {
  currentAge: number;
  retirementAge: number;
  monthlySalary: number;
}) {
  const span = Math.max(1, retirementAge - currentAge);
  const pointCount = Math.min(7, Math.max(3, Math.ceil(span / 4) + 1));
  const data = Array.from({ length: pointCount }, (_, index) => {
    const ratio = index / (pointCount - 1);
    const age = Math.round(currentAge + span * ratio);
    const months = Math.round(span * 12 * ratio);
    return { age: `${age}세`, value: Math.max(0, monthlySalary * months) };
  });

  return (
    <div className="chartFrame">
      <div className="chartHeader">
        <span>급여 누적 예상</span>
        <strong>현재 월급 유지</strong>
      </div>
      <div className="chartBox">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid stroke="#222" vertical={false} />
            <XAxis dataKey="age" stroke="#777" tickLine={false} axisLine={false} />
            <YAxis hide />
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${Number(value).toLocaleString()}원`, "누적 급여"]} />
            <Line type="monotone" dataKey="value" stroke="#f3f3f3" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function WorkTimeMixChart({
  workHours,
  commuteHours
}: {
  workHours: number;
  commuteHours: number;
}) {
  const data = [
    { name: "근무", value: Math.max(0, workHours) },
    { name: "출퇴근", value: Math.max(0, commuteHours) }
  ];

  return (
    <div className="chartFrame">
      <div className="chartHeader">
        <span>시간 구성</span>
        <strong>{Math.round(workHours + commuteHours).toLocaleString()}시간</strong>
      </div>
      <div className="chartBox chartBoxSmall">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="52%" outerRadius="92%" strokeWidth={0}>
              <Cell fill="#f3f3f3" />
              <Cell fill="#ff3b30" />
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${Math.round(Number(value)).toLocaleString()}시간`, "누적"]} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function WorkYearBars({
  yearsElapsed,
  annualWorkHours,
  annualCommuteHours
}: {
  yearsElapsed: number;
  annualWorkHours: number;
  annualCommuteHours: number;
}) {
  const visibleYears = Math.min(6, Math.max(1, Math.ceil(yearsElapsed)));
  const data = Array.from({ length: visibleYears }, (_, index) => ({
    year: `${index + 1}년차`,
    work: annualWorkHours,
    commute: annualCommuteHours
  }));

  return (
    <div className="chartFrame">
      <div className="chartHeader">
        <span>연간 시간 구성</span>
        <strong>현재 입력 기준</strong>
      </div>
      <div className="chartBox">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid stroke="#222" vertical={false} />
            <XAxis dataKey="year" stroke="#777" tickLine={false} axisLine={false} />
            <YAxis hide />
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${Math.round(Number(value)).toLocaleString()}시간`, "연간"]} />
            <Bar dataKey="work" stackId="time" fill="#f3f3f3" />
            <Bar dataKey="commute" stackId="time" fill="#ff3b30" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
