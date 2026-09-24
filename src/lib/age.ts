/**
 * Patient age helpers. Age is always DERIVED from the date of birth, never
 * stored (FINAL_V1_REQUIREMENTS §5). Dates are calendar dates (YYYY-MM-DD).
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(value: string): [number, number, number] | null {
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Completed years between `dateOfBirth` and `today` (both YYYY-MM-DD). A
 * 29 February birthday counts as passed on 1 March in non-leap years.
 * Returns null for a missing/invalid date or a birth date after today.
 */
export function ageOn(dateOfBirth: string | null | undefined, today: string): number | null {
  if (!dateOfBirth) return null;
  const dob = parts(dateOfBirth);
  const now = parts(today);
  if (!dob || !now) return null;
  let age = now[0] - dob[0];
  if (now[1] < dob[1] || (now[1] === dob[1] && now[2] < dob[2])) age -= 1;
  return age < 0 ? null : age;
}

/** Today's calendar date (YYYY-MM-DD) in the given IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
