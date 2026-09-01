"use client";

import { useState, useRef, useEffect } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT = MONTH_NAMES;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Size of the year grid (4x4, matching the reference screenshot) and how it
// centers around a given year: e.g. year 2026 -> range 2018-2033 (2026 sits
// at grid position 8, i.e. start of the third row).
const YEAR_GRID_SIZE = 16;
const YEAR_CENTER_OFFSET = 8;

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatDisplay(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

export default function DatePickerField({ value, onChange, max }) {
  const [open, setOpen] = useState(false);
  // view: "days" | "months" | "years" -- clicking the header on any view
  // drills up one level (day header -> month grid -> year grid), and
  // picking a cell on months/years drills back down.
  const [view, setView] = useState("days");
  const [viewDate, setViewDate] = useState(() => (value ? new Date(value) : new Date()));
  const [yearRangeStart, setYearRangeStart] = useState(() => (value ? new Date(value) : new Date()).getFullYear() - YEAR_CENTER_OFFSET);
  const containerRef = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setView("days");
      }
    };
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const maxDate = max ? new Date(max) : null;

  const cells = [];
  for (let i = firstDay - 1; i >= 0; i--) cells.push({ day: daysInPrevMonth - i, current: false, dateObj: new Date(year, month - 1, daysInPrevMonth - i) });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, current: true, dateObj: new Date(year, month, d) });
  while (cells.length % 7 !== 0) {
    const d = cells.length - (firstDay + daysInMonth) + 1;
    cells.push({ day: d, current: false, dateObj: new Date(year, month + 1, d) });
  }

  const selectedStr = value || "";

  const selectDay = (dateObj) => {
    if (maxDate && dateObj > maxDate) return;
    const dateStr = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
    onChange(dateStr);
    setOpen(false);
    setView("days");
  };

  const selectMonth = (m) => {
    setViewDate(new Date(year, m, 1));
    setView("days");
  };

  const selectYear = (y) => {
    setViewDate(new Date(y, month, 1));
    setView("months");
  };

  const openYearsCenteredOn = (y) => {
    setYearRangeStart(y - YEAR_CENTER_OFFSET);
    setView("years");
  };

  const handlePrev = () => {
    if (view === "days") setViewDate(new Date(year, month - 1, 1));
    else if (view === "months") setViewDate(new Date(year - 1, month, 1));
    else setYearRangeStart((s) => s - YEAR_GRID_SIZE);
  };

  const handleNext = () => {
    if (view === "days") setViewDate(new Date(year, month + 1, 1));
    else if (view === "months") setViewDate(new Date(year + 1, month, 1));
    else setYearRangeStart((s) => s + YEAR_GRID_SIZE);
  };

  const yearCells = Array.from({ length: YEAR_GRID_SIZE }, (_, i) => yearRangeStart + i);

  return (
    <div className="relative" ref={containerRef}>
      <div
        className="w-full px-3 py-2.5 rounded text-sm flex items-center justify-between cursor-pointer"
        style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
        onClick={() => { setOpen((v) => !v); setView("days"); }}
      >
        <span style={{ color: value ? "#14213D" : "#9CA0A6" }}>{value ? formatDisplay(value) : "DD/MM/YYYY"}</span>
        <Calendar size={15} color="#6B6F76" />
      </div>

      {open && (
        <div
          className="absolute z-20 mt-1 rounded-md p-3"
          style={{ background: "#FFFFFF", border: "1px solid #D8D5C9", boxShadow: "0 8px 24px rgba(20,33,61,.12)", width: 280 }}
        >
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={handlePrev} className="p-1">
              <ChevronLeft size={16} color="#14213D" />
            </button>

            {view === "days" && (
              <button
                type="button"
                onClick={() => setView("months")}
                className="text-sm"
                style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}
              >
                {MONTH_NAMES[month]}, {year}
              </button>
            )}
            {view === "months" && (
              <button
                type="button"
                onClick={() => openYearsCenteredOn(year)}
                className="text-sm"
                style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}
              >
                {year}
              </button>
            )}
            {view === "years" && (
              <span className="text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                {yearRangeStart}-{yearRangeStart + YEAR_GRID_SIZE - 1}
              </span>
            )}

            <button type="button" onClick={handleNext} className="p-1">
              <ChevronRight size={16} color="#14213D" />
            </button>
          </div>

          {view === "days" && (
            <>
              <div className="grid grid-cols-7 gap-1 mb-1">
                {DAY_NAMES.map((d) => (
                  <div key={d} className="text-center text-[11px]" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Mono', monospace" }}>{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {cells.map((c, i) => {
                  const dateStr = `${c.dateObj.getFullYear()}-${pad(c.dateObj.getMonth() + 1)}-${pad(c.dateObj.getDate())}`;
                  const isSelected = dateStr === selectedStr;
                  const isFuture = maxDate && c.dateObj > maxDate;
                  return (
                    <button
                      type="button"
                      key={i}
                      disabled={isFuture}
                      onClick={() => selectDay(c.dateObj)}
                      className="text-center text-xs py-1.5 rounded"
                      style={{
                        color: isFuture ? "#D8D5C9" : isSelected ? "#FFFFFF" : c.current ? "#14213D" : "#B7BAC0",
                        background: isSelected ? "#14213D" : "transparent",
                        fontFamily: "'IBM Plex Sans', sans-serif",
                        cursor: isFuture ? "not-allowed" : "pointer",
                      }}
                    >
                      {c.day}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {view === "months" && (
            <div className="grid grid-cols-3 gap-2">
              {MONTH_SHORT.map((m, i) => {
                const isSelected = i === month && year === (value ? new Date(value).getFullYear() : null);
                const isFuture = maxDate && (year > maxDate.getFullYear() || (year === maxDate.getFullYear() && i > maxDate.getMonth()));
                return (
                  <button
                    type="button"
                    key={m}
                    disabled={isFuture}
                    onClick={() => selectMonth(i)}
                    className="text-center text-sm py-3 rounded"
                    style={{
                      color: isFuture ? "#D8D5C9" : isSelected ? "#FFFFFF" : "#14213D",
                      background: isSelected ? "#14213D" : "transparent",
                      fontFamily: "'IBM Plex Sans', sans-serif",
                      cursor: isFuture ? "not-allowed" : "pointer",
                    }}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          )}

          {view === "years" && (
            <div className="grid grid-cols-4 gap-2">
              {yearCells.map((y) => {
                const isSelected = y === year;
                const isFuture = maxDate && y > maxDate.getFullYear();
                return (
                  <button
                    type="button"
                    key={y}
                    disabled={isFuture}
                    onClick={() => selectYear(y)}
                    className="text-center text-sm py-3 rounded"
                    style={{
                      color: isFuture ? "#D8D5C9" : isSelected ? "#FFFFFF" : "#14213D",
                      background: isSelected ? "#14213D" : "transparent",
                      fontFamily: "'IBM Plex Sans', sans-serif",
                      cursor: isFuture ? "not-allowed" : "pointer",
                    }}
                  >
                    {y}
                  </button>
                );
              })}
            </div>
          )}

          <button type="button" onClick={() => { onChange(""); setOpen(false); setView("days"); }} className="w-full text-center text-xs mt-2 py-1.5" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
