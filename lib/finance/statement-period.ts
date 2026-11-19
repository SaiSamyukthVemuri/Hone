// HON-64 Slice A period: ONE calendar month in the STUDIO's timezone (the default until Sam decides otherwise).
// PURE. No clock, no timezone lookup: the caller supplies today's studio-local date. The half-open window is
// [startLocal, endLocalExclusive); converting each to an instant is `utcInstantFromLocal(date, "00:00", tz)` at the call site, TWICE,
// never "start + 30 days", because a DST day is 23 or 25 hours.

export type YearMonth = string; // "YYYY-MM"

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isYearMonth(v: string | undefined): v is YearMonth {
  return typeof v === "string" && YM.test(v);
}

export function yearMonthOf(localDate: string): YearMonth {
  return localDate.slice(0, 7);
}

export function shiftYearMonth(ym: YearMonth, delta: number): YearMonth {
  const m = YM.exec(ym);
  if (!m) throw new Error("not a YYYY-MM");
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const y = Math.floor(idx / 12);
  const mo = (idx % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`;
}

export function monthRange(ym: YearMonth): { startLocal: string; endLocalExclusive: string; label: string } {
  if (!isYearMonth(ym)) throw new Error("not a YYYY-MM");
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return {
    startLocal: `${ym}-01`,
    endLocalExclusive: `${shiftYearMonth(ym, 1)}-01`,
    label: `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`,
  };
}
