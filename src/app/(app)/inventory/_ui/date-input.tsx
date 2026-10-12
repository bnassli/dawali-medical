"use client";

import { parseDayMonthYear } from "@/lib/day-month-year";

/**
 * Dates in the inventory screens are typed day/month/year (dd/mm/yyyy), as on
 * the paper invoices and boxes — the browser's date picker shows the US order.
 * The value is the typed text; callers convert it with parseDayMonthYear.
 */
export function DateInput({ value, onChange, label }: { value: string; onChange: (text: string) => void; label: string }) {
  const invalid = parseDayMonthYear(value) === null;
  return (
    <input
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={invalid ? "invalid" : undefined}
      dir="ltr"
      inputMode="numeric"
      placeholder="dd/mm/yyyy"
      size={10}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
